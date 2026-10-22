// 二进制 protobuf（proto2）协议。
// pb.js / pb.d.ts 由 `npm run proto` 从 proto/btdemo.proto 生成（和服务端同一份 .proto），
// 字段改名或删掉时 tsc 会直接报错。
// decode() 把 ServerMsg 转成 types.ts 里的普通对象；encode() 组装 ClientMsg。
// 其余代码只用 types.ts，不直接碰 protobuf。

import { btdemo } from './pb';
import type {
  AiTrace, ClassInfo, AiTreeDef, AiTreeNode, ClientMessage, EntityInfo, GameEvent, ItemInfo, ItemSlotted, Obstacle, SelfInfo,
  ServerMessage,
} from './types';

const EVENT_KIND: Record<string, GameEvent['k']> = {
  CAST: 'cast', DAMAGE: 'dmg', HEAL: 'heal', BUFF: 'buff',
  DIE: 'die', RESPAWN: 'respawn', SAY: 'say', LEVEL_UP: 'lvl', LOOT: 'loot',
};

const TO_OBJECT = { enums: String, longs: Number, defaults: false, oneofs: true };

// 收发的每一帧都会交给 tap：tap(方向, 消息类型, 字节数, 普通对象)。调试面板用它。
export type Tap = (dir: 'in' | 'out', type: string, bytes: number, obj: unknown) => void;

export interface Protocol {
  decode(buf: ArrayBuffer): ServerMessage | null;
  encode(msg: ClientMessage): Uint8Array | null;
  tap: Tap | null;
}

// float32 字段解出来是 0.699999988 这种值，保留三位小数让界面干净些。
function tidy(v: any): any {
  if (typeof v === 'number') return Math.round(v * 1000) / 1000;
  if (Array.isArray(v)) return v.map(tidy);
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const k in v) out[k] = tidy(v[k]);
    return out;
  }
  return v;
}

// skin、gear 没设置时是空串（默认外观 / 职业默认武器），这样再收到 Enter 时也能把它们清回默认
function entity(e: any): EntityInfo {
  return { ...e, kind: String(e.kind || '').toLowerCase(), skin: e.skin || '', gear: e.gear || '' };
}

function event(ev: any): GameEvent {
  const out = { ...ev, k: EVENT_KIND[ev.kind] || String(ev.kind).toLowerCase() };
  if (ev.value !== undefined) out.v = ev.value;
  delete out.kind;
  return out;
}

function aiTrace(a: any): AiTrace {
  return {
    id: a.id,
    tree: a.tree,
    ticks: (a.ticks || []).map((t: any) => ({
      time: t.time,
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
      inverse: !!n.inverse, periodic: !!n.periodic, interval: n.interval || 0,
    });
  }
  return { root: d.root, nodes };
}

function classInfo(c: any): ClassInfo {
  return {
    id: c.id, name: c.name, desc: c.desc || '', model: c.model || '', color: c.color || '#e8b65a',
    skills: c.skills || [], pool: c.pool || [], pick: c.pick || 0, canBlock: !!c.canBlock,
    skins: (c.skins || []).map((s: any) => ({ id: s.id, name: s.name, desc: s.desc || '', color: s.color || '#e8b65a' })),
  };
}

function itemInfo(i: any): ItemInfo {
  return {
    id: i.id, name: i.name, slot: i.slot, cls: i.class || '', rarity: i.rarity || 'common', desc: i.desc || '',
    stats: (i.stats || []).map((st: any) => ({ stat: st.stat, value: st.value || 0 })),
    effect: i.effect || '', look: i.look || '',
  };
}

function itemSlotted(i: any): ItemSlotted {
  return { uid: i.uid, id: i.id, slot: i.slot || '' };
}

function self(s: any): SelfInfo {
  const cds: Record<string, number> = {};
  for (const c of s.cds || []) cds[c.skill] = c.left;
  return { ...s, cds, buffs: s.buffs || [] };
}

export function createProtocol(): Protocol {
  const api: Protocol = { decode, encode, tap: null };

  function decode(buf: ArrayBuffer): ServerMessage | null {
    const pb = btdemo.ServerMsg.decode(new Uint8Array(buf));
    const m = tidy(btdemo.ServerMsg.toObject(pb, TO_OBJECT));
    if (api.tap) api.tap('in', m.msg, buf.byteLength, m[m.msg]);
    switch (m.msg) {
      case 'welcome': {
        const w = m.welcome;
        return {
          t: 'welcome', id: w.id,
          map: { w: w.mapW, h: w.mapH }, aoi: { cell: w.aoiCell },
          skills: w.skills || [],
          pool: w.pool || [],
          pick: w.pick || 0,
          classes: (w.classes || []).map(classInfo),
          playerClass: w.class || '',
          items: (w.items || []).map(itemInfo),
          obstacles: (w.obstacles || []).map((o: any): Obstacle => ({ ...o, shape: String(o.shape).toLowerCase() })),
        };
      }
      case 'enter': return { t: 'enter', ents: (m.enter.ents || []).map(entity) };
      case 'leave': return { t: 'leave', ids: m.leave.ids || [] };
      case 'sync': {
        const s = m.sync;
        return {
          t: 'sync', time: s.time, ents: s.ents || [],
          ev: (s.ev || []).map(event), self: s.self ? self(s.self) : null,
          ai: s.ai ? aiTrace(s.ai) : null,
          zones: s.zonesSet ? s.zones || [] : null,
        };
      }
      case 'toast': return { t: 'msg', text: m.toast.text };
      case 'skillBar': return { t: 'skills', skills: m.skillBar.skills || [], playerClass: m.skillBar.class || '' };
      case 'inventory': return {
        t: 'inventory', items: (m.inventory.items || []).map(itemSlotted), capacity: m.inventory.capacity || 0,
      };
    }
    return null;
  }

  function encode(o: ClientMessage): Uint8Array | null {
    let body: btdemo.IClientMsg;
    switch (o.t) {
      case 'move': body = { move: { dx: o.dx, dy: o.dy } }; break;
      case 'target': body = { target: { id: o.target || 0 } }; break;
      case 'cast': body = { cast: { slot: o.slot, target: o.target || 0, dx: o.dx || 0, dy: o.dy || 0 } }; break;
      case 'loadout': body = { loadout: { skills: o.skills, class: o.cls || undefined } }; break;
      case 'watch': body = { watch: { id: o.id || 0 } }; break;
      case 'block': body = { block: { on: o.on } }; break;
      case 'equip': body = { equip: { uid: o.uid } }; break;
      case 'unequip': body = { unequip: { slot: o.slot } }; break;
      case 'skin': body = { skin: { skin: o.skin || '' } }; break;
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
