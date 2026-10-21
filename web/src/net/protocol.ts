// 二进制 protobuf（proto2）协议。
// pb.js / pb.d.ts 由 `npm run proto` 从 proto/btdemo.proto 生成（和服务端同一份 .proto），
// 字段改名或删掉时 tsc 会直接报错。
// decode() 把 ServerMsg 转成 types.ts 里的普通对象；encode() 组装 ClientMsg。
// 其余代码只用 types.ts，不直接碰 protobuf。

import { btdemo } from './pb';
import type {
  AiTrace, ClientMessage, EntityInfo, GameEvent, Obstacle, SelfInfo, ServerMessage,
} from './types';

const EVENT_KIND: Record<string, GameEvent['k']> = {
  CAST: 'cast', DAMAGE: 'dmg', HEAL: 'heal', BUFF: 'buff',
  DIE: 'die', RESPAWN: 'respawn', SAY: 'say', LEVEL_UP: 'lvl',
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

function entity(e: any): EntityInfo {
  return { ...e, kind: String(e.kind || '').toLowerCase() };
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
      })),
    })),
    bb: a.blackboard || [],
    path: a.path || [],   // 从实体当前位置开始的路径点，x、y 交替
  };
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
          props: w.props || [],
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
        };
      }
      case 'toast': return { t: 'msg', text: m.toast.text };
    }
    return null;
  }

  function encode(o: ClientMessage): Uint8Array | null {
    let body: btdemo.IClientMsg;
    switch (o.t) {
      case 'move': body = { move: { dx: o.dx, dy: o.dy } }; break;
      case 'target': body = { target: { id: o.target || 0 } }; break;
      case 'cast': body = { cast: { slot: o.slot, target: o.target || 0 } }; break;
      case 'watch': body = { watch: { id: o.id || 0 } }; break;
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
