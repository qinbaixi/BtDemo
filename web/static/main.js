/*
 * BtDemo browser client.
 * Sections: config · state · helpers · net · events · render · hud · input · boot
 */

/* ============================== config ============================== */

import { loadProtocol } from './protocol.js';
import { drawInked } from './ink.js';
import { drawModel as drawModelPlain } from './models.js';
import { createLighting } from './lighting.js';
import { FX } from './fx.js';
import { createScenery } from './scenery.js';
import { createDebug } from './debug.js';

const LERP_MS = 100;          // position interpolation window between 10 Hz syncs
const SNAP_DIST = 400;        // larger jumps snap instead of sliding
const ATTACK_MS = 380;       // attack swing animation
const HIT_MS = 260;          // hit reaction animation
const DEATH_MS = 650;        // fall-over animation
// Drawn height of each model at radius 16, used to place labels above heads.
// rim light colour per kind: gold heroes, blood-red monsters, spectral NPCs
const RIM = { player: '#ffcf6a', monster: '#ff3b2e', npc: '#6fe3ff' };
const MODEL_SCALE = 1.25;    // models are drawn a bit larger than their collision radius
const MODEL_H = { knight: 46, guard: 50, villager: 42, slime: 26, wolf: 30, skeleton_archer: 46, ogre_chief: 54 };
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
const NAME_COLOR = { player: '#f3e9d2', monster: '#ff7a6a', npc: '#8fe6ff' };
const MOVE_DIR = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};
const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Segoe UI",sans-serif';
const DISPLAY = '"Cinzel","Songti SC","Noto Serif CJK SC","Source Han Serif SC","STSong",serif';
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
  showAOI: false,
  fx: null,               // FX engine
  scenery: null,          // ground and props, built for the map size on welcome
  lands: new Map(),       // caster id -> { at, color } when its latest cast lands
  pending: [],            // [{ at, fn }] hit reactions waiting for a projectile
  lastFrame: 0,
  // full quality: ink outlines, rim light and dynamic lighting. ?low in the
  // URL starts without them, Q toggles, and a slow machine drops them itself.
  hq: !new URLSearchParams(location.search).has('low'),
  slowFrames: 0,
  slowGraceUntil: 0,   // after a manual Q toggle, don't judge the frame rate until then
  floats: [],
  bubbles: new Map(),     // id -> { text, until }
  cam: { x: 0, y: 0, w: 0, h: 0 },
  dpr: 1,
};
const keys = new Set();   // held KeyboardEvent.code values
const ui = { attr: {}, skillBtns: {} };
let ctx = null;
let ws = null;
let protocol = null; // set by loadProtocol() before the first connect
let debug = null;    // debug drawer
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
    model: d.model || '',
    // animation state
    facing: kind === 'player' ? 0 : (Math.random() < 0.5 ? 0 : Math.PI),
    walk: Math.random() * 6,
    moveUntil: 0,           // walking pose shows until this time
    rx: d.x || 0,           // rendered position last frame, drives the walk cycle
    ry: d.y || 0,
    attackAt: -1e9,
    hitAt: -1e9,
    deadAt: -1,
    fresh: true,            // no sync seen yet: an already-dead entity shows fallen
  };
}

// headY is the screen y just above an entity's drawn head.
function headY(e, p) {
  const s = ((e.r || 14) * MODEL_SCALE) / 16;
  return p.y - (MODEL_H[e.model] || 34) * s;
}

// faceToward turns an entity left or right toward a point.
function faceToward(e, x, y, now) {
  const p = posOf(e, now);
  if (Math.abs(x - p.x) > 2) e.facing = x < p.x ? Math.PI : 0;
}

// fxResolve lets the effect engine follow live entities (body centre).
function fxResolve(id) {
  const e = state.ents.get(id);
  if (!e) return null;
  const p = posOf(e, performance.now());
  return { x: p.x, y: p.y, r: e.r || 14 };
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
      for (const d of m.ents || []) {
        if (!state.ents.has(d.id)) state.ents.set(d.id, makeEntity(d, now));
      }
      break;
    case 'leave':
      for (const id of m.ids || []) {
        state.ents.delete(id);
        state.bubbles.delete(id);
        state.lands.delete(id);
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
  state.fx.clear();
  state.lands.clear();
  state.pending = [];
  state.floats = [];
  state.bubbles.clear();
  state.self = null;
  state.cds = {};
  state.target = 0;
  state.hoverSlot = 0;

  // the scene is painted once per distinct map (a reconnect usually gets the same one)
  const sceneKey = `${state.map.w}x${state.map.h}:${JSON.stringify(m.props || [])}`;
  if (!state.scenery || state.sceneKey !== sceneKey) {
    state.scenery = createScenery(state.map.w, state.map.h, m.props || []);
    state.sceneKey = sceneKey;
  }
  state.obstacles = m.obstacles || [];
  state.aiPath = null;

  buildSkillBar();
  debug.setTarget(0);
  debug.reset();
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
    const mdx = s.x - e.x;
    if (!jump && hypot(e.x, e.y, s.x, s.y) > 0.5) {
      e.moveUntil = now + LERP_MS * 1.6;
      if (Math.abs(mdx) > 0.3 && now - e.attackAt > ATTACK_MS) e.facing = mdx < 0 ? Math.PI : 0;
    }
    if (jump) { e.rx = s.x; e.ry = s.y; }
    if (s.dead && !e.dead) e.deadAt = e.fresh ? now - DEATH_MS : now;
    if (!s.dead) e.deadAt = -1;
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
    e.fresh = false;
  }
  if (m.self) {
    state.self = m.self;
    state.selfAt = now;
    state.cds = m.self.cds || {};
    state.cdsAt = now;
    renderSelf();
  }
  for (const ev of m.ev || []) onEvent(ev, now);
  if (m.ai) {
    debug.trace(m.ai);
    state.aiPath = m.ai.path.length >= 4 ? { id: m.ai.id, pts: m.ai.path, at: now } : null;
  }
}

/* ============================== events ============================== */

function onEvent(ev, now) {
  switch (ev.k) {
    case 'cast': {
      const src = state.ents.get(ev.src);
      if (src) {
        src.attackAt = now;
        const dst = ev.dst && ev.dst !== ev.src ? state.ents.get(ev.dst) : null;
        if (dst) { const dp = posOf(dst, now); faceToward(src, dp.x, dp.y, now); }
      }
      const delay = state.fx.cast(ev, now);
      state.lands.set(ev.src, { at: now + delay, color: ev.color });
      // name the skill for players and for the big moves of monsters
      const big = ev.fx === 'circle' || ev.fx === 'buff';
      if (ev.name && src && (src.kind === 'player' || big)) {
        addFloat(now, ev.src, String(ev.name), ev.color || '#ffffff', 13, 900, { rise: 22 });
      }
      break;
    }
    case 'dmg': {
      if (!ev.dst) break;
      const land = state.lands.get(ev.src);
      const at = land && land.at > now ? land.at : now;
      const color = land ? land.color : '#ffd166';
      const hit = () => {
        const t = performance.now();
        const e = state.ents.get(ev.dst);
        if (e) e.hitAt = t;
        state.fx.impact(ev.dst, color, ev.crit, t);
        if (ev.crit) addFloat(t, ev.dst, `暴击 ${ev.v}`, '#ffe14d', 26, 1100, { pop: true, rise: 54 });
        else addFloat(t, ev.dst, `-${ev.v}`, ev.dst === state.myId ? '#ff6b6b' : '#ffffff', 17, 900);
      };
      if (at > now) state.pending.push({ at, fn: hit });
      else hit();
      break;
    }
    case 'heal':
      addFloat(now, ev.dst, `+${ev.v}`, '#7cff9b', 18, 1000);
      break;
    case 'buff':
      addFloat(now, ev.dst, String(ev.name || ''), '#9ad7ff', 15, 1200, { rise: 50 });
      break;
    case 'die': {
      state.bubbles.delete(ev.id);
      const e = state.ents.get(ev.id);
      if (e && e.deadAt < 0) e.deadAt = now;
      state.fx.death(ev.id, e ? e.color : '#ffffff', now);
      break;
    }
    case 'respawn':
      state.fx.respawn(ev.id, now);
      addFloat(now, ev.id, '复活', '#7cff9b', 16, 1000);
      break;
    case 'say':
      state.bubbles.set(ev.id, { text: String(ev.text || ''), until: now + 3000 });
      break;
    case 'lvl':
      state.fx.levelUp(ev.id, now);
      addFloat(now, ev.id, `升级! Lv ${ev.lv}`, '#ffd54a', 26, 1600, { pop: true, rise: 60 });
      break;
  }
}

// Floating text above an entity (or at its last known position).
function addFloat(now, anchorId, text, color, size, life, opts = {}) {
  const e = state.ents.get(anchorId);
  if (!e) return;
  const p = posOf(e, now);
  // numbers landing together on one target fan out instead of piling up
  let recent = 0;
  for (const f of state.floats) if (f.anchor === anchorId && now - f.born < 300) recent++;
  state.floats.push({
    anchor: anchorId,
    x: p.x, y: p.y,
    oy: headY(e, p) - p.y - 16 - Math.min(recent, 4) * 13,
    jx: (recent % 2 ? 1 : -1) * Math.min(recent, 3) * 12 + (Math.random() - 0.5) * 10,
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
  const dt = state.lastFrame ? now - state.lastFrame : 16;
  state.lastFrame = now;
  watchFrameRate(dt);
  runPending(now);
  debug.setTarget(state.target);
  debug.update(now);
  updateCamera(now);
  draw(now, dt);
  renderTarget();
  renderSkillBar(now);
  renderDeath(now);
}

// watchFrameRate switches to simple rendering after ~3 s below ~30 fps.
function watchFrameRate(dt) {
  if (!state.hq || document.hidden || performance.now() < state.slowGraceUntil) return;
  state.slowFrames = dt > 34 && dt < 500 ? state.slowFrames + 1 : Math.max(0, state.slowFrames - 2);
  if (state.slowFrames > 90) {
    state.hq = false;
    showToast('帧率偏低，已切换为简化画质（按 Q 切回）');
  }
}

function runPending(now) {
  if (!state.pending.length) return;
  const due = state.pending.filter((p) => p.at <= now);
  if (!due.length) return;
  state.pending = state.pending.filter((p) => p.at > now);
  for (const p of due) p.fn();
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

function draw(now, dt) {
  const { x: cx, y: cy, w: vw, h: vh } = state.cam;
  const dpr = state.dpr;
  const shake = state.fx.shakeOffset(dt);
  // World units are CSS pixels; the camera offset is applied in the transform.
  ctx.setTransform(dpr, 0, 0, dpr, (-cx + shake.x) * dpr, (-cy + shake.y) * dpr);
  ctx.fillStyle = '#07050c';
  ctx.fillRect(cx - 20, cy - 20, vw + 40, vh + 40);

  const me = state.ents.get(state.myId);
  const mp = me ? posOf(me, now) : null;
  const view = state.cam;

  if (state.scenery) state.scenery.drawGround(ctx, view);
  if (state.showAOI) drawAOI(mp);
  drawBorder();

  if (mp && state.hoverSlot) drawRangePreview(mp);
  const tgt = state.ents.get(state.target);
  if (tgt) drawTargetRing(tgt, now);
  state.fx.drawUnder(ctx, now);

  // characters and props share one depth order by their feet
  const list = [];
  for (const e of state.ents.values()) {
    const p = posOf(e, now);
    // a corpse lies flat, so it sorts behind anything standing on it
    list.push({ y: p.y - (e.dead ? 30 : 0), e, p });
  }
  if (state.scenery) for (const pr of state.scenery.visible(view)) list.push({ y: pr.y, prop: pr });
  list.sort((a, b) => a.y - b.y);
  for (const it of list) {
    if (it.prop) state.scenery.drawProp(ctx, it.prop, now, mp);
    else drawEntity(it.e, it.p, now);
  }

  if (state.hq) drawLights(now, mp, shake);
  state.fx.drawOver(ctx, now, dt);
  if (state.scenery) state.scenery.drawAmbient(ctx, view, now);
  ctx.setTransform(dpr, 0, 0, dpr, (-cx + shake.x) * dpr, (-cy + shake.y) * dpr);
  if (tgt && mp && tgt.id !== state.myId) drawTargetLink(tgt, mp, now);
  if (state.showAOI) drawObstacles();
  if (debug.open) drawAiPath(now);
  for (const it of list) if (it.e) drawLabels(it.e, it.p, now);
  drawBubbles(now);
  drawFloats(now);
  drawVignette();
}

// drawLights darkens the world and lets the light sources burn through.
function drawLights(now, mp, shake) {
  const L = state.lighting;
  L.begin();
  const add = (x, y, r, c, s, g) => L.add(x, y, r, c, s, g);
  if (mp) add(mp.x, mp.y - 10, 300, '#ffd9a0', 1, 0.18);
  for (const e of state.ents.values()) {
    if (e.id === state.myId || e.dead || e.kind !== 'player') continue;
    const p = posOf(e, now);
    add(p.x, p.y - 10, 170, '#ffd9a0', 0.8, 0.1);
  }
  if (state.scenery) state.scenery.lights(add, state.cam, now);
  state.fx.lights(add, now);
  // the lightmap follows the world, screen shake included
  const c = state.cam;
  L.render(ctx, { x: c.x - shake.x, y: c.y - shake.y, w: c.w, h: c.h }, state.dpr);
}

function drawVignette() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  if (!state.vignette || state.vignette.w !== w || state.vignette.h !== h) {
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(6,2,12,0.7)');
    state.vignette = { w, h, g };
  }
  ctx.fillStyle = state.vignette.g;
  ctx.fillRect(0, 0, w, h);
}

function drawBorder() {
  const { w, h } = state.map;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,213,74,0.35)';
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

// drawObstacles outlines the server's collision shapes (with the AOI grid, G).
function drawObstacles() {
  const v = state.cam;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,96,72,0.95)';
  ctx.fillStyle = 'rgba(255,60,40,0.24)';
  for (const o of state.obstacles) {
    const r = o.r || 0;
    const x0 = Math.min(o.ax, o.bx ?? o.ax) - r;
    const x1 = Math.max(o.ax, o.bx ?? o.ax) + r;
    const y0 = Math.min(o.ay, o.by ?? o.ay) - r;
    const y1 = Math.max(o.ay, o.by ?? o.ay) + r;
    if (x1 < v.x || x0 > v.x + v.w || y1 < v.y || y0 > v.y + v.h) continue;
    ctx.beginPath();
    if (o.shape === 'rect') {
      ctx.rect(o.ax, o.ay, o.bx - o.ax, o.by - o.ay);
    } else if (o.shape === 'capsule') {
      const a = Math.atan2(o.by - o.ay, o.bx - o.ax);
      ctx.arc(o.ax, o.ay, r, a + Math.PI / 2, a + Math.PI * 1.5);
      ctx.arc(o.bx, o.by, r, a - Math.PI / 2, a + Math.PI / 2);
      ctx.closePath();
    } else {
      ctx.arc(o.ax, o.ay, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// drawAiPath draws the route of the monster or NPC the debug drawer watches.
function drawAiPath(now) {
  const ap = state.aiPath;
  if (!ap || now - ap.at > 1500) return;
  const e = state.ents.get(ap.id);
  const pts = ap.pts.slice();
  if (e) [pts[0], pts[1]] = [posOf(e, now).x, posOf(e, now).y];
  ctx.save();
  ctx.setLineDash([10, 7]);
  ctx.lineDashOffset = -now / 40;
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(120,230,255,0.9)';
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(120,230,255,0.95)';
  for (let i = 2; i < pts.length; i += 2) {
    ctx.beginPath();
    ctx.arc(pts[i], pts[i + 1], i === pts.length - 2 ? 6 : 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
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

// drawTargetRing marks the selected entity with a rotating ring at its feet.
function drawTargetRing(tgt, now) {
  const tp = posOf(tgt, now);
  const r = (tgt.r || 14) + 9;
  const hostile = tgt.kind === 'monster';
  const color = hostile ? '255,90,80' : '120,200,255';
  ctx.save();
  ctx.translate(tp.x, tp.y);
  ctx.scale(1, 0.42);
  ctx.lineWidth = 3;
  ctx.strokeStyle = `rgba(${color},0.35)`;
  ctx.beginPath();
  ctx.arc(0, 0, r + 3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.rotate(now / 600);
  ctx.strokeStyle = `rgba(${color},0.95)`;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(0, 0, r, a, a + 1.3);
    ctx.stroke();
  }
  ctx.restore();
}

// drawTargetLink draws a faint dotted line from the player to the target.
function drawTargetLink(tgt, mp, now) {
  const tp = posOf(tgt, now);
  ctx.save();
  ctx.setLineDash([2, 7]);
  ctx.lineDashOffset = -now / 40;
  ctx.lineCap = 'round';
  ctx.strokeStyle = tgt.kind === 'monster' ? 'rgba(255,120,100,0.45)' : 'rgba(140,210,255,0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mp.x, mp.y - 4);
  ctx.lineTo(tp.x, tp.y - 4);
  ctx.stroke();
  ctx.restore();
}

function drawEntity(e, p, now) {
  // walk cycle advances with the distance actually drawn this frame
  const moved = hypot(e.rx, e.ry, p.x, p.y);
  e.rx = p.x;
  e.ry = p.y;
  if (moved < 40) e.walk += moved * 0.16 * (16 / (e.r || 14));

  const atk = (now - e.attackAt) / ATTACK_MS;
  const hit = (now - e.hitAt) / HIT_MS;
  const r = (e.r || 14) * MODEL_SCALE;
  const isSelf = e.id === state.myId;
  // hard ink shadow on the ground, and a gold sigil under the hero
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, r * 1.05, r * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  if (isSelf && !e.dead) {
    ctx.translate(p.x, p.y);
    ctx.scale(1, 0.42);
    ctx.rotate(now / 2400);
    ctx.strokeStyle = 'rgba(255,207,106,0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, r + 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,207,106,0.9)';
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      ctx.save();
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(r + 12, -4); ctx.lineTo(r + 18, 0); ctx.lineTo(r + 12, 4); ctx.lineTo(r + 6, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();
  const pose = {
    x: p.x,
    y: p.y,
    r,
    color: e.color,
    facing: e.facing,
    walk: e.walk,
    moving: now < e.moveUntil && !e.dead,
    attack: atk >= 0 && atk < 1 && !e.dead ? atk : -1,
    hit: hit >= 0 && hit < 1 ? hit : -1,
    dead: e.dead ? clamp((now - (e.deadAt < 0 ? now - DEATH_MS : e.deadAt)) / DEATH_MS, 0, 1) : -1,
    time: now + e.id * 397,
    isSelf,
  };
  if (state.hq) drawInked(ctx, e.model, pose, state.dpr, RIM[e.kind], e.ink || (e.ink = {}), now);
  else {
    drawModelPlain(ctx, e.model, { ...pose, bare: true });
    if (pose.dead < 0 && pose.hit >= 0 && pose.hit < 0.35) {
      // cheap hit flash for low quality: the model again, added on top
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 * (1 - pose.hit / 0.35);
      drawModelPlain(ctx, e.model, { ...pose, bare: true });
      ctx.restore();
    }
  }
}

// drawLabels draws name, level, HP bar, behaviour and aggro mark over a head.
function drawLabels(e, p, now) {
  const dead = e.dead;
  const isSelf = e.id === state.myId;
  if (dead && !isSelf && e.id !== state.target) return;   // corpses stay unlabelled
  const top = headY(e, p);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';

  let y = top - 6;
  if (!dead) {
    const bw = Math.max(40, (e.r || 14) * 2.6);
    const bh = 5;
    const bx = p.x - bw / 2;
    const by = y - bh;
    const frac = e.maxHp > 0 ? clamp(e.hp / e.maxHp, 0, 1) : 0;
    // slanted ink frame with a hairline of gold, like the HUD
    const slant = (x, w, yy, h) => {
      ctx.beginPath();
      ctx.moveTo(x + 3, yy); ctx.lineTo(x + w + 3, yy); ctx.lineTo(x + w, yy + h); ctx.lineTo(x, yy + h);
      ctx.closePath();
    };
    slant(bx - 2, bw + 4, by - 2, bh + 4);
    ctx.fillStyle = '#07040a';
    ctx.fill();
    ctx.strokeStyle = 'rgba(224,178,90,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    const c = isSelf ? '#e8b65a' : e.kind === 'monster' ? '#e0291f' : e.kind === 'npc' ? '#3fc6e8' : '#7bd88f';
    if (frac > 0) {
      slant(bx, bw * frac, by, bh);
      ctx.fillStyle = c;
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillRect(bx + 2, by + 0.5, Math.max(0, bw * frac - 3), 1.3);
    }
    y = by - 4;
  }

  ctx.font = `bold 12px ${DISPLAY}`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  let nameColor = NAME_COLOR[e.kind] || '#ffffff';
  if (isSelf) nameColor = '#ffd54a';
  if (dead) nameColor = '#9aa39e';
  const name = e.name;
  const lv = `Lv${fmt(e.lv)}`;
  ctx.font = `bold 12px ${DISPLAY}`;
  const nw = ctx.measureText(name).width;
  ctx.font = `bold 10px ${FONT}`;
  const lw = ctx.measureText(lv).width;
  const x0 = p.x - (nw + lw + 4) / 2;
  ctx.textAlign = 'left';
  ctx.strokeText(lv, x0, y);
  ctx.fillStyle = dead ? '#7d857f' : '#c9d2cc';
  ctx.fillText(lv, x0, y);
  ctx.font = `bold 12px ${DISPLAY}`;
  ctx.strokeText(name, x0 + lw + 4, y);
  ctx.fillStyle = nameColor;
  ctx.fillText(name, x0 + lw + 4, y);
  ctx.textAlign = 'center';

  if (e.kind !== 'player' && e.act && !dead) {
    ctx.font = `11px ${FONT}`;
    ctx.lineWidth = 2.5;
    const label = ACT_NAMES[e.act] || e.act;
    ctx.strokeText(label, p.x, p.y + 15);
    ctx.fillStyle = 'rgba(214,224,218,0.85)';
    ctx.fillText(label, p.x, p.y + 15);
  }

  if (e.kind === 'monster' && e.tg === state.myId && !dead) {
    const bob = Math.sin(now / 140) * 2;
    ctx.font = `900 18px ${FONT}`;
    ctx.lineWidth = 4;
    ctx.strokeText('!', p.x, y - 16 + bob);
    ctx.fillStyle = '#ff3b3b';
    ctx.fillText('!', p.x, y - 16 + bob);
  }
  ctx.restore();
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
    const y = headY(e, p) - 48 - h;
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
    // hit-test the drawn body, which stands above the feet position
    const half = (p.y - headY(e, p)) / 2;
    const d = hypot(p.x, p.y - half, wx, wy);
    if (d <= Math.max((e.r || 14) + 4, half) && d < bestD) { best = e; bestD = d; }
  }
  return best;
}

function onKeyDown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // typing in a text box (the protocol filter) must not move or cast
  const t = e.target;
  if (t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !['checkbox', 'button'].includes(t.type))) return;
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
  if (e.code === 'KeyQ') {
    state.hq = !state.hq;
    state.slowFrames = 0;
    state.slowGraceUntil = performance.now() + 10000;   // give the full look 10 s before judging again
    showToast(state.hq ? '画质：完整（描边 + 光照）' : '画质：简化');
    return;
  }
  if (e.code === 'Backquote') {
    debug.toggle();
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

  state.fx = new FX(fxResolve);
  state.lighting = createLighting();
  debug = createDebug({ send, entity: (id) => state.ents.get(id) });
  window.btdemo = { state };   // for poking around in the browser console
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
    p.tap = (dir, type, bytes, obj) => debug.frame(dir, type, bytes, obj);
    connect();
  }).catch((err) => {
    console.error(err);
    setConn('bad', '协议加载失败');
  });
}

init();
