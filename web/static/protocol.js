// Binary protobuf (proto2) protocol. The schema is /btdemo.proto, served by
// the Go server from proto/btdemo.proto and parsed here with protobuf.js.
// decode() turns a ServerMsg into the plain objects the rest of the client
// uses; encode() builds a ClientMsg.

const EVENT_KIND = {
  CAST: 'cast', DAMAGE: 'dmg', HEAL: 'heal', BUFF: 'buff',
  DIE: 'die', RESPAWN: 'respawn', SAY: 'say', LEVEL_UP: 'lvl',
};

const TO_OBJECT = { enums: String, longs: Number, defaults: false, oneofs: true };

// float32 fields come back as e.g. 0.699999988; round to keep the UI tidy.
function tidy(v) {
  if (typeof v === 'number') return Math.round(v * 1000) / 1000;
  if (Array.isArray(v)) return v.map(tidy);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k in v) out[k] = tidy(v[k]);
    return out;
  }
  return v;
}

function entity(e) {
  return { ...e, kind: String(e.kind || '').toLowerCase() };
}

function event(ev) {
  const out = { ...ev, k: EVENT_KIND[ev.kind] || String(ev.kind).toLowerCase() };
  if (ev.value !== undefined) out.v = ev.value;
  delete out.kind;
  return out;
}

function aiTrace(a) {
  return {
    id: a.id,
    tree: a.tree,
    ticks: (a.ticks || []).map((t) => ({
      time: t.time,
      nodes: (t.nodes || []).map((n) => ({ ...n, status: String(n.status || 'FAILURE').toLowerCase(), notes: n.notes || [] })),
    })),
    bb: a.blackboard || [],
    path: a.path || [],   // x, y pairs from the entity's position along its route
  };
}

function self(s) {
  const cds = {};
  for (const c of s.cds || []) cds[c.skill] = c.left;
  return { ...s, cds, buffs: s.buffs || [] };
}

export async function loadProtocol() {
  const root = await protobuf.load('btdemo.proto');
  const ServerMsg = root.lookupType('btdemo.ServerMsg');
  const ClientMsg = root.lookupType('btdemo.ClientMsg');

  // tap, when set, sees every frame: tap(dir, type, bytes, plainObject).
  const api = { decode, encode, tap: null };

  function decode(buf) {
    const m = tidy(ServerMsg.toObject(ServerMsg.decode(new Uint8Array(buf)), TO_OBJECT));
    if (api.tap) api.tap('in', m.msg, buf.byteLength, m[m.msg]);
    switch (m.msg) {
      case 'welcome': {
        const w = m.welcome;
        return {
          t: 'welcome', id: w.id,
          map: { w: w.mapW, h: w.mapH }, aoi: { cell: w.aoiCell },
          skills: w.skills || [],
          props: w.props || [],
          obstacles: (w.obstacles || []).map((o) => ({ ...o, shape: String(o.shape).toLowerCase() })),
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

  // encode takes the client's own message shapes: {t:'move',dx,dy},
  // {t:'target',target}, {t:'cast',slot,target}, {t:'watch',id}.
  function encode(o) {
    let body;
    switch (o.t) {
      case 'move': body = { move: { dx: o.dx, dy: o.dy } }; break;
      case 'target': body = { target: { id: o.target || 0 } }; break;
      case 'cast': body = { cast: { slot: o.slot, target: o.target || 0 } }; break;
      case 'watch': body = { watch: { id: o.id || 0 } }; break;
      default: return null;
    }
    const data = ClientMsg.encode(ClientMsg.fromObject(body)).finish();
    if (api.tap) {
      const type = Object.keys(body)[0];
      api.tap('out', type, data.length, body[type]);
    }
    return data;
  }

  return api;
}
