// Skill and combat effects. Everything lives in world coordinates and is
// drawn in two passes: drawUnder() for ground decals below the characters and
// drawOver() for slashes, projectiles and particles above them.
//
// Glows use cached radial-gradient sprites blended with 'lighter' instead of
// shadowBlur, which keeps a busy fight cheap.

const TAU = Math.PI * 2;
const MAX_PARTICLES = 900;

const clamp01 = (t) => Math.max(0, Math.min(1, t));
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const rand = (a, b) => a + Math.random() * (b - a);

/* ------------------------------ colour ------------------------------ */

function rgbOf(hex) {
  let c = typeof hex === 'string' ? hex.replace('#', '') : '';
  if (c.length === 3) c = c.split('').map((ch) => ch + ch).join('');
  if (!/^[0-9a-f]{6}$/i.test(c)) return [255, 255, 255];
  const n = parseInt(c, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba([r, g, b], a) {
  return `rgba(${r},${g},${b},${a})`;
}

// mix moves a colour toward white by k (0..1).
function whiten([r, g, b], k) {
  return [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k].map((v) => v | 0);
}

const spriteCache = new Map();

// glow returns a soft round sprite: white-hot core fading through the colour.
function glow(hex) {
  let s = spriteCache.get(hex);
  if (s) return s;
  const c = rgbOf(hex);
  const size = 64;
  s = document.createElement('canvas');
  s.width = s.height = size;
  const g = s.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, rgba(whiten(c, 0.85), 1));
  grad.addColorStop(0.18, rgba(whiten(c, 0.35), 0.9));
  grad.addColorStop(0.45, rgba(c, 0.35));
  grad.addColorStop(1, rgba(c, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  spriteCache.set(hex, s);
  return s;
}

function blit(ctx, sprite, x, y, r, alpha) {
  if (alpha <= 0.01 || r <= 0.2) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(sprite, x - r, y - r, r * 2, r * 2);
}

/* ------------------------------ engine ------------------------------ */

export class FX {
  // resolve(id) returns the live {x, y, r} of an entity, or null.
  constructor(resolve) {
    this.resolve = resolve;
    this.effects = [];
    this.parts = [];
    this.shake = 0;          // screen shake strength in px, decays
  }

  clear() {
    this.effects.length = 0;
    this.parts.length = 0;
    this.shake = 0;
  }

  pos(id, fallback) {
    const e = id ? this.resolve(id) : null;
    return e || fallback;
  }

  // cast starts the visual for a CAST event. It returns how many ms until the
  // effect "lands", so the caller can delay hit numbers to match.
  cast(ev, now) {
    const color = ev.color || '#ffffff';
    const src = this.pos(ev.src, { x: ev.x || 0, y: ev.y || 0, r: 14 });
    const dst = ev.dst ? this.pos(ev.dst, src) : src;
    const base = { src: ev.src || 0, dst: ev.dst || 0, color, rgb: rgbOf(color), born: now,
      sx: src.x, sy: src.y, sr: src.r || 14, dx: dst.x, dy: dst.y, dr: dst.r || 14 };
    switch (ev.fx) {
      case 'projectile': {
        const dist = Math.hypot(dst.x - src.x, dst.y - src.y);
        const life = Math.max(140, Math.min(420, dist / 0.9));
        const arrow = /arrow/.test(ev.skill || '');
        this.effects.push({ ...base, kind: arrow ? 'arrow' : 'orb', life, trailAt: now });
        return life;
      }
      case 'circle': {
        const cx = typeof ev.x === 'number' ? ev.x : src.x;
        const cy = typeof ev.y === 'number' ? ev.y : src.y;
        const radius = ev.radius || 100;
        this.effects.push({ ...base, kind: 'whirl', cx, cy, radius, life: 620 });
        for (let i = 0; i < 26; i++) {
          const a = rand(0, TAU);
          const sp = rand(0.18, 0.42);
          this.spawn({ x: cx + Math.cos(a) * 12, y: cy + Math.sin(a) * 6, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.55 - 0.05,
            life: rand(380, 620), size: rand(2.5, 5), color, drag: 0.996, kind: 'glow', born: now + rand(0, 120) });
        }
        this.shake = Math.max(this.shake, radius > 110 ? 7 : 4);
        return 120;
      }
      case 'heal':
        this.effects.push({ ...base, kind: 'heal', life: 1100 });
        for (let i = 0; i < 18; i++) {
          this.spawn({ anchor: ev.src, ox: rand(-16, 16), oy: rand(-6, 6), vx: 0, vy: -rand(0.03, 0.07),
            life: rand(700, 1100), size: rand(3, 5.5), color, kind: i % 3 ? 'glow' : 'plus', born: now + rand(0, 450) });
        }
        return 0;
      case 'buff':
        this.effects.push({ ...base, kind: 'buff', life: 1000 });
        for (let i = 0; i < 22; i++) {
          const a = rand(0, TAU);
          this.spawn({ anchor: ev.src, ox: Math.cos(a) * rand(10, 20), oy: Math.sin(a) * rand(4, 8),
            vx: 0, vy: -rand(0.06, 0.13), life: rand(500, 900), size: rand(2, 4), color, kind: 'spark', born: now + rand(0, 400) });
        }
        return 0;
      default: { // melee
        const heavy = /heavy|smash|pounce/.test(ev.skill || '');
        this.effects.push({ ...base, kind: 'slash', life: heavy ? 340 : 260, heavy,
          flip: Math.random() < 0.5 ? 1 : -1 });
        return heavy ? 120 : 90;
      }
    }
  }

  // impact bursts sparks on an entity that just took a hit.
  impact(id, color, crit, now) {
    const p = this.pos(id, null);
    if (!p) return;
    const c = color || '#ffd166';
    const y = p.y - (p.r || 14) * 1.1;
    const n = crit ? 22 : 11;
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const sp = rand(0.15, crit ? 0.55 : 0.38);
      this.spawn({ x: p.x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.05, grav: 0.0009,
        life: rand(220, 420), size: rand(1.6, 3), color: i % 2 ? c : '#ffffff', kind: 'spark', drag: 0.985, born: now });
    }
    this.effects.push({ kind: 'flare', x: p.x, y, color: crit ? '#ffe14d' : c, rgb: rgbOf(crit ? '#ffe14d' : c),
      size: crit ? 46 : 28, crit, born: now, life: crit ? 300 : 200 });
    if (crit) this.shake = Math.max(this.shake, 5);
  }

  death(id, color, now) {
    const p = this.pos(id, null);
    if (!p) return;
    const r = p.r || 14;
    for (let i = 0; i < 14; i++) {
      const a = rand(0, TAU);
      this.spawn({ x: p.x + Math.cos(a) * r * 0.8, y: p.y + Math.sin(a) * r * 0.3, vx: Math.cos(a) * 0.06,
        vy: -rand(0.0, 0.04), life: rand(500, 800), size: rand(6, 11), color: '#9c9486', kind: 'dust', born: now });
    }
    for (let i = 0; i < 6; i++) {
      this.spawn({ x: p.x + rand(-8, 8), y: p.y - r, vx: rand(-0.02, 0.02), vy: -rand(0.04, 0.07),
        life: rand(900, 1400), size: rand(4, 7), color: '#cfe8ff', kind: 'wisp', born: now + i * 90 });
    }
    this.effects.push({ kind: 'ring', x: p.x, y: p.y, color: color || '#ffffff', rgb: rgbOf(color || '#ffffff'),
      radius: r * 3, born: now, life: 500 });
  }

  respawn(id, now) {
    const p = this.pos(id, null);
    if (!p) return;
    this.effects.push({ kind: 'pillar', anchor: id, x: p.x, y: p.y, color: '#bff5ff', rgb: rgbOf('#bff5ff'),
      height: 150, born: now, life: 900 });
  }

  levelUp(id, now) {
    const p = this.pos(id, null);
    if (!p) return;
    this.effects.push({ kind: 'pillar', anchor: id, x: p.x, y: p.y, color: '#ffd54a', rgb: rgbOf('#ffd54a'),
      height: 190, born: now, life: 1300 });
    this.effects.push({ kind: 'ring', x: p.x, y: p.y, color: '#ffd54a', rgb: rgbOf('#ffd54a'), radius: 90, born: now, life: 700 });
    for (let i = 0; i < 40; i++) {
      const a = rand(0, TAU);
      const sp = rand(0.05, 0.22);
      this.spawn({ anchor: id, ox: Math.cos(a) * 14, oy: Math.sin(a) * 6, vx: Math.cos(a) * sp, vy: -rand(0.08, 0.25),
        grav: 0.00025, life: rand(700, 1300), size: rand(1.8, 3.4), color: i % 3 ? '#ffd54a' : '#fff6c9', kind: 'spark', born: now + rand(0, 300) });
    }
  }

  spawn(p) {
    if (this.parts.length >= MAX_PARTICLES) this.parts.shift();
    p.ax = 0; p.ay = 0;        // accumulated offset for anchored particles
    p.drag = p.drag ?? 1;
    p.grav = p.grav ?? 0;
    this.parts.push(p);
  }

  // shakeOffset returns this frame's camera jitter and decays it.
  shakeOffset(dt) {
    if (this.shake < 0.2) { this.shake = 0; return { x: 0, y: 0 }; }
    const s = this.shake;
    this.shake *= Math.pow(0.0025, dt / 1000);
    return { x: rand(-s, s), y: rand(-s, s) };
  }

  /* ----------------------------- passes ----------------------------- */

  drawUnder(ctx, now) {
    ctx.save();
    for (const f of this.effects) {
      const t = (now - f.born) / f.life;
      if (t < 0 || t >= 1) continue;
      switch (f.kind) {
        case 'whirl': this.whirlGround(ctx, f, t); break;
        case 'heal': this.healGround(ctx, f, t); break;
        case 'buff': this.buffGround(ctx, f, t); break;
        case 'ring': this.ring(ctx, f, t); break;
        case 'pillar': this.pillarGround(ctx, f, t); break;
      }
    }
    ctx.restore();
  }

  drawOver(ctx, now, dt) {
    // Projectiles burst once on arrival, even if no frame fell near their end.
    for (const f of this.effects) {
      if ((f.kind === 'orb' || f.kind === 'arrow') && !f.landed && now - f.born >= f.life * 0.95) {
        f.landed = true;
        const dp = this.pos(f.dst, { x: f.dx, y: f.dy, r: f.dr });
        this.burst(dp.x, dp.y - (dp.r || 14), f.color, f.kind === 'orb' ? 16 : 8, now);
      }
    }
    this.effects = this.effects.filter((f) => now - f.born < f.life);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const f of this.effects) {
      const t = (now - f.born) / f.life;
      if (t < 0) continue;
      switch (f.kind) {
        case 'slash': this.slash(ctx, f, t); break;
        case 'orb': this.orb(ctx, f, t, now); break;
        case 'arrow': this.arrow(ctx, f, t, now); break;
        case 'whirl': this.whirlTop(ctx, f, t); break;
        case 'flare': this.flare(ctx, f, t); break;
        case 'pillar': this.pillar(ctx, f, t); break;
        case 'buff': this.buffTop(ctx, f, t); break;
      }
    }
    this.particles(ctx, now, dt);
    ctx.restore();
  }

  /* --------------------------- effect kinds -------------------------- */

  slash(ctx, f, t) {
    const sp = this.pos(f.src, { x: f.sx, y: f.sy, r: f.sr });
    const dp = this.pos(f.dst, { x: f.dx, y: f.dy, r: f.dr });
    const cy = sp.y - (sp.r || 14) * 0.9;
    const ang = Math.atan2(dp.y - (dp.r || 14) * 0.9 - cy, dp.x - sp.x);
    const reach = Math.min(Math.hypot(dp.x - sp.x, dp.y - sp.y), 70) * 0.55 + (f.heavy ? 26 : 18);
    const sweep = f.heavy ? 2.4 : 2.0;
    const head = easeOutCubic(clamp01(t / 0.45));
    const tail = easeOut(clamp01((t - 0.15) / 0.85));
    const a0 = ang - f.flip * sweep / 2;
    const aHead = a0 + f.flip * sweep * head;
    const aTail = a0 + f.flip * sweep * tail;
    if (Math.abs(aHead - aTail) < 0.02) return;
    const fade = 1 - clamp01((t - 0.55) / 0.45);
    const width = (f.heavy ? 15 : 11) * (1 - t * 0.5);

    // Crescent: outer arc out, inner arc back, thickest in the middle.
    const crescent = (w, color, alpha) => {
      const steps = 18;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const k = i / steps;
        const a = aTail + (aHead - aTail) * k;
        const th = Math.sin(k * Math.PI) * w * (0.35 + 0.65 * k);
        const x = sp.x + Math.cos(a) * (reach + th / 2);
        const y = cy + Math.sin(a) * (reach + th / 2) * 0.8;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      for (let i = steps; i >= 0; i--) {
        const k = i / steps;
        const a = aTail + (aHead - aTail) * k;
        const th = Math.sin(k * Math.PI) * w * (0.35 + 0.65 * k);
        const x = sp.x + Math.cos(a) * (reach - th / 2);
        const y = cy + Math.sin(a) * (reach - th / 2) * 0.8;
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fill();
    };
    crescent(width * 1.9, rgba(f.rgb, 0.35), fade);
    crescent(width, rgba(whiten(f.rgb, 0.3), 0.9), fade);
    crescent(width * 0.35, '#ffffff', fade);

    // a glint at the leading edge
    const gx = sp.x + Math.cos(aHead) * reach;
    const gy = cy + Math.sin(aHead) * reach * 0.8;
    blit(ctx, glow(f.color), gx, gy, 16 * fade, 0.8 * fade);
  }

  orb(ctx, f, t, now) {
    const sp = this.pos(f.src, { x: f.sx, y: f.sy, r: f.sr });
    const dp = this.pos(f.dst, { x: f.dx, y: f.dy, r: f.dr });
    const k = clamp01(t);
    const x0 = sp.x, y0 = sp.y - (sp.r || 14) * 1.3;
    const x1 = dp.x, y1 = dp.y - (dp.r || 14) * 1.0;
    const arc = Math.sin(k * Math.PI) * Math.min(40, Math.hypot(x1 - x0, y1 - y0) * 0.12);
    const x = x0 + (x1 - x0) * k;
    const y = y0 + (y1 - y0) * k - arc;
    // trail embers
    if (now - f.trailAt > 14) {
      f.trailAt = now;
      for (let i = 0; i < 2; i++) {
        this.spawn({ x: x + rand(-3, 3), y: y + rand(-3, 3), vx: rand(-0.02, 0.02), vy: -rand(0.01, 0.04),
          life: rand(200, 380), size: rand(3, 6), color: f.color, kind: 'glow', born: now });
      }
    }
    const flick = 1 + Math.sin(now / 30) * 0.1;
    blit(ctx, glow(f.color), x, y, 26 * flick, 0.9);
    blit(ctx, glow('#ffffff'), x, y, 8, 1);
  }

  arrow(ctx, f, t, now) {
    const sp = this.pos(f.src, { x: f.sx, y: f.sy, r: f.sr });
    const dp = this.pos(f.dst, { x: f.dx, y: f.dy, r: f.dr });
    const k = clamp01(t);
    const x0 = sp.x, y0 = sp.y - (sp.r || 14) * 1.2;
    const x1 = dp.x, y1 = dp.y - (dp.r || 14) * 1.0;
    const lift = Math.min(28, Math.hypot(x1 - x0, y1 - y0) * 0.08);
    const x = x0 + (x1 - x0) * k;
    const y = y0 + (y1 - y0) * k - Math.sin(k * Math.PI) * lift;
    const vy = (y1 - y0) - Math.cos(k * Math.PI) * Math.PI * lift;
    const ang = Math.atan2(vy, x1 - x0);
    // streak
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = rgba(f.rgb, 0.6);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - Math.cos(ang) * 34, y - Math.sin(ang) * 34);
    ctx.lineTo(x, y);
    ctx.stroke();
    // shaft, head and fletching drawn normally on top of the glow
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.strokeStyle = '#d9c9a3';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-18, 0);
    ctx.lineTo(2, 0);
    ctx.stroke();
    ctx.fillStyle = '#eef2f5';
    ctx.beginPath();
    ctx.moveTo(7, 0);
    ctx.lineTo(0, -3.5);
    ctx.lineTo(0, 3.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#c0392b';
    ctx.beginPath();
    ctx.moveTo(-18, 0); ctx.lineTo(-23, -4); ctx.lineTo(-14, 0); ctx.lineTo(-23, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  burst(x, y, color, n, now) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const sp = rand(0.08, 0.3);
      this.spawn({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(200, 400), size: rand(3, 6),
        color, kind: 'glow', drag: 0.98, born: now });
    }
    this.effects.push({ kind: 'flare', x, y, color, rgb: rgbOf(color), size: 40, born: now, life: 260 });
  }

  whirlGround(ctx, f, t) {
    const R = f.radius;
    const grow = easeOutCubic(clamp01(t / 0.35));
    const fade = 1 - clamp01((t - 0.45) / 0.55);
    ctx.save();
    ctx.translate(f.cx, f.cy);
    ctx.scale(1, 0.5);
    const g = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R * grow);
    g.addColorStop(0, rgba(f.rgb, 0));
    g.addColorStop(0.75, rgba(f.rgb, 0.16 * fade));
    g.addColorStop(1, rgba(f.rgb, 0.4 * fade));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, R * grow, 0, TAU);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = rgba(whiten(f.rgb, 0.4), 0.85 * fade);
    ctx.stroke();
    // cracks
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(30,20,10,${0.35 * fade})`;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + f.born % 1;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * R * 0.15, Math.sin(a) * R * 0.15);
      ctx.lineTo(Math.cos(a + 0.12) * R * 0.5 * grow, Math.sin(a + 0.12) * R * 0.5 * grow);
      ctx.lineTo(Math.cos(a - 0.05) * R * 0.8 * grow, Math.sin(a - 0.05) * R * 0.8 * grow);
      ctx.stroke();
    }
    ctx.restore();
  }

  whirlTop(ctx, f, t) {
    const R = f.radius;
    const fade = 1 - clamp01((t - 0.5) / 0.5);
    ctx.save();
    ctx.translate(f.cx, f.cy - 14);
    ctx.scale(1, 0.5);
    const spin = t * TAU * 1.6;
    for (let i = 0; i < 3; i++) {
      const r = R * (0.45 + 0.22 * i) * easeOut(clamp01(t / 0.3 + 0.2));
      const a0 = spin + (i * TAU) / 3;
      ctx.globalAlpha = 0.75 * fade;
      ctx.strokeStyle = rgba(whiten(f.rgb, 0.25), 0.9);
      ctx.lineWidth = 7 - i * 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, r, a0, a0 + 2.2);
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, r, a0 + 1.4, a0 + 2.2);
      ctx.stroke();
    }
    ctx.restore();
  }

  healGround(ctx, f, t) {
    const p = this.pos(f.src, { x: f.sx, y: f.sy });
    const fade = Math.sin(clamp01(t) * Math.PI);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(1, 0.45);
    ctx.globalCompositeOperation = 'lighter';
    ctx.rotate(t * 1.5);
    ctx.strokeStyle = rgba(f.rgb, 0.7 * fade);
    ctx.lineWidth = 2;
    const R = 34;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.72, 0, TAU);
    ctx.stroke();
    // runes: little ticks between the two circles
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * R * 0.76, Math.sin(a) * R * 0.76);
      ctx.lineTo(Math.cos(a + 0.15) * R * 0.95, Math.sin(a + 0.15) * R * 0.95);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.35 * fade;
    ctx.drawImage(glow(f.color), -R * 1.3, -R * 1.3, R * 2.6, R * 2.6);
    ctx.restore();
  }

  buffGround(ctx, f, t) {
    const p = this.pos(f.src, { x: f.sx, y: f.sy });
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(1, 0.42);
    ctx.globalCompositeOperation = 'lighter';
    for (const off of [0, 0.33, 0.66]) {
      const k = clamp01(t * 1.4 - off);
      if (k <= 0 || k >= 1) continue;
      ctx.strokeStyle = rgba(f.rgb, (1 - k) * 0.9);
      ctx.lineWidth = 4 * (1 - k) + 1;
      ctx.beginPath();
      ctx.arc(0, 0, 14 + 46 * easeOut(k), 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  buffTop(ctx, f, t) {
    const p = this.pos(f.src, { x: f.sx, y: f.sy, r: f.sr });
    const fade = Math.sin(clamp01(t) * Math.PI);
    const h = 70 * easeOut(clamp01(t * 2));
    const w = (p.r || 14) * 1.5;
    const g = ctx.createLinearGradient(0, p.y, 0, p.y - h);
    g.addColorStop(0, rgba(f.rgb, 0.45 * fade));
    g.addColorStop(1, rgba(f.rgb, 0));
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(p.x - w, p.y);
    ctx.quadraticCurveTo(p.x - w * 0.7, p.y - h * 0.6, p.x - w * 0.25, p.y - h);
    ctx.lineTo(p.x + w * 0.25, p.y - h);
    ctx.quadraticCurveTo(p.x + w * 0.7, p.y - h * 0.6, p.x + w, p.y);
    ctx.closePath();
    ctx.fill();
  }

  flare(ctx, f, t) {
    const k = clamp01(t);
    const s = f.size * (0.6 + 0.6 * easeOut(k));
    const a = 1 - k;
    blit(ctx, glow(f.color), f.x, f.y, s, a);
    // four-point star
    ctx.globalAlpha = a;
    ctx.fillStyle = rgba(whiten(f.rgb, 0.6), 0.9);
    const L = s * (f.crit ? 1.3 : 0.9);
    const W = s * 0.09;
    ctx.beginPath();
    ctx.moveTo(f.x - L, f.y); ctx.lineTo(f.x, f.y - W); ctx.lineTo(f.x + L, f.y); ctx.lineTo(f.x, f.y + W);
    ctx.closePath();
    ctx.moveTo(f.x, f.y - L * 0.7); ctx.lineTo(f.x + W, f.y); ctx.lineTo(f.x, f.y + L * 0.7); ctx.lineTo(f.x - W, f.y);
    ctx.closePath();
    ctx.fill();
  }

  ring(ctx, f, t) {
    const k = easeOutCubic(clamp01(t));
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.scale(1, 0.45);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = rgba(f.rgb, 0.8 * (1 - t));
    ctx.lineWidth = 5 * (1 - t) + 1;
    ctx.beginPath();
    ctx.arc(0, 0, f.radius * k, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  pillarGround(ctx, f, t) {
    const p = this.pos(f.anchor, f);
    const fade = Math.sin(clamp01(t) * Math.PI);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(1, 0.4);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.6 * fade;
    ctx.drawImage(glow(f.color), -60, -60, 120, 120);
    ctx.restore();
  }

  pillar(ctx, f, t) {
    const p = this.pos(f.anchor, f);
    const up = easeOutCubic(clamp01(t / 0.3));
    const fade = 1 - clamp01((t - 0.5) / 0.5);
    const h = f.height * up;
    const w = 26 * (1 - 0.4 * t);
    const g = ctx.createLinearGradient(p.x - w, 0, p.x + w, 0);
    g.addColorStop(0, rgba(f.rgb, 0));
    g.addColorStop(0.5, rgba(whiten(f.rgb, 0.5), 0.55 * fade));
    g.addColorStop(1, rgba(f.rgb, 0));
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(p.x - w, p.y - h, w * 2, h);
    // soft top
    blit(ctx, glow(f.color), p.x, p.y - h, w * 1.4, 0.6 * fade);
  }

  particles(ctx, now, dt) {
    const step = Math.min(dt, 50);
    let w = 0;
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      const age = now - p.born;
      if (age >= p.life) continue;
      this.parts[w++] = p;
      if (age < 0) continue;
      p.vy += p.grav * step;
      p.vx *= Math.pow(p.drag, step / 16);
      p.vy *= Math.pow(p.drag, step / 16);
      let x, y;
      if (p.anchor) {
        p.ax += p.vx * step;
        p.ay += p.vy * step;
        const e = this.resolve(p.anchor);
        if (e) { p.bx = e.x; p.by = e.y; }
        x = (p.bx ?? 0) + p.ox + p.ax;
        y = (p.by ?? 0) + p.oy + p.ay;
        if (p.bx === undefined) continue;
      } else {
        p.x += p.vx * step;
        p.y += p.vy * step;
        x = p.x; y = p.y;
      }
      const k = age / p.life;
      const a = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
      switch (p.kind) {
        case 'spark': {
          ctx.globalAlpha = a;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = p.size;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - p.vx * 28, y - p.vy * 28);
          ctx.stroke();
          break;
        }
        case 'plus': {
          ctx.globalAlpha = a;
          ctx.fillStyle = p.color;
          const s = p.size * 1.4;
          ctx.fillRect(x - s, y - s * 0.3, s * 2, s * 0.6);
          ctx.fillRect(x - s * 0.3, y - s, s * 0.6, s * 2);
          break;
        }
        case 'dust': {
          ctx.save();
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = a * 0.45;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(x, y, p.size * (0.6 + k), 0, TAU);
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'wisp':
          blit(ctx, glow(p.color), x + Math.sin(age / 120 + p.size) * 4, y, p.size * 2.2, a * 0.8);
          break;
        default:
          blit(ctx, glow(p.color), x, y, p.size * 2, a);
      }
    }
    this.parts.length = w;
  }
}
