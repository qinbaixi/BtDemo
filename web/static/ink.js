// Ink renderer: draws a model the way a hand-inked comic panel would, in the
// spirit of Hades. Each character is rendered into an offscreen sprite and
// composited with
//   1. a heavy black silhouette outline around the whole figure,
//   2. the model itself,
//   3. a coloured rim light along its upper-left edge (gold for players,
//      blood red for monsters, spectral cyan for NPCs).
// Ground shadow and selection rings are drawn by the caller underneath.

import { drawModel } from './models.js';

const OUTLINE_PX = 2.2;          // outline thickness in CSS px
const RIM_SHIFT = 2.4;           // how far the rim band reaches inward, CSS px

// A small pool of sprite canvases, reused every frame.
class Layer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
  }
  size(w, h) {
    if (this.canvas.width < w || this.canvas.height < h) {
      this.canvas.width = Math.max(this.canvas.width, w);
      this.canvas.height = Math.max(this.canvas.height, h);
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.globalAlpha = 1;
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.clearRect(0, 0, w, h);
  }
}

const body = new Layer();
const ink = new Layer();
const rim = new Layer();

// Characters are re-inked at most this often and the last sprite is reused in
// between; motion stays smooth because the sprite still follows the
// interpolated position every frame. Hand-drawn animation runs at a similar
// rate, and it cuts the cost of the outline and rim passes by two thirds.
const REDRAW_MS = 1000 / 24;

const OFFSETS = [];
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  OFFSETS.push([Math.cos(a), Math.sin(a)]);
}

/**
 * drawInked draws model at p (see drawModel) onto ctx.
 *   scale   device pixels per CSS pixel of ctx (camera transform scale)
 *   rimColor colour of the rim light, or null for none
 *   cache    an object owned by the entity that keeps its last sprite
 *   now      frame time in ms
 */
export function drawInked(ctx, model, p, scale, rimColor, cache, now) {
  const r = p.r || 14;
  const k = scale;
  if (cache.out && now - cache.at < REDRAW_MS && cache.k === k && cache.r === r && cache.dead === (p.dead >= 0)) {
    blitSprite(ctx, cache, p);
    return;
  }
  // box wide enough for weapons and the fall-over death pose
  const w = Math.ceil(r * 6 * k);
  const h = Math.ceil(r * 4.8 * k);
  const footX = w / 2;
  const footY = h - Math.ceil(r * 1.3 * k);

  // 1) model
  body.size(w, h);
  const b = body.ctx;
  b.setTransform(k, 0, 0, k, footX, footY);
  drawModel(b, model, { ...p, x: 0, y: 0, bare: true });

  // 2) silhouette in ink
  ink.size(w, h);
  const g = ink.ctx;
  g.drawImage(body.canvas, 0, 0, w, h, 0, 0, w, h);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = '#07040a';
  g.fillRect(0, 0, w, h);

  // 3) rim band: the silhouette minus itself shifted down-right
  let hasRim = false;
  if (rimColor && p.dead < 0) {
    rim.size(w, h);
    const q = rim.ctx;
    q.drawImage(body.canvas, 0, 0, w, h, 0, 0, w, h);
    q.globalCompositeOperation = 'source-in';
    q.fillStyle = rimColor;
    q.fillRect(0, 0, w, h);
    q.globalCompositeOperation = 'destination-out';
    q.drawImage(body.canvas, 0, 0, w, h, RIM_SHIFT * k * 0.8, RIM_SHIFT * k, w, h);
    hasRim = true;
  }

  // 4) compose outline, body and rim into the entity's sprite
  if (!cache.out) cache.out = new Layer();
  const out = cache.out;
  out.size(w, h);
  const o = out.ctx;
  // the outline copies stack up, so a fading corpse gets a faint one
  if (p.dead >= 0) o.globalAlpha = 0.18;
  const d = OUTLINE_PX * k;
  for (const [ox, oy] of OFFSETS) o.drawImage(ink.canvas, 0, 0, w, h, ox * d, oy * d, w, h);
  o.globalAlpha = 1;
  o.drawImage(body.canvas, 0, 0, w, h, 0, 0, w, h);
  if (hasRim) {
    o.globalCompositeOperation = 'lighter';
    o.globalAlpha = 0.75;
    o.drawImage(rim.canvas, 0, 0, w, h, 0, 0, w, h);
  }
  Object.assign(cache, { at: now, k, r, dead: p.dead >= 0, w, h, footX, footY });
  blitSprite(ctx, cache, p);
}

function blitSprite(ctx, c, p) {
  ctx.drawImage(c.out.canvas, 0, 0, c.w, c.h, p.x - c.footX / c.k, p.y - c.footY / c.k, c.w / c.k, c.h / c.k);
}
