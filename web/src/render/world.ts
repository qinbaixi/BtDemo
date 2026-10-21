// 用 Canvas 2D 画世界：地表、物件、实体、特效、光照、头顶文字。
// 第二步换 Pixi 时整个替换这个文件；HUD 在 ui/hud.ts，不在这里。

import { ACT_NAMES, ATTACK_MS, DEATH_MS, DISPLAY, FONT, HIT_MS, MODEL_SCALE, NAME_COLOR, RIM } from '../game/config';
import { clamp, fmt, hypot } from '../game/math';
import { headY, posOf, state, type ClientEntity, type Point } from '../game/state';
import { drawInked } from './ink';
import { drawModel as drawModelPlain } from './models';

let ctx: CanvasRenderingContext2D;

export function initWorld(canvas: HTMLCanvasElement): void {
  ctx = canvas.getContext('2d')!;
}

// resize 让画布跟窗口和设备像素比一致。
export function resize(canvas: HTMLCanvasElement): void {
  state.dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * state.dpr);
  canvas.height = Math.round(window.innerHeight * state.dpr);
}

export function updateCamera(now: number): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { w, h } = state.map;
  const me = state.ents.get(state.myId);
  const p = me ? posOf(me, now) : { x: w / 2, y: h / 2 };
  const x = w <= vw ? (w - vw) / 2 : clamp(p.x - vw / 2, 0, w - vw);
  const y = h <= vh ? (h - vh) / 2 : clamp(p.y - vh / 2, 0, h - vh);
  state.cam = { x, y, w: vw, h: vh };
}

function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// drawWorld 画一帧。debugOpen 时额外画被观察实体的 AI 路径。
export function drawWorld(now: number, dt: number, debugOpen: boolean): void {
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
  const list: { y: number; e?: ClientEntity; p?: Point; prop?: any }[] = [];
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
  if (debugOpen) drawAiPath(now);
  for (const it of list) if (it.e) drawLabels(it.e, it.p, now);
  drawBubbles(now);
  drawFloats(now);
  drawVignette();
}

// drawLights darkens the world and lets the light sources burn through.
function drawLights(now: number, mp: Point | null, shake: Point): void {
  const L = state.lighting;
  L.begin();
  const add = (x: number, y: number, r: number, c: string, s: number, g: number) => L.add(x, y, r, c, s, g);
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

function drawVignette(): void {
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

function drawBorder(): void {
  const { w, h } = state.map;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,213,74,0.35)';
  ctx.strokeRect(0, 0, w, h);
}

function drawAOI(mp: Point | null): void {
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
function drawObstacles(): void {
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
function drawAiPath(now: number): void {
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

function drawRangePreview(mp: Point): void {
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
function drawTargetRing(tgt: ClientEntity, now: number): void {
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
function drawTargetLink(tgt: ClientEntity, mp: Point, now: number): void {
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

function drawEntity(e: ClientEntity, p: Point, now: number): void {
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
function drawLabels(e: ClientEntity, p: Point, now: number): void {
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
    const slant = (x: number, w: number, yy: number, h: number) => {
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

function drawBubbles(now: number): void {
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

function drawFloats(now: number): void {
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
