// 叠在 WebGL 画布上面的 2D 画布：头顶文字（名字、血条、气泡、飘字）、调试线条（碰撞体、AI 路径）和暗角。
// 这些在光照和后期处理之上，不发光、不调色，文字用 Canvas 2D 画更清晰。

import { ACT_NAMES, DISPLAY, FONT, NAME_COLOR } from '../game/config';
import { clamp, fmt } from '../game/math';
import { headY, posOf, state, type ClientEntity, type Point } from '../game/state';

let ctx: CanvasRenderingContext2D;
let canvas: HTMLCanvasElement;

export function initOverlay(c: HTMLCanvasElement): void {
  canvas = c;
  ctx = c.getContext('2d')!;
}

export function resizeOverlay(dpr: number): void {
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
}

/**
 * drawOverlay 画一帧叠加层。shake 是屏幕震动偏移，ents 是本帧可见实体和它们的绘制位置。
 * 顺序：（特效 → 环境粒子）→ 目标连线 → 碰撞体 → AI 路径 → 头顶文字 → 气泡 → 飘字 → 暗角。
 * withFx：特效和环境粒子也画在这里。开后期处理时它们在 Pixi 里画（world.ts 的 drawOverFx），这样能参与泛光。
 */
export function drawOverlay(
  now: number, dt: number, shake: Point, mp: Point | null, ents: { e: ClientEntity; p: Point }[], debugOpen: boolean,
  withFx: boolean,
): void {
  const { x: cx, y: cy } = state.cam;
  const dpr = state.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, (-cx + shake.x) * dpr, (-cy + shake.y) * dpr);
  if (withFx) {
    state.fx.drawOver(ctx, now, dt);
    if (state.scenery) state.scenery.drawAmbient(ctx, state.cam, now);
    ctx.setTransform(dpr, 0, 0, dpr, (-cx + shake.x) * dpr, (-cy + shake.y) * dpr);
  }
  const tgt = state.ents.get(state.target);
  if (tgt && mp && tgt.id !== state.myId) drawTargetLink(tgt, mp, now);
  if (state.showAOI) { drawObstacles(); drawAOILabel(mp); }
  if (debugOpen) drawAiPath(now);
  for (const it of ents) drawLabels(it.e, it.p, now);
  drawBubbles(now);
  drawFloats(now);
  drawVignette();
}

// drawAOILabel 在九宫格视野框的左上角写“AOI 视野”（网格和框在 WebGL 层画）。
function drawAOILabel(mp: Point | null): void {
  if (!mp) return;
  const c = state.cell;
  const x0 = clamp((Math.floor(mp.x / c) - 1) * c, 0, state.map.w);
  const y0 = clamp((Math.floor(mp.y / c) - 1) * c, 0, state.map.h);
  ctx.font = `bold 13px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(160,220,255,0.9)';
  ctx.fillText('AOI 视野', x0 + 8, y0 + 18);
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
