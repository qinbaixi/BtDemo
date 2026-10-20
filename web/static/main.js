/*
 * BtDemo browser client.
 * Sections: config · state · helpers · net · events · render · hud · input · boot
 */

/* ============================== config ============================== */

import { loadProtocol } from './protocol.js';

const LERP_MS = 100;          // position interpolation window between 10 Hz syncs
const SNAP_DIST = 400;        // larger jumps snap instead of sliding
const FX_LIFE = { melee: 220, projectile: 250, circle: 450, heal: 700, buff: 900 };
const ACT_NAMES = {
  find_target: '索敌',
  chase_target: '追击',
  cast_skill: '施法',
  wander: '闲逛',
  return_home: '回家',
  flee: '逃跑',
  wait: '待机',
  say: '说话',
  clear_target: '清除目标',
  move: '移动',
};
const KIND_COLOR = { player: '#4fc3f7', monster: '#e53935', npc: '#42a5f5' };
const NAME_COLOR = { player: '#f5f5f5', monster: '#ff8a80', npc: '#9fd3ff' };
const MOVE_DIR = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};
const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Segoe UI",sans-serif';
const BASE_ATTRS = [['str', '力量'], ['agi', '敏捷'], ['int', '智力'], ['vit', '体质']];
const DERIVED_ATTRS = [
  ['maxHp', '生命上限'], ['atk', '攻击'], ['matk', '法强'], ['def', '防御'],
  ['mdef', '法抗'], ['crit', '暴击率'], ['critDmg', '暴击伤害'], ['speed', '移速'],
];

/* ============================== state =============================== */

const state = {
  myId: 0,
  map: { w: 2400, h: 1600 },
  cell: 320,
  skills: [],
  skillBySlot: {},
  ents: new Map(),        // id -> entity (see makeEntity)
  self: null,             // latest `self` block from sync
  selfAt: 0,              // performance.now() of that sync
  cds: {},                // skillId -> seconds left at cdsAt
  cdsAt: 0,
  target: 0,
  hoverSlot: 0,
  showAOI: true,
  effects: [],
  floats: [],
  bubbles: new Map(),     // id -> { text, until }
  flashes: new Map(),     // id -> until (hit flash)
  cam: { x: 0, y: 0, w: 0, h: 0 },
  dpr: 1,
};
const keys = new Set();   // held KeyboardEvent.code values
const ui = { attr: {}, skillBtns: {} };
let ctx = null;
let ws = null;
let protocol = null; // set by loadProtocol() before the first connect
let retryTimer = 0;
let toastTimer = 0;
let lastMove = '';

/* ============================== helpers ============================= */

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const hypot = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

function fmt(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-';
  const r = Math.round(v);
  return Math.abs(v - r) < 0.05 ? String(r) : v.toFixed(1);
}
function fmtCrit(c) {
  if (typeof c !== 'number') return '-';
  return fmt(c <= 1 ? c * 100 : c) + '%';   // accepts 0.15 or 15
}
function fmtMult(v) {
  if (typeof v !== 'number') return '-';
  return (Math.round(v * 100) / 100) + '×';
}
function setText(el, s) {
  if (el && el.textContent !== s) el.textContent = s;
}
function setBar(fill, txt, cur, max, label) {
  const frac = max > 0 ? clamp(cur / max, 0, 1) : 0;
  fill.style.width = (frac * 100).toFixed(2) + '%';
  setText(txt, label ?? `${fmt(cur)} / ${fmt(max)}`);
}
function hpColor(frac) {
  if (frac > 0.5) return '#4caf50';
  if (frac > 0.25) return '#ffb300';
  return '#ef5350';
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeEntity(d, now) {
  const kind = d.kind || 'monster';
  return {
    id: d.id,
    kind,
    name: d.name || '?',
    color: d.color || KIND_COLOR[kind] || '#cccccc',
    r: d.r || 14,
    lv: d.lv || 1,
    x: d.x || 0,
    y: d.y || 0,
    px: d.x || 0,       // position at the start of the current lerp
    py: d.y || 0,
    t0: now,            // when the current lerp started
    hp: d.hp || 0,
    maxHp: d.maxHp || 0,
    act: '',
    tg: 0,
    dead: false,
  };
}

// Rendered position: lerp from the previous position to the latest synced one.
function posOf(e, now) {
  const k = clamp((now - e.t0) / LERP_MS, 0, 1);
  return { x: lerp(e.px, e.x, k), y: lerp(e.py, e.y, k) };
}

// Live position of an entity id, or the captured fallback when it is gone.
function livePos(id, fx, fy, now) {
  const e = id ? state.ents.get(id) : null;
  return e ? posOf(e, now) : { x: fx, y: fy };
}

function cdRemaining(skillId, now) {
  return Math.max(0, (state.cds[skillId] || 0) - (now - state.cdsAt) / 1000);
}

/* ============================== net ================================= */

function setConn(kind, text) {
  setText(ui.conn, text);
  ui.conn.className = `conn ${kind}`;
}

function connect() {
  clearTimeout(retryTimer);
  setConn('wait', '连接中…');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let sock;
  try {
    sock = new WebSocket(`${proto}//${location.host}/ws`);
  } catch (err) {
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => setConn('wait', '已连接，等待数据…');
  sock.onmessage = (ev) => {
    let m;
    try { m = protocol.decode(ev.data); } catch (err) { console.warn('bad frame', err); return; }
    if (m) handleMsg(m);
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    state.ents.clear();
    state.self = null;
    state.target = 0;
    setConn('bad', '连接已断开，2 秒后重连');
    scheduleReconnect();
  };
  sock.onerror = () => { /* onclose follows; reconnect is handled there */ };
}

function scheduleReconnect() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, 2000);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const data = protocol.encode(obj);
    if (data) ws.send(data);
  }
}

function handleMsg(m) {
  const now = performance.now();
  switch (m.t) {
    case 'welcome': onWelcome(m); break;
    case 'enter':
      for (const d of m.ents || []) state.ents.set(d.id, makeEntity(d, now));
      break;
    case 'leave':
      for (const id of m.ids || []) {
        state.ents.delete(id);
        state.bubbles.delete(id);
        state.flashes.delete(id);
        if (id === state.target) {
          state.target = 0;
          send({ t: 'target', target: 0 });
        }
      }
      break;
    case 'sync': onSync(m, now); break;
    case 'msg': showToast(m.text); break;
  }
}

function onWelcome(m) {
  state.myId = m.id;
  state.map = m.map || state.map;
  state.cell = (m.aoi && m.aoi.cell) || state.cell;
  state.skills = (m.skills || []).slice().sort((a, b) => a.slot - b.slot);
  state.skillBySlot = {};
  for (const sk of state.skills) state.skillBySlot[sk.slot] = sk;

  // A welcome means a brand-new character: drop everything from the old one.
  state.ents.clear();
  state.effects = [];
  state.floats = [];
  state.bubbles.clear();
  state.flashes.clear();
  state.self = null;
  state.cds = {};
  state.target = 0;
  state.hoverSlot = 0;

  buildSkillBar();
  setConn('ok', '已连接');
  lastMove = '';
  sendMove(true);   // tell the server the current key state
}

function onSync(m, now) {
  for (const s of m.ents || []) {
    let e = state.ents.get(s.id);
    if (!e && s.id === state.myId) {
      e = makeEntity({ id: s.id, kind: 'player', name: '我', r: 16, x: s.x, y: s.y }, now);
      state.ents.set(s.id, e);
    }
    if (!e) continue;
    const cur = posOf(e, now);
    const jump = hypot(cur.x, cur.y, s.x, s.y) > SNAP_DIST;
    e.px = jump ? s.x : cur.x;
    e.py = jump ? s.y : cur.y;
    e.x = s.x;
    e.y = s.y;
    e.t0 = now;
    e.hp = s.hp;
    e.maxHp = s.maxHp;
    e.lv = s.lv;
    e.act = s.act || '';
    e.tg = s.tg || 0;
    e.dead = !!s.dead;
  }
  if (m.self) {
    state.self = m.self;
    state.selfAt = now;
    state.cds = m.self.cds || {};
    state.cdsAt = now;
    renderSelf();
  }
  for (const ev of m.ev || []) onEvent(ev, now);
}

/* ============================== events ============================== */

function onEvent(ev, now) {
  switch (ev.k) {
    case 'cast': addCast(ev, now); break;
    case 'dmg':
      if (ev.dst) {
        state.flashes.set(ev.dst, now + 150);
        if (ev.crit) addFloat(now, ev.dst, `暴击 -${ev.v}`, '#ffe14d', 24, 1000);
        else addFloat(now, ev.dst, `-${ev.v}`, '#ff5a5a', 16, 900);
      }
      break;
    case 'heal':
      addFloat(now, ev.dst, `+${ev.v}`, '#7cff9b', 16, 1000);
      break;
    case 'buff':
      addFloat(now, ev.dst, String(ev.name || ''), '#9ad7ff', 14, 1200);
      break;
    case 'die':
      state.bubbles.delete(ev.id);
      break;
    case 'respawn':
      addFloat(now, ev.id, '复活', '#7cff9b', 16, 1000);
      break;
    case 'say':
      state.bubbles.set(ev.id, { text: String(ev.text || ''), until: now + 3000 });
      break;
    case 'lvl':
      addFloat(now, ev.id, `升级! Lv ${ev.lv}`, '#ffd54a', 26, 1600, { pop: true, rise: 60 });
      break;
  }
}

function addCast(ev, now) {
  const src = livePos(ev.src, ev.x ?? 0, ev.y ?? 0, now);
  const dst = ev.dst ? livePos(ev.dst, src.x, src.y, now) : src;
  const fx = ev.fx || 'melee';
  const cx = typeof ev.x === 'number' ? ev.x : dst.x;
  const cy = typeof ev.y === 'number' ? ev.y : dst.y;
  const color = ev.color || (fx === 'heal' ? '#7cff9b' : '#ffffff');
  const parts = [];
  for (let i = 0; i < 6; i++) parts.push({ ox: (i - 2.5) * 9 + (Math.random() - 0.5) * 4, delay: i * 0.08 });

  state.effects.push({
    fx,
    src: ev.src || 0,
    dst: ev.dst || 0,
    sx: src.x, sy: src.y,
    dx: dst.x, dy: dst.y,
    cx, cy,
    radius: ev.radius || 40,
    color,
    born: now,
    life: FX_LIFE[fx] || 300,
    parts,
  });
  if (ev.name && ev.src) addFloat(now, ev.src, String(ev.name), color, 14, 1000, { rise: 26 });
}

// Floating text above an entity (or at its last known position).
function addFloat(now, anchorId, text, color, size, life, opts = {}) {
  const e = state.ents.get(anchorId);
  if (!e) return;
  const p = posOf(e, now);
  state.floats.push({
    anchor: anchorId,
    x: p.x, y: p.y,
    oy: -((e.r || 14) + 30),
    jx: (Math.random() - 0.5) * 22,
    text, color, size, life,
    born: now,
    rise: opts.rise ?? 40,
    pop: !!opts.pop,
  });
}

/* ============================== render ============================== */

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  updateCamera(now);
  draw(now);
  renderTarget();
  renderSkillBar(now);
  renderDeath(now);
}

function updateCamera(now) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { w, h } = state.map;
  const me = state.ents.get(state.myId);
  const p = me ? posOf(me, now) : { x: w / 2, y: h / 2 };
  const x = w <= vw ? (w - vw) / 2 : clamp(p.x - vw / 2, 0, w - vw);
  const y = h <= vh ? (h - vh) / 2 : clamp(p.y - vh / 2, 0, h - vh);
  state.cam = { x, y, w: vw, h: vh };
}

function draw(now) {
  const { x: cx, y: cy, w: vw, h: vh } = state.cam;
  const dpr = state.dpr;
  // World units are CSS pixels; the camera offset is applied in the transform.
  ctx.setTransform(dpr, 0, 0, dpr, -cx * dpr, -cy * dpr);
  ctx.fillStyle = '#0b1510';
  ctx.fillRect(cx, cy, vw, vh);

  const me = state.ents.get(state.myId);
  const mp = me ? posOf(me, now) : null;

  drawGround();
  if (state.showAOI) drawAOI(mp);
  drawBorder();

  if (mp && state.hoverSlot) drawRangePreview(mp);
  const tgt = state.ents.get(state.target);
  if (tgt && mp) drawTargetMarks(tgt, mp, now);

  const list = [];
  for (const e of state.ents.values()) list.push({ e, p: posOf(e, now) });
  list.sort((a, b) => a.p.y - b.p.y);
  for (const it of list) drawEntity(it.e, it.p, now);

  drawEffects(now);
  drawBubbles(now);
  drawFloats(now);
}

function drawGround() {
  const { w, h } = state.map;
  ctx.fillStyle = '#1d3a2a';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= w; x += 80) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
  for (let y = 0; y <= h; y += 80) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
  ctx.stroke();
}

function drawBorder() {
  const { w, h } = state.map;
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255,213,74,0.55)';
  ctx.strokeRect(0, 0, w, h);
}

function drawAOI(mp) {
  const { w, h } = state.map;
  const c = state.cell;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(160,255,200,0.08)';
  ctx.beginPath();
  for (let x = c; x < w; x += c) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = c; y < h; y += c) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();

  if (!mp) return;
  const gx = Math.floor(mp.x / c);
  const gy = Math.floor(mp.y / c);
  const x0 = clamp((gx - 1) * c, 0, w);
  const y0 = clamp((gy - 1) * c, 0, h);
  const x1 = clamp((gx + 2) * c, 0, w);
  const y1 = clamp((gy + 2) * c, 0, h);
  ctx.fillStyle = 'rgba(120,200,255,0.09)';
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.save();
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(120,200,255,0.6)';
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
  ctx.font = `bold 13px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(160,220,255,0.9)';
  ctx.fillText('AOI 视野', x0 + 8, y0 + 18);
}

function drawRangePreview(mp) {
  const sk = state.skillBySlot[state.hoverSlot];
  if (!sk) return;
  const R = sk.kind === 'aoe' ? (sk.radius || sk.range || 0) : (sk.range || 0);
  if (R <= 0) return;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.beginPath();
  ctx.arc(mp.x, mp.y, R, 0, Math.PI * 2);
  ctx.fill();
  ctx.setLineDash([10, 6]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = sk.color || '#ffd166';
  ctx.globalAlpha = 0.85;
  ctx.stroke();
  ctx.restore();
}

function drawTargetMarks(tgt, mp, now) {
  const tp = posOf(tgt, now);
  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = 'rgba(255,224,102,0.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(mp.x, mp.y);
  ctx.lineTo(tp.x, tp.y);
  ctx.stroke();
  ctx.setLineDash([]);

  const pulse = 0.5 + 0.5 * Math.sin(now / 160);
  ctx.strokeStyle = '#ffe066';
  ctx.lineWidth = 2.5;
  ctx.globalAlpha = 0.5 + 0.5 * pulse;
  ctx.beginPath();
  ctx.arc(tp.x, tp.y, (tgt.r || 14) + 7 + pulse * 3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawEntity(e, p, now) {
  const r = e.r || 14;
  const dead = e.dead;
  const isSelf = e.id === state.myId;
  const color = dead ? '#5d6661' : (e.color || KIND_COLOR[e.kind] || '#cccccc');

  // body
  ctx.save();
  if (dead) ctx.globalAlpha = 0.4;
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y + r * 0.85, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  if (e.kind === 'player') {
    ctx.lineWidth = isSelf ? 4 : 2;
    ctx.strokeStyle = isSelf ? '#ffd54a' : '#ffffff';
  } else {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  }
  ctx.stroke();

  const fl = state.flashes.get(e.id) || 0;
  if (fl > now) {
    ctx.globalAlpha = ((fl - now) / 150) * 0.7;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  if (dead) {
    const s = r * 0.5;
    ctx.save();
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(p.x - s, p.y - s);
    ctx.lineTo(p.x + s, p.y + s);
    ctx.moveTo(p.x + s, p.y - s);
    ctx.lineTo(p.x - s, p.y + s);
    ctx.stroke();
    ctx.restore();
  }

  // name + level, HP bar, action label, aggro marker
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `bold 13px ${FONT}`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  let nameColor = NAME_COLOR[e.kind] || '#ffffff';
  if (isSelf) nameColor = '#ffd54a';
  if (dead) nameColor = '#9aa39e';
  const label = `${e.name} Lv${fmt(e.lv)}`;
  const ly = p.y - r - 24;
  ctx.strokeText(label, p.x, ly);
  ctx.fillStyle = nameColor;
  ctx.fillText(label, p.x, ly);

  if (!dead) {
    const bw = Math.max(44, r * 2 + 14);
    const bh = 5;
    const bx = p.x - bw / 2;
    const by = p.y - r - 16;
    const frac = e.maxHp > 0 ? clamp(e.hp / e.maxHp, 0, 1) : 0;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
    ctx.fillStyle = hpColor(frac);
    ctx.fillRect(bx, by, bw * frac, bh);
  }

  if (e.kind !== 'player' && e.act && !dead) {
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = '#b5bfb8';
    ctx.fillText(ACT_NAMES[e.act] || e.act, p.x, p.y + r + 15);
  }

  if (e.kind === 'monster' && e.tg === state.myId && !dead) {
    ctx.font = `bold 20px ${FONT}`;
    ctx.strokeText('!', p.x, p.y - r - 40);
    ctx.fillStyle = '#ff3b3b';
    ctx.fillText('!', p.x, p.y - r - 40);
  }
  ctx.restore();
}

function drawEffects(now) {
  state.effects = state.effects.filter((f) => now - f.born < f.life);
  for (const f of state.effects) {
    const t = clamp((now - f.born) / f.life, 0, 1);
    const sp = livePos(f.src, f.sx, f.sy, now);
    const dp = livePos(f.dst, f.dx, f.dy, now);
    ctx.save();
    ctx.strokeStyle = f.color;
    ctx.fillStyle = f.color;
    ctx.lineCap = 'round';
    switch (f.fx) {
      case 'melee': {
        const ang = Math.atan2(dp.y - sp.y, dp.x - sp.x);
        const a0 = ang - 0.9;
        const a1 = a0 + 1.8 * Math.min(1, t * 1.6);
        ctx.globalAlpha = 1 - t * 0.8;
        ctx.lineWidth = 6 * (1 - t) + 1;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 34, a0, a1);
        ctx.stroke();
        break;
      }
      case 'projectile': {
        const x = lerp(sp.x, dp.x, t);
        const y = lerp(sp.y, dp.y, t);
        ctx.shadowColor = f.color;
        ctx.shadowBlur = 18;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'circle': {
        const rad = Math.max(2, f.radius * (0.2 + 0.8 * t));
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(f.cx, f.cy, rad, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.15 * (1 - t);
        ctx.fill();
        break;
      }
      case 'heal': {
        ctx.globalAlpha = 1 - t * 0.6;
        for (const p of f.parts) {
          const k = clamp(t * 1.3 - p.delay, 0, 1);
          if (k <= 0) continue;
          ctx.beginPath();
          ctx.arc(sp.x + p.ox, sp.y + 8 - 50 * k, 3 + 1.5 * (1 - k), 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'buff': {
        for (const off of [0, 0.5]) {
          const k = (t + off) % 1;
          ctx.globalAlpha = 1 - k;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, 16 + 30 * k, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
    }
    ctx.restore();
  }
}

function drawBubbles(now) {
  for (const [id, b] of state.bubbles) {
    if (now >= b.until) { state.bubbles.delete(id); continue; }
    const e = state.ents.get(id);
    if (!e) continue;
    const p = posOf(e, now);
    ctx.save();
    ctx.font = `13px ${FONT}`;
    const w = ctx.measureText(b.text).width + 16;
    const h = 24;
    const x = p.x - w / 2;
    const y = p.y - (e.r || 14) - 72 - h;
    ctx.globalAlpha = clamp((b.until - now) / 400, 0, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    roundRect(x, y, w, h, 8);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(p.x - 6, y + h - 1);
    ctx.lineTo(p.x + 6, y + h - 1);
    ctx.lineTo(p.x, y + h + 6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#1b2a20';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.text, p.x, y + h / 2);
    ctx.restore();
  }
}

function drawFloats(now) {
  state.floats = state.floats.filter((f) => now - f.born < f.life);
  for (const f of state.floats) {
    const t = (now - f.born) / f.life;
    const e = state.ents.get(f.anchor);
    const base = e ? posOf(e, now) : { x: f.x, y: f.y };
    const x = base.x + f.jx;
    const y = base.y + f.oy - f.rise * (1 - (1 - t) * (1 - t));   // ease-out rise
    const alpha = t < 0.6 ? 1 : clamp(1 - (t - 0.6) / 0.4, 0, 1);
    const scale = f.pop && t < 0.2 ? 1 + 0.5 * (1 - t / 0.2) : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `bold ${(f.size * scale).toFixed(1)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(f.text, x, y);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, x, y);
    ctx.restore();
  }
}

/* ============================== hud ================================= */

function buildAttrRows() {
  const mk = (defs, box, prefix) => {
    box.replaceChildren(...defs.map(([k, label]) => {
      const row = document.createElement('div');
      row.className = 'kv';
      const name = document.createElement('span');
      name.textContent = label;
      const val = document.createElement('b');
      val.textContent = '-';
      row.append(name, val);
      ui.attr[prefix + k] = val;
      return row;
    }));
  };
  mk(BASE_ATTRS, ui.baseAttrs, 'base.');
  mk(DERIVED_ATTRS, ui.derivedAttrs, 'der.');
}

function buildSkillBar() {
  ui.skillbar.replaceChildren();
  ui.skillBtns = {};
  for (let slot = 1; slot <= 5; slot++) {
    const sk = state.skillBySlot[slot] || null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'skill';
    btn.disabled = !sk;
    if (sk) btn.style.setProperty('--skill', sk.color || '#ffd166');

    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = String(slot);
    const name = document.createElement('span');
    name.className = 'sname';
    name.textContent = sk ? sk.name : '—';
    const cd = document.createElement('span');
    cd.className = 'cd';
    const num = document.createElement('span');
    num.className = 'cdnum';
    btn.append(key, name, cd, num);

    btn.addEventListener('click', () => castSlot(slot));
    btn.addEventListener('pointerenter', () => { state.hoverSlot = slot; });
    btn.addEventListener('pointerleave', () => {
      if (state.hoverSlot === slot) state.hoverSlot = 0;
    });
    ui.skillbar.appendChild(btn);
    ui.skillBtns[slot] = { btn, cd, num, sk, lastH: '', lastNum: '' };
  }
}

function renderSkillBar(now) {
  for (let slot = 1; slot <= 5; slot++) {
    const b = ui.skillBtns[slot];
    if (!b || !b.sk) continue;
    const left = cdRemaining(b.sk.id, now);
    const total = b.sk.cooldown || 0;
    const h = (total > 0 ? clamp(left / total, 0, 1) * 100 : 0).toFixed(1) + '%';
    if (b.lastH !== h) { b.cd.style.height = h; b.lastH = h; }
    const txt = left > 0.05 ? left.toFixed(1) : '';
    if (b.lastNum !== txt) { b.num.textContent = txt; b.lastNum = txt; }
  }
}

function renderSelf() {
  const s = state.self;
  if (!s) return;
  const me = state.ents.get(state.myId);
  setText(ui.selfName, me ? me.name : '我');
  setText(ui.selfLv, `Lv ${fmt(s.lv)}`);

  const maxHp = s.attr?.maxHp ?? me?.maxHp ?? 0;
  setBar(ui.selfHpFill, ui.selfHpText, s.hp ?? me?.hp ?? 0, maxHp);

  const exp = s.exp ?? 0;
  const next = s.next ?? 0;
  setBar(ui.selfExpFill, ui.selfExpText, exp, next, next > 0 ? `${fmt(exp)} / ${fmt(next)}` : fmt(exp));

  for (const [k] of BASE_ATTRS) setText(ui.attr['base.' + k], fmt(s.base?.[k]));
  for (const [k] of DERIVED_ATTRS) {
    const v = s.attr?.[k];
    const text = k === 'crit' ? fmtCrit(v) : k === 'critDmg' ? fmtMult(v) : fmt(v);
    setText(ui.attr['der.' + k], text);
  }
  renderBuffs(s.buffs || []);
}

function renderBuffs(list) {
  if (!list.length) {
    ui.buffs.replaceChildren(document.createTextNode('无'));
    return;
  }
  ui.buffs.replaceChildren(...list.map((b) => {
    const el = document.createElement('span');
    el.className = 'buff';
    el.textContent = `${b.name} ${Math.max(0, b.left ?? 0).toFixed(1)}s`;
    return el;
  }));
}

function renderTarget() {
  const e = state.ents.get(state.target);
  ui.panelTarget.classList.toggle('hidden', !e);
  if (!e) return;
  setText(ui.tgtName, e.name);
  setText(ui.tgtLv, `Lv ${fmt(e.lv)}${e.dead ? ' · 已阵亡' : ''}`);
  setBar(ui.tgtHpFill, ui.tgtHpText, e.hp, e.maxHp);
}

function renderDeath(now) {
  const s = state.self;
  const dead = !!(s && s.dead);
  ui.death.classList.toggle('hidden', !dead);
  if (!dead) return;
  const left = (s.respawnIn ?? 0) - (now - state.selfAt) / 1000;
  setText(ui.deathText, left > 0
    ? `你已阵亡，${Math.ceil(left)} 秒后复活`
    : '你已阵亡，即将复活…');
}

function showToast(text) {
  setText(ui.toast, String(text ?? ''));
  ui.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.add('hidden'), 1600);
}

/* ============================== input =============================== */

function currentMove() {
  let dx = 0;
  let dy = 0;
  for (const c of keys) {
    const d = MOVE_DIR[c];
    if (d) { dx += d[0]; dy += d[1]; }
  }
  return { dx: clamp(dx, -1, 1), dy: clamp(dy, -1, 1) };
}

function sendMove(force = false) {
  const { dx, dy } = currentMove();
  const key = `${dx},${dy}`;
  if (!force && key === lastMove) return;
  lastMove = key;
  send({ t: 'move', dx, dy });
}

function castSlot(slot) {
  if (!state.skillBySlot[slot]) return;
  send({ t: 'cast', slot, target: state.target || 0 });
}

function toWorld(ev) {
  const r = ui.canvas.getBoundingClientRect();
  return { x: ev.clientX - r.left + state.cam.x, y: ev.clientY - r.top + state.cam.y };
}

function pickEntity(wx, wy, now) {
  let best = null;
  let bestD = Infinity;
  for (const e of state.ents.values()) {
    const p = posOf(e, now);
    const d = hypot(p.x, p.y, wx, wy);
    if (d <= (e.r || 14) + 2 && d < bestD) { best = e; bestD = d; }
  }
  return best;
}

function onKeyDown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (MOVE_DIR[e.code]) {
    e.preventDefault();
    if (!keys.has(e.code)) {
      keys.add(e.code);
      sendMove();
    }
    return;
  }
  if (e.repeat) return;
  if (e.code === 'KeyG') {
    state.showAOI = !state.showAOI;
    return;
  }
  const m = /^(?:Digit|Numpad)([1-5])$/.exec(e.code);
  if (m) castSlot(Number(m[1]));
}

function onKeyUp(e) {
  if (MOVE_DIR[e.code]) {
    keys.delete(e.code);
    sendMove();
  }
}

function releaseKeys() {
  keys.clear();
  sendMove(true);
}

/* ============================== boot ================================ */

function resize() {
  state.dpr = Math.min(window.devicePixelRatio || 1, 2);
  ui.canvas.width = Math.round(window.innerWidth * state.dpr);
  ui.canvas.height = Math.round(window.innerHeight * state.dpr);
}

function init() {
  ui.canvas = $('game');
  ctx = ui.canvas.getContext('2d');
  ui.selfName = $('self-name');
  ui.selfLv = $('self-lv');
  ui.selfHpFill = $('self-hp-fill');
  ui.selfHpText = $('self-hp-text');
  ui.selfExpFill = $('self-exp-fill');
  ui.selfExpText = $('self-exp-text');
  ui.baseAttrs = $('base-attrs');
  ui.derivedAttrs = $('derived-attrs');
  ui.buffs = $('buffs');
  ui.panelTarget = $('panel-target');
  ui.tgtName = $('tgt-name');
  ui.tgtLv = $('tgt-lv');
  ui.tgtHpFill = $('tgt-hp-fill');
  ui.tgtHpText = $('tgt-hp-text');
  ui.skillbar = $('skillbar');
  ui.conn = $('conn');
  ui.toast = $('toast');
  ui.death = $('death');
  ui.deathText = $('death-text');

  buildAttrRows();
  buildSkillBar();
  resize();
  window.addEventListener('resize', resize);

  ui.canvas.addEventListener('click', (ev) => {
    const w = toWorld(ev);
    const hit = pickEntity(w.x, w.y, performance.now());
    if (!hit) return;                       // empty ground does nothing
    state.target = hit.id;
    send({ t: 'target', target: hit.id });
  });
  ui.canvas.addEventListener('mousemove', (ev) => {
    const w = toWorld(ev);
    ui.canvas.style.cursor = pickEntity(w.x, w.y, performance.now()) ? 'pointer' : 'default';
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseKeys);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseKeys();
  });

  requestAnimationFrame(frame);
  loadProtocol().then((p) => {
    protocol = p;
    connect();
  }).catch((err) => {
    console.error(err);
    setConn('bad', '协议加载失败');
  });
}

init();
