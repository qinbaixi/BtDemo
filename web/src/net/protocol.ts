// 二进制 protobuf（proto2）协议。
// pb.js / pb.d.ts 由 `npm run proto` 从 proto/btdemo.proto 生成（和服务端同一份 .proto），
// 字段改名或删掉时 tsc 会直接报错。
// decode() 把 ServerMsg 转成 types.ts 里的普通对象；encode() 组装 ClientMsg。
// 其余代码只用 types.ts，不直接碰 protobuf。

import { btdemo } from './pb';
import type {
  AiTrace, ClassInfo, AiTreeDef, AiTreeNode, ClientMessage, EntityInfo, GameEvent, ItemInfo, ItemSlotted, Obstacle, PetInfo, SelfInfo,
  EntityState, RoomPhase, SelfUpdate, ServerFrame, ServerMessage,
} from './types';

const EVENT_KIND: Record<string, GameEvent['k']> = {
  CAST: 'cast', DAMAGE: 'dmg', HEAL: 'heal', BUFF: 'buff',
  DIE: 'die', RESPAWN: 'respawn', SAY: 'say', LEVEL_UP: 'lvl', LOOT: 'loot', INTERRUPT: 'interrupt',
};

const TO_OBJECT = { enums: String, longs: Number, defaults: false, oneofs: true };

// 收发的每一帧都会交给 tap：tap(方向, 消息类型, 字节数, 普通对象)。调试面板用它。
export type Tap = (dir: 'in' | 'out', type: string, bytes: number, obj: unknown) => void;

export interface Protocol {
  // decode 解一个服务端帧：服务端时间和按顺序的消息（不认识的类型跳过）；每条消息调一次 tap
  decode(buf: ArrayBuffer): ServerFrame;
  encode(msg: ClientMessage): Uint8Array | null;
  encodeHello(token: string): Uint8Array;   // 每条连接的第一帧；没有 token 传空串
  tap: Tap | null;
}

// 协议里没有浮点数（见 proto/btdemo.proto 开头）：时间是整数毫秒，比例是万分比，坐标是整数像素。
// 前端其余代码一直按“秒”和“小数比例”写，所以只在这里换算一次，别处不用管单位。
const sec = (ms: any): any => (typeof ms === 'number' ? ms / 1000 : ms);   // 毫秒 -> 秒
const frac = (bp: any): any => (typeof bp === 'number' ? bp / 10000 : bp); // 万分比 -> 小数
// 方向（单位向量）发给服务端时乘 10000 取整
const DIR_SCALE = 10000;
const dir = (v: number | undefined): number => Math.round((v || 0) * DIR_SCALE);

// 装备属性里按万分比下发的几项
const BASIS_POINT_STATS = new Set(['crit', 'crit_dmg', 'cdr']);

function skill(s: any): any {
  return s.cooldown !== undefined ? { ...s, cooldown: sec(s.cooldown) } : s;
}

function entityState(s: any): EntityState {
  return s.guard !== undefined ? { ...s, guard: frac(s.guard) } : s;
}

// skin、gear 没设置时是空串（默认外观 / 职业默认武器），这样再收到 Enter 时也能把它们清回默认；
// owner 是宠物的主人，非宠物为 0
function entity(e: any): EntityInfo {
  return { ...e, state: entityState(e.state || { id: e.id }), kind: String(e.kind || '').toLowerCase(), skin: e.skin || '', gear: e.gear || '', owner: e.owner || 0 };
}

function event(ev: any): GameEvent {
  const out = { ...ev, k: EVENT_KIND[ev.kind] || String(ev.kind).toLowerCase() };
  if (ev.value !== undefined) out.v = ev.value;
  for (const key of ['dur', 'knockTime', 'stun', 'hitAt']) {
    if (ev[key] !== undefined) out[key] = sec(ev[key]);
  }
  if (ev.result !== undefined) out.result = String(ev.result).toLowerCase();   // HIT / BLOCK / PARRY / GUARD_BREAK / IMMUNE
  delete out.kind;
  return out;
}

function aiTrace(a: any): AiTrace {
  return {
    id: a.id,
    tree: a.tree,
    ticks: (a.ticks || []).map((t: any) => ({
      time: sec(t.time),
      nodes: (t.nodes || []).map((n: any) => ({
        ...n, status: String(n.status || 'FAILURE').toLowerCase(), notes: n.notes || [],
        checks: (n.checks || []).map((c: any) => ({ node: c.node, pass: !!c.pass, why: c.why || '' })),
        fresh: !!n.fresh, why: n.why || [],
      })),
    })),
    bb: a.blackboard || [],
    path: a.path || [],   // 从实体当前位置开始的路径点，x、y 交替
    def: a.def ? treeDef(a.def) : null,
  };
}

function treeDef(d: any): AiTreeDef {
  const nodes = new Map<number, AiTreeNode>();
  for (const n of d.nodes || []) {
    nodes.set(n.id, {
      id: n.id, kind: n.kind, subType: n.subType, label: n.label || '', props: n.props || [],
      children: n.children || [], decorators: n.decorators || [], services: n.services || [],
      inverse: !!n.inverse, periodic: !!n.periodic, interval: sec(n.interval || 0),
    });
  }
  return { root: d.root, nodes };
}

function classInfo(c: any): ClassInfo {
  return {
    id: c.id, name: c.name, desc: c.desc || '', model: c.model || '', color: c.color || '#e8b65a',
    skills: (c.skills || []).map(skill), pool: (c.pool || []).map(skill), pick: c.pick || 0, canBlock: !!c.canBlock,
    skins: (c.skins || []).map((s: any) => ({ id: s.id, name: s.name, desc: s.desc || '', color: s.color || '#e8b65a' })),
  };
}

function itemInfo(i: any): ItemInfo {
  return {
    id: i.id, name: i.name, slot: i.slot, cls: i.class || '', rarity: i.rarity || 'common', desc: i.desc || '',
    stats: (i.stats || []).map((st: any) => ({
      stat: st.stat, value: BASIS_POINT_STATS.has(st.stat) ? frac(st.value || 0) : st.value || 0,
    })),
    effect: i.effect || '', look: i.look || '',
  };
}

function itemSlotted(i: any): ItemSlotted {
  return { uid: i.uid, id: i.id, slot: i.slot || '' };
}

function petInfo(p: any): PetInfo {
  return { id: p.id, name: p.name, desc: p.desc || '', color: p.color || '#e8b65a', model: p.model || '' };
}

// 自己的信息是增量：只保留出现了的字段；cds、buffs 只在 cdsSet、buffsSet 为 true 时出现
function self(s: any): SelfUpdate {
  const { cds, buffs, cdsSet, buffsSet, ...rest } = s;
  const out: SelfUpdate = rest;
  if (rest.respawnAt !== undefined) out.respawnAt = sec(rest.respawnAt);
  if (rest.attr) out.attr = { ...rest.attr, crit: frac(rest.attr.crit), critDmg: frac(rest.attr.critDmg) };
  if (cdsSet) out.cds = (cds || []).map((c: any) => ({ skill: c.skill, readyAt: sec(c.readyAt) }));
  if (buffsSet) out.buffs = (buffs || []).map((b: any) => ({ name: b.name, until: sec(b.until) }));
  return out;
}

function zone(z: any): any {
  return { ...z, until: sec(z.until), dur: sec(z.dur), interval: sec(z.interval), heal: frac(z.heal) };
}

export function createProtocol(): Protocol {
  const api: Protocol = { decode, encode, encodeHello, tap: null };

  function decode(buf: ArrayBuffer): ServerFrame {
    const frame = btdemo.Frame.decode(new Uint8Array(buf));
    const msgs: ServerMessage[] = [];
    for (const raw of frame.msgs) {
      const obj: any = btdemo.ServerMsg.toObject(raw as btdemo.ServerMsg, TO_OBJECT);
      // 协议面板看的是线上原值（毫秒 / 万分比），换算前的对象
      if (api.tap) api.tap('in', obj.msg, btdemo.ServerMsg.encode(raw).finish().length, obj[obj.msg]);
      const m = message(obj);
      if (m) msgs.push(m);
    }
    // int64 在 protobuf.js 里可能解成 Long，统一换成 number
    const time: any = frame.time;
    return { time: sec(typeof time === 'number' ? time : time.toNumber()), msgs };
  }

  // roomPhase 把 RoomPhase（数字或枚举名）换成小写的名字
  function roomPhase(phase: any): RoomPhase {
    const names: RoomPhase[] = ['idle', 'fight', 'clear', 'skipped'];
    if (typeof phase === 'number') return names[phase] ?? 'idle';
    return (String(phase || 'ROOM_IDLE').replace('ROOM_', '').toLowerCase() as RoomPhase);
  }

  function message(m: any): ServerMessage | null {
    switch (m.msg) {
      case 'welcome': {
        const w = m.welcome;
        return {
          t: 'welcome', id: w.id,
          map: { w: w.mapW, h: w.mapH }, aoi: { cell: w.aoiCell },
          skills: (w.skills || []).map(skill),
          pool: (w.pool || []).map(skill),
          pick: w.pick || 0,
          classes: (w.classes || []).map(classInfo),
          playerClass: w.class || '',
          items: (w.items || []).map(itemInfo),
          pets: (w.pets || []).map(petInfo),
          obstacles: (w.obstacles || []).map((o: any): Obstacle => ({ ...o, shape: String(o.shape).toLowerCase() })),
          token: w.token || '',
          resumed: !!w.resumed,
          scene: w.scene ? {
            id: w.scene.id, name: w.scene.name, line: w.scene.line, map: w.scene.map,
            portals: (w.scene.portals || []).map((p: any) => ({ x: p.x, y: p.y, r: p.r, to: p.to, toName: p.toName })),
            dungeon: !!w.scene.dungeon,
            rooms: (w.scene.rooms || []).map((r: any) => ({
              id: r.id, title: r.title, x: r.x, y: r.y, w: r.w, h: r.h, waves: r.waves || 0, reward: r.reward || '',
            })),
            gates: (w.scene.gates || []).map((g: any) => ({ id: g.id, x: g.x, y: g.y, w: g.w, h: g.h, to: g.to || '' })),
          } : null,
        };
      }
      case 'enter': return { t: 'enter', ents: (m.enter.ents || []).map(entity) };
      case 'leave': return { t: 'leave', ids: m.leave.ids || [] };
      case 'state': return { t: 'state', state: entityState(m.state) };
      case 'event': return { t: 'event', ev: event(m.event) };
      case 'self': return { t: 'self', self: self(m.self) };
      case 'zones': return { t: 'zones', zones: (m.zones.zones || []).map(zone) };
      case 'ai': return { t: 'ai', trace: aiTrace(m.ai) };
      case 'toast': return { t: 'msg', text: m.toast.text };
      case 'skillBar': return { t: 'skills', skills: (m.skillBar.skills || []).map(skill), playerClass: m.skillBar.class || '' };
      case 'inventory': return {
        t: 'inventory', items: (m.inventory.items || []).map(itemSlotted), capacity: m.inventory.capacity || 0,
      };
      case 'lines': return {
        t: 'lines', scene: m.lines.scene, current: m.lines.current,
        lines: (m.lines.lines || []).map((l: any) => ({ line: l.line, players: l.players || 0, soft: l.soft, hard: l.hard })),
      };
      case 'travel': return { t: 'travel', scene: m.travel.scene };
      case 'level': return {
        t: 'level',
        rooms: (m.level.rooms || []).map((r: any) => ({ id: r.id, phase: roomPhase(r.phase), wave: r.wave || 0 })),
        open: m.level.open || [],
      };
      case 'petStatus': return {
        t: 'petStatus', pet: m.petStatus.pet || '', entity: m.petStatus.entity || 0,
        respawnIn: sec(m.petStatus.respawnIn || 0), cooldown: sec(m.petStatus.cooldown || 0),
      };
    }
    return null;
  }

  function encodeHello(token: string): Uint8Array {
    return btdemo.ClientMsg.encode(btdemo.ClientMsg.create({ hello: { token } })).finish();
  }

  function encode(o: ClientMessage): Uint8Array | null {
    let body: btdemo.IClientMsg;
    switch (o.t) {
      case 'move': body = { move: { dx: dir(o.dx), dy: dir(o.dy) } }; break;
      case 'target': body = { target: { id: o.target || 0 } }; break;
      case 'cast': body = { cast: { slot: o.slot, target: o.target || 0, dx: dir(o.dx), dy: dir(o.dy) } }; break;
      case 'loadout': body = { loadout: { skills: o.skills, class: o.cls || undefined } }; break;
      case 'watch': body = { watch: { id: o.id || 0 } }; break;
      case 'block': body = { block: { on: o.on, face: Math.sign(o.face ?? 0) } }; break;
      case 'equip': body = { equip: { uid: o.uid } }; break;
      case 'unequip': body = { unequip: { slot: o.slot } }; break;
      case 'skin': body = { skin: { skin: o.skin || '' } }; break;
      case 'pet': body = { pet: { pet: o.pet || '' } }; break;
      case 'lines': body = { lines: {} }; break;
      case 'switchLine': body = { switchLine: { line: o.line } }; break;
      default: return null;
    }
    const data = btdemo.ClientMsg.encode(btdemo.ClientMsg.create(body)).finish();
    if (api.tap) {
      const type = Object.keys(body)[0];
      api.tap('out', type, data.length, (body as any)[type]);
    }
    return data;
  }

  return api;
}
