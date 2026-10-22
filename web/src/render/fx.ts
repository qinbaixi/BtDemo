// Skill and combat effects. Everything lives in world coordinates.
// 每帧先 step()，然后分几块画：drawUnder() 是角色脚下的地面特效；角色上方的特效里，
// drawTrails() 画刀光和尾迹（GPU 丝带），particles() 画粒子（GPU 精灵），drawShapes() 画其余有形状的特效（Canvas 2D）。
//
// Glows use cached radial-gradient sprites blended with 'lighter' instead of
// shadowBlur, which keeps a busy fight cheap.

const TAU = Math.PI * 2;
const MAX_PARTICLES = 900;

const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/* ------------------------------ colour ------------------------------ */

type RGB = number[];

function rgbOf(hex: unknown): RGB {
  let c = typeof hex === 'string' ? hex.replace('#', '') : '';
  if (c.length === 3) c = c.split('').map((ch) => ch + ch).join('');
  if (!/^[0-9a-f]{6}$/i.test(c)) return [255, 255, 255];
  const n = parseInt(c, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba([r, g, b]: RGB, a: number) {
  return `rgba(${r},${g},${b},${a})`;
}

// mix moves a colour toward white by k (0..1).
function whiten([r, g, b]: RGB, k: number): RGB {
  return [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k].map((v) => v | 0);
}

// whitenHex 是 whiten 的结果转成 0xRRGGBB，给 GPU 着色用。
function whitenHex(c: RGB, k: number): number {
  const [r, g, b] = whiten(c, k);
  return (r << 16) | (g << 8) | b;
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

export type Resolve = (id: number) => { x: number; y: number; r: number; facing?: number; h?: number } | null;

// Aura 是身上带护盾的实体：位置、身高（脚到头顶的像素）和护盾剩余比例（0..1，按满护盾算）。
export type Aura = { id: number; x: number; y: number; r: number; h: number; frac: number };

// LookEnt 是身上带 Buff 外观的实体（looks 是 game/config.ts 的 LOOK_* 位），给 looks() 用。
export type LookEnt = { id: number; x: number; y: number; r: number; h: number; looks: number; moving: boolean; dir: number };

// 和 game/config.ts 的 LOOK_* 一致（这个文件不引用游戏状态）
const LOOK_HASTE = 1;
const LOOK_HOLY = 2;
const LOOK_FIRE = 4;
const LOOK_FROST = 8;

export class FX {
  resolve: Resolve;
  effects: any[];   // 正在播放的技能特效
  parts: any[];     // 粒子
  shake: number;
  density: number;   // 粒子密度 0..1
  lookEnts: LookEnt[] = [];               // 这一帧带外观的实体（looks() 记下，drawTrails 画光晕）
  lookSpawnAt = new Map<string, number>(); // "实体 id:外观" -> 上次冒粒子的时间

  // resolve(id) returns the live {x, y, r} of an entity, or null.
  auras: () => Aura[];   // 每帧要画护盾泡泡的实体

  constructor(resolve: Resolve, auras: () => Aura[] = () => []) {
    this.resolve = resolve;
    this.auras = auras;
    this.effects = [];
    this.parts = [];
    this.shake = 0;          // 大范围技能的震动强度（像素），由 camera.ts 衰减
    this.density = 1;        // 粒子密度 0..1：中画质下随机丢掉一部分粒子（world.ts 按画质设置）
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
      case 'shield': {
        // 护盾成形：一圈六边形碎片从外面飞回来拼成泡泡，脚下一道光环
        this.effects.push({ ...base, kind: 'shieldForm', life: 700 });
        this.effects.push({ ...base, kind: 'buff', life: 800 });
        for (let i = 0; i < 26; i++) {
          const a = rand(0, TAU);
          const d = rand(46, 70);
          this.spawn({ anchor: ev.src, ox: Math.cos(a) * d, oy: Math.sin(a) * d * 0.6 - 18, vx: -Math.cos(a) * d / 420,
            vy: -Math.sin(a) * d * 0.6 / 420, life: 420, size: rand(2, 3.5), color: i % 3 ? color : '#ffffff', kind: 'glow', born: now + rand(0, 160) });
        }
        return 0;
      }
      case 'haste': {
        // 疾风步：脚下一圈青色气浪，身边几道风线往两边吹开
        this.effects.push({ ...base, kind: 'buff', life: 700 });
        for (let i = 0; i < 20; i++) {
          const side = i % 2 ? 1 : -1;
          this.spawn({ anchor: ev.src, ox: side * rand(4, 16), oy: -rand(2, 34), vx: side * rand(0.12, 0.32), vy: -rand(0, 0.03),
            drag: 0.985, life: rand(260, 460), size: rand(1.5, 2.6), color: i % 3 ? color : '#ffffff', kind: 'spark', born: now + rand(0, 160) });
        }
        return 0;
      }
      case 'holy': {
        // 圣光庇护：一道金色光柱落下，脚下一圈光环
        this.effects.push({ ...base, kind: 'pillar', anchor: ev.src, x: src.x, y: src.y, height: 150, life: 650 });
        // 只是一圈地面光环，不用整套 buff 特效（再叠就把角色照成一团白了）
        this.effects.push({ ...base, kind: 'ring', x: src.x, y: src.y, radius: 70, life: 600 });
        for (let i = 0; i < 16; i++) {
          const a = rand(0, TAU);
          this.spawn({ anchor: ev.src, ox: Math.cos(a) * rand(8, 20), oy: Math.sin(a) * rand(3, 8) - rand(0, 30),
            vx: Math.cos(a) * 0.03, vy: -rand(0.05, 0.14), life: rand(500, 900), size: rand(2, 3.6),
            color: i % 3 ? color : '#ffffff', kind: 'glow', born: now + rand(0, 300) });
        }
        return 0;
      }
      case 'enchant': {
        // 烈焰附魔：身上腾起一团火，武器那边火星乱窜
        this.effects.push({ ...base, kind: 'buff', life: 800 });
        const dir = Math.cos((src as any).facing ?? 0) < 0 ? -1 : 1;
        for (let i = 0; i < 30; i++) {
          this.spawn({ anchor: ev.src, ox: dir * rand(6, 22), oy: -rand(14, 40), vx: rand(-0.04, 0.04), vy: -rand(0.05, 0.16),
            grav: -0.0001, life: rand(380, 760), size: rand(2.5, 5), color: i % 3 ? color : '#ffd27a',
            kind: i % 4 ? 'glow' : 'spark', born: now + rand(0, 280) });
        }
        return 0;
      }
      case 'blink': {
        // 闪现：起点和终点各爆一团紫光，中间一道光痕（残影在 actorView 里画）
        const x0 = ev.x ?? src.x;
        const y0 = ev.y ?? src.y;
        const x1 = ev.tx ?? src.x;
        const y1 = ev.ty ?? src.y;
        this.effects.push({ ...base, kind: 'blink', x0, y0, x1, y1, life: 420 });
        for (let i = 0; i < 16; i++) {
          const a = rand(0, TAU);
          // 起点：往里收的光点；终点：往外炸开的火花
          this.spawn({ x: x0 + Math.cos(a) * 22, y: y0 - 18 + Math.sin(a) * 14, vx: -Math.cos(a) * 0.05, vy: -Math.sin(a) * 0.04,
            life: rand(220, 380), size: rand(2, 3.5), color, kind: 'glow', born: now });
          this.spawn({ x: x1, y: y1 - 18, vx: Math.cos(a) * rand(0.1, 0.25), vy: Math.sin(a) * rand(0.06, 0.15),
            drag: 0.99, life: rand(260, 420), size: rand(1.5, 2.6), color: i % 3 ? color : '#ffffff', kind: 'spark', born: now + 30 });
        }
        this.effects.push({ ...base, kind: 'ring', x: x1, y: y1, radius: 46, life: 360 });
        return 0;
      }
      case 'axe': {
        // 飞斧：转着飞向终点（命中的敌人或被墙挡住的地方）
        const x0 = ev.x ?? src.x;
        const y0 = ev.y ?? src.y;
        const x1 = ev.tx ?? dst.x;
        const y1 = ev.ty ?? dst.y;
        const life = Math.max(120, Math.hypot(x1 - x0, y1 - y0) / 0.85);
        this.effects.push({ ...base, kind: 'axe', x0, y0, x1, y1, life, hit: !!ev.dst });
        return life;
      }
      case 'frost': {
        // 冰霜新星：地上一圈冰环往外扩，冰碴往外飞，飘几片雪
        const cx = ev.x ?? src.x;
        const cy = ev.y ?? src.y;
        const radius = ev.radius || 110;
        this.effects.push({ ...base, kind: 'nova', cx, cy, radius, life: 760, seed: Math.random() * 100 });
        for (let i = 0; i < 34; i++) {
          const a = rand(0, TAU);
          const sp = rand(0.2, 0.42);
          this.spawn({ x: cx + Math.cos(a) * 10, y: cy - 8 + Math.sin(a) * 5, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.5,
            drag: 0.993, life: rand(320, 560), size: rand(1.5, 2.8), color: i % 3 ? color : '#ffffff', kind: 'spark', born: now });
        }
        for (let i = 0; i < 12; i++) {
          this.spawn({ x: cx + rand(-radius, radius) * 0.8, y: cy + rand(-radius, radius) * 0.35 - rand(10, 50), vx: rand(-0.01, 0.01),
            vy: rand(0.01, 0.025), life: rand(900, 1500), size: rand(2.5, 4), color: '#e8f6ff', kind: 'wisp', born: now + rand(0, 400) });
        }
        this.shake = Math.max(this.shake, 5);
        return 90;
      }
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
    // a sharp gash across the target, two of them on a crit
    for (let i = 0; i < (crit ? 2 : 1); i++) {
      this.effects.push({ kind: 'gash', x: p.x, y, color: c, rgb: rgbOf(c), ang: rand(-0.9, -0.3) + i * 1.2,
        len: (p.r || 14) * (crit ? 2.6 : 1.9), born: now + i * 40, life: 170 });
    }
  }

  // block 是格挡住一击：盾面（朝向那一侧）闪一道弧光，火花向外溅。
  block(id, now) {
    const p = this.pos(id, null);
    if (!p) return;
    const r = p.r || 14;
    const dir = Math.cos(p.facing ?? 0) < 0 ? -1 : 1;
    // 盾举在胸前：身高的六成左右、身体前面一点
    const ox = dir * r * 0.95;
    const oy = -(p.h || r * 2.6) * 0.6;
    const x = p.x + ox;
    const y = p.y + oy;
    this.effects.push({ kind: 'parry', anchor: id, ox, oy, x, y, dir, r,
      color: '#9ad7ff', rgb: rgbOf('#9ad7ff'), born: now, life: 260 });
    for (let i = 0; i < 16; i++) {
      const a = (dir > 0 ? 0 : Math.PI) + rand(-1.1, 1.1);
      const sp = rand(0.2, 0.5);
      this.spawn({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.12, grav: 0.0012,
        life: rand(200, 380), size: rand(1.4, 2.6), color: i % 3 ? '#fff3c4' : '#9ad7ff', kind: 'spark', drag: 0.98, born: now });
    }
  }

  // shieldHit 是护盾吸收了伤害：泡泡亮一下，受击处荡开一圈波纹。
  shieldHit(id, now) {
    const p = this.pos(id, null);
    if (!p) return;
    this.effects.push({ kind: 'shieldPing', anchor: id, a: rand(-2.6, -0.5), born: now, life: 380,
      color: '#7fd8ff', rgb: rgbOf('#7fd8ff') });
  }

  // shieldBreak 是护盾被打破（或到时间消失）：泡泡碎成一片片往外飞。
  shieldBreak(id, now) {
    const p = this.pos(id, null);
    if (!p) return;
    const b = this.bubbleShape(p.x, p.y, p.r || 14, p.h || (p.r || 14) * 2.6);
    for (let i = 0; i < 24; i++) {
      const a = rand(0, TAU);
      const sp = rand(0.08, 0.22);
      this.spawn({ x: b.cx + Math.cos(a) * b.rx, y: b.cy + Math.sin(a) * b.ry, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.04,
        grav: 0.0004, life: rand(320, 560), size: rand(1.5, 2.8), color: i % 4 ? '#7fd8ff' : '#ffffff', kind: 'spark', drag: 0.99, born: now });
    }
    this.effects.push({ kind: 'ring', x: b.cx, y: b.cy + b.ry * 0.6, color: '#7fd8ff', rgb: rgbOf('#7fd8ff'), radius: b.rx * 1.6, born: now, life: 420 });
  }

  // footDust 是跑动时脚下扬起的一小团土（浅土黄，暗色地面上看得出来）。dir 是移动方向（-1 左，1 右）。
  footDust(x, y, dir, now) {
    for (let i = 0; i < 4; i++) {
      this.spawn({ x: x - dir * rand(0, 8), y: y - rand(0, 3), vx: -dir * rand(0.015, 0.05), vy: -rand(0.008, 0.025),
        life: rand(380, 600), size: rand(3.5, 6), color: '#b3a48e', kind: 'dust', drag: 0.99, born: now });
    }
  }

  // ashes 是尸体开始溶解：一阵余烬和灰从身上升起来。
  ashes(id, color, now) {
    const p = this.pos(id, null);
    if (!p) return;
    const r = p.r || 14;
    for (let i = 0; i < 26; i++) {
      this.spawn({ x: p.x + rand(-r * 1.6, r * 1.6), y: p.y - rand(0, r * 0.8), vx: rand(-0.02, 0.02), vy: -rand(0.03, 0.08),
        life: rand(700, 1300), size: rand(1.5, 3), color: i % 3 ? color : '#ffe2a8', kind: 'wisp', born: now + rand(0, 700) });
    }
    for (let i = 0; i < 8; i++) {
      this.spawn({ x: p.x + rand(-r, r), y: p.y - rand(0, 6), vx: rand(-0.02, 0.02), vy: -rand(0.01, 0.025),
        life: rand(800, 1200), size: rand(5, 9), color: '#3a3038', kind: 'dust', born: now + rand(0, 600) });
    }
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
    if (this.density < 1 && Math.random() > this.density) return;
    if (this.parts.length >= MAX_PARTICLES) this.parts.shift();
    p.ax = 0; p.ay = 0;        // accumulated offset for anchored particles
    p.drag = p.drag ?? 1;
    p.grav = p.grav ?? 0;
    this.parts.push(p);
  }

  // waves 登记正在扩散的冲击波（后期处理把画面往外推一圈，像空气被震开）。
  // add(x, y, radius, strength)：世界坐标的中心、当前半径（像素）、推开的距离（像素）。
  waves(add, now) {
    for (const f of this.effects) {
      const t = (now - f.born) / f.life;
      if (t < 0 || t >= 1) continue;
      switch (f.kind) {
        case 'whirl': {
          const k = clamp01(t / 0.7);
          if (k < 1) add(f.cx, f.cy - 10, f.radius * (0.25 + 1.1 * easeOut(k)), 9 * (1 - k));
          break;
        }
        case 'flare':
          if (f.crit) { const k = clamp01(t / 0.9); add(f.x, f.y, 14 + 90 * easeOut(k), 7 * (1 - k)); }
          break;
        case 'shieldForm': {
          const p = this.pos(f.src, { x: f.sx, y: f.sy });
          const k = clamp01((t - 0.5) / 0.5);
          if (k > 0) add(p.x, p.y - 20, 20 + 90 * easeOut(k), 6 * (1 - k));
          break;
        }
        case 'pillar': {
          const p = this.pos(f.anchor, f);
          const k = clamp01(t / 0.6);
          add(p.x, p.y - 10, 20 + 120 * easeOut(k), 6 * (1 - k));
          break;
        }
        case 'nova': {
          const k = clamp01(t / 0.6);
          if (k < 1) add(f.cx, f.cy - 8, f.radius * (0.2 + 1.1 * easeOut(k)), 8 * (1 - k));
          break;
        }
        case 'blink': {
          const k = clamp01(t / 0.5);
          if (k < 1) add(f.x1, f.y1 - 18, 10 + 70 * easeOut(k), 6 * (1 - k));
          break;
        }
      }
    }
  }

  // lights reports the light that active effects cast on their surroundings.
  lights(add, now) {
    for (const f of this.effects) {
      const t = (now - f.born) / f.life;
      if (t < 0 || t >= 1) continue;
      const fade = 1 - t;
      switch (f.kind) {
        case 'orb':
        case 'arrow': {
          const sp = this.pos(f.src, { x: f.sx, y: f.sy });
          const dp = this.pos(f.dst, { x: f.dx, y: f.dy });
          add(sp.x + (dp.x - sp.x) * t, sp.y + (dp.y - sp.y) * t - 20, f.kind === 'orb' ? 170 : 70, f.color, 0.9, 0.5);
          break;
        }
        case 'slash': {
          const sp = this.pos(f.src, { x: f.sx, y: f.sy });
          add(sp.x, sp.y - 14, 120, f.color, fade, 0.35);
          break;
        }
        case 'flare': add(f.x, f.y, f.size * 3.5, f.color, fade, 0.5); break;
        case 'whirl': add(f.cx, f.cy, f.radius * 1.8, f.color, fade, 0.45); break;
        case 'heal':
        case 'buff': {
          const p = this.pos(f.src, { x: f.sx, y: f.sy });
          add(p.x, p.y - 10, 160, f.color, Math.sin(t * Math.PI), 0.45);
          break;
        }
        case 'pillar': {
          const p = this.pos(f.anchor, f);
          add(p.x, p.y - 30, 220, f.color, Math.sin(t * Math.PI), 0.55);
          break;
        }
        case 'ring': add(f.x, f.y, f.radius * 1.5, f.color, fade * 0.6, 0.3); break;
        case 'parry': add(f.x, f.y, 70, f.color, fade, 0.55); break;
        case 'shieldForm': { const p = this.pos(f.src, { x: f.sx, y: f.sy }); add(p.x, p.y - 18, 110, f.color, fade, 0.4); break; }
        case 'nova': add(f.cx, f.cy, f.radius * 1.7, f.color, fade, 0.45); break;
        case 'blink': add(f.x1, f.y1 - 18, 130, f.color, fade, 0.5); break;
        case 'axe': {
          const k = clamp01(t);
          add(f.x0 + (f.x1 - f.x0) * k, f.y0 + (f.y1 - f.y0) * k - 22, 60, '#dfe8ff', 0.7, 0.3);
          break;
        }
      }
    }
    // 身上的外观：圣光和火焰武器会照亮周围
    for (const e of this.lookEnts) {
      if (e.looks & LOOK_HOLY) add(e.x, e.y - e.h * 0.5, 140, '#ffe9a0', 0.5, 0.3);
      if (e.looks & LOOK_FIRE) add(e.x + e.dir * e.r, e.y - e.h * 0.55, 100, '#ff8a3a', 0.55, 0.35);
    }
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
        case 'nova': this.novaGround(ctx, f, t); break;
      }
    }
    ctx.restore();
  }

  // underBounds 返回 drawUnder 这一帧会画到的范围 [x0, y0, x1, y1]（世界坐标），没有地面特效时返回 null。
  underBounds(now: number): number[] | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x: number, y: number, rx: number, ry: number) => {
      x0 = Math.min(x0, x - rx); y0 = Math.min(y0, y - ry);
      x1 = Math.max(x1, x + rx); y1 = Math.max(y1, y + ry);
    };
    for (const f of this.effects) {
      const t = (now - f.born) / f.life;
      if (t < 0 || t >= 1) continue;
      switch (f.kind) {
        case 'whirl': add(f.cx, f.cy, f.radius + 4, f.radius * 0.5 + 4); break;
        case 'heal': { const p = this.pos(f.src, { x: f.sx, y: f.sy }); add(p.x, p.y, 64, 30); break; }
        case 'buff': { const p = this.pos(f.src, { x: f.sx, y: f.sy }); add(p.x, p.y, 64, 30); break; }
        case 'ring': add(f.x, f.y, f.radius + 6, f.radius * 0.45 + 6); break;
        case 'pillar': { const p = this.pos(f.anchor, f); add(p.x, p.y, 62, 26); break; }
        case 'nova': add(f.cx, f.cy, f.radius * 1.15 + 8, f.radius * 0.55 + 8); break;
      }
    }
    return x1 > x0 ? [x0, y0, x1, y1] : null;
  }

  // step 每帧先调一次：弹道到达时爆一下，清掉播完的特效。
  step(now) {
    // Projectiles burst once on arrival, even if no frame fell near their end.
    for (const f of this.effects) {
      if ((f.kind === 'orb' || f.kind === 'arrow') && !f.landed && now - f.born >= f.life * 0.95) {
        f.landed = true;
        const dp = this.pos(f.dst, { x: f.dx, y: f.dy, r: f.dr });
        this.burst(dp.x, dp.y - (dp.r || 14), f.color, f.kind === 'orb' ? 16 : 8, now);
      }
    }
    for (const f of this.effects) {
      if (f.kind === 'axe' && !f.landed && now - f.born >= f.life * 0.95) {
        f.landed = true;
        // 打中：金属火花；没打中：插在地上扬一团土
        if (f.hit) this.burst(f.x1, f.y1 - 22, '#e8eef8', 12, now);
        else this.footDust(f.x1, f.y1, Math.sign(f.x1 - f.x0) || 1, now);
      }
    }
    this.effects = this.effects.filter((f) => now - f.born < f.life);
    // 法球飞行中一路掉火星
    for (const f of this.effects) {
      if (f.kind !== 'orb' || now - f.trailAt <= 14) continue;
      const t = (now - f.born) / f.life;
      if (t < 0) continue;
      f.trailAt = now;
      const { x, y } = this.projectilePath(f, clamp01(t), 40);
      for (let i = 0; i < 2; i++) {
        this.spawn({ x: x + rand(-3, 3), y: y + rand(-3, 3), vx: rand(-0.02, 0.02), vy: -rand(0.01, 0.04),
          life: rand(200, 380), size: rand(3, 6), color: f.color, kind: 'glow', born: now });
      }
    }
  }

  // drawShapes 用 Canvas 2D 画有形状的特效（刀光、弹道、旋风、护盾泡泡……），画在 shapeBounds 的范围里。
  drawShapes(ctx, now) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const f of this.effects) {
      const t = (now - f.born) / f.life;
      if (t < 0) continue;
      switch (f.kind) {
        case 'arrow': this.arrow(ctx, f, t, now); break;
        case 'flare': this.flare(ctx, f, t); break;
        case 'gash': this.gash(ctx, f, t); break;
        case 'pillar': this.pillar(ctx, f, t); break;
        case 'buff': this.buffTop(ctx, f, t); break;
        case 'parry': this.parry(ctx, f, t); break;
        case 'shieldForm': this.shieldForm(ctx, f, t); break;
        case 'axe': this.axe(ctx, f, t, now); break;
      }
    }
    this.shieldAuras(ctx, now);
    ctx.restore();
  }

  // shapeBounds 返回 drawShapes 这一帧会画到的大致范围 [x0, y0, x1, y1]（世界坐标，宁大勿小），
  // 没有要画的时返回 null。
  shapeBounds(now: number): number[] | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x: number, y: number, side: number, up: number, down: number) => {
      x0 = Math.min(x0, x - side); x1 = Math.max(x1, x + side);
      y0 = Math.min(y0, y - up); y1 = Math.max(y1, y + down);
    };
    for (const f of this.effects) {
      const t = (now - f.born) / f.life;
      if (t < 0 || t >= 1) continue;
      switch (f.kind) {
        case 'arrow': {
          const sp = this.pos(f.src, { x: f.sx, y: f.sy });
          const dp = this.pos(f.dst, { x: f.dx, y: f.dy });
          add(sp.x, sp.y, 60, 110, 40);
          add(dp.x, dp.y, 60, 110, 40);
          break;
        }
        case 'flare': add(f.x, f.y, f.size * 2.5, f.size * 2.5, f.size * 2.5); break;
        case 'gash': add(f.x, f.y, f.len + 10, f.len + 10, f.len + 10); break;
        case 'pillar': { const p = this.pos(f.anchor, f); add(p.x, p.y, 50, (f.height || 120) + 50, 20); break; }
        case 'buff': { const p = this.pos(f.src, { x: f.sx, y: f.sy }); add(p.x, p.y, 90, 150, 40); break; }
        case 'shieldForm': {
          // 外圈是泡泡的 2.2 倍，大体型的泡泡更大
          const p = this.pos(f.src, { x: f.sx, y: f.sy, r: f.sr });
          const r = p.r || f.sr || 14;
          const b = this.bubbleShape(p.x, p.y, r, (p as any).h || r * 2.6);
          add(b.cx, b.cy, b.rx * 2.4 + 10, b.ry * 2.4 + 10, b.ry * 2.4 + 10);
          break;
        }
        case 'parry': add(f.x, f.y, f.r * 3 + 10, f.r * 3 + 10, f.r * 3 + 10); break;
        case 'axe': {
          const k = clamp01(t);
          add(f.x0 + (f.x1 - f.x0) * k, f.y0 + (f.y1 - f.y0) * k - 22, 30, 30, 30);
          break;
        }
      }
    }
    for (const a of this.auras()) add(a.x, a.y, a.r * 2.6 + 20, a.h * 1.8 + 30, a.r + 20);
    return x1 > x0 ? [x0, y0, x1, y1] : null;
  }

  /* ------------------------ 拖尾（GPU 丝带） ------------------------ */

  // drawTrails 用丝带画刀光、旋风斩的风刃、法球和箭的尾迹（ribbons 是 pixi/trail.ts 的 RibbonPool），
  // 光点用 sprites（pixi/spriteCtx.ts）。
  drawTrails(ribbons, sprites, now) {
    sprites.save();
    sprites.globalCompositeOperation = 'lighter';
    for (const f of this.effects) {
      const t = (now - f.born) / f.life;
      if (t < 0 || t >= 1) continue;
      switch (f.kind) {
        case 'slash': this.slash(ribbons, sprites, f, t); break;
        case 'whirl': this.whirlBlades(ribbons, f, t); break;
        case 'orb': this.orb(ribbons, sprites, f, t, now); break;
        case 'arrow': this.arrowTrail(ribbons, f, t); break;
        case 'blink': this.blinkTrail(ribbons, sprites, f, t); break;
        case 'axe': this.axeTrail(ribbons, f, t); break;
      }
    }
    this.lookGlows(sprites, now);
    sprites.restore();
  }

  // blinkTrail 是闪现的光痕：从起点到终点一道紫光，起点那头先淡掉。
  blinkTrail(ribbons, sprites, f, t) {
    const fade = 1 - t;
    const points = [f.x0, f.y0 - 18, (f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2 - 20, f.x1, f.y1 - 18];
    const width = 26 * fade;
    ribbons.stroke(points, [width * 0.2, width * 0.8, width], f.color, 0.9 * fade, 'glow');
    blit(sprites, glow(f.color), f.x1, f.y1 - 18, 30 * (1 - t * 0.5), 0.45 * fade);
  }

  // axePoint 是飞斧在进度 k（0..1）时的位置（离地 22 像素飞）。
  axePoint(f, k) {
    return { x: f.x0 + (f.x1 - f.x0) * k, y: f.y0 + (f.y1 - f.y0) * k - 22 };
  }

  axeTrail(ribbons, f, t) {
    const head = clamp01(t);
    const tail = Math.max(0, head - 0.3);
    if (head - tail < 0.01) return;
    const points: number[] = [];
    const widths: number[] = [];
    for (let i = 0; i <= 6; i++) {
      const p = this.axePoint(f, tail + (head - tail) * (i / 6));
      points.push(p.x, p.y);
      widths.push(2 + 12 * (i / 6));
    }
    ribbons.stroke(points, widths, '#cfe0ff', 0.55, 'glow');
  }

  // axe 画转着飞的斧头：木柄 + 一片月牙形的斧刃，插地后停一会儿再淡掉。
  axe(ctx, f, t, now) {
    const k = clamp01(t / 0.95);
    const p = this.axePoint(f, k);
    const flying = t < 0.95;
    const dir = Math.sign(f.x1 - f.x0) || 1;
    const spin = flying ? (now - f.born) * 0.028 * dir : dir * 0.6;
    ctx.save();
    ctx.translate(p.x, p.y + (flying ? 0 : 10));
    ctx.rotate(spin);
    ctx.scale(1.4, 1.4);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = flying ? 1 : 1 - clamp01((t - 0.95) / 0.05);
    ctx.lineCap = 'round';
    // 柄
    ctx.strokeStyle = '#2a1608';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(-11, 0); ctx.lineTo(11, 0); ctx.stroke();
    ctx.strokeStyle = '#8a5a2c';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(10, 0); ctx.stroke();
    // 刃
    ctx.fillStyle = '#e9eef6';
    ctx.strokeStyle = '#1a1420';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(6, -2);
    ctx.quadraticCurveTo(10, -13, 18, -12);
    ctx.quadraticCurveTo(14, 0, 18, 12);
    ctx.quadraticCurveTo(10, 13, 6, 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.globalCompositeOperation = 'lighter';
    blit(ctx, glow('#cfe0ff'), 14, 0, 14, flying ? 0.5 : 0.2);
    ctx.restore();
  }

  // novaGround 是冰霜新星在地上的冰环：带一圈冰刺，往外扩到技能半径。
  novaGround(ctx, f, t) {
    const k = easeOutCubic(clamp01(t / 0.45));
    const fade = 1 - clamp01((t - 0.4) / 0.6);
    const radius = f.radius * k;
    ctx.save();
    ctx.translate(f.cx, f.cy);
    ctx.scale(1, 0.45);
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(0, 0, radius * 0.2, 0, 0, Math.max(1, radius));
    g.addColorStop(0, rgba(f.rgb, 0.05 * fade));
    g.addColorStop(0.75, rgba(f.rgb, 0.22 * fade));
    g.addColorStop(1, rgba(whiten(f.rgb, 0.6), 0.55 * fade));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.fill();
    // 冰刺：一圈长短不一的尖角，朝外
    ctx.fillStyle = rgba(whiten(f.rgb, 0.7), 0.75 * fade);
    const spikes = 18;
    for (let i = 0; i < spikes; i++) {
      const a = (i / spikes) * TAU + f.seed;
      const len = (10 + 14 * Math.abs(Math.sin(i * 7.3 + f.seed))) * k;
      const half = 0.09;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a - half) * radius * 0.92, Math.sin(a - half) * radius * 0.92);
      ctx.lineTo(Math.cos(a) * (radius + len), Math.sin(a) * (radius + len));
      ctx.lineTo(Math.cos(a + half) * radius * 0.92, Math.sin(a + half) * radius * 0.92);
      ctx.fill();
    }
    ctx.restore();
  }

  // looks 每帧调用：按身上的 Buff 外观冒粒子（疾风的风线、圣光的金点、武器的火星、冰冻的雪花），
  // 并记下这些实体，drawTrails 时给它们画光晕。
  looks(ents: LookEnt[], now: number) {
    this.lookEnts = ents;
    // 记的时间只是为了控制冒粒子的频率，攒多了直接清掉（实体进出视野会留下旧的）
    if (this.lookSpawnAt.size > 256) this.lookSpawnAt.clear();
    const due = (id: number, look: number, every: number) => {
      const key = id + ':' + look;
      if (now - (this.lookSpawnAt.get(key) ?? -1e9) < every) return false;
      this.lookSpawnAt.set(key, now);
      return true;
    };
    for (const ent of ents) {
      if (ent.looks & LOOK_HASTE && ent.moving && due(ent.id, LOOK_HASTE, 45)) {
        this.spawn({ x: ent.x - ent.dir * rand(4, 14), y: ent.y - rand(4, ent.h * 0.8), vx: -ent.dir * rand(0.15, 0.3), vy: 0,
          drag: 0.98, life: rand(220, 360), size: rand(1.2, 2), color: '#9effd8', kind: 'spark', born: now });
      }
      if (ent.looks & LOOK_HOLY && due(ent.id, LOOK_HOLY, 70)) {
        const a = rand(0, TAU);
        this.spawn({ anchor: ent.id, ox: Math.cos(a) * ent.r * 1.1, oy: -rand(0, ent.h), vx: 0, vy: -rand(0.03, 0.07),
          life: rand(500, 800), size: rand(1.8, 3), color: '#ffe9a0', kind: 'glow', born: now });
      }
      if (ent.looks & LOOK_FIRE && due(ent.id, LOOK_FIRE, 35)) {
        this.spawn({ anchor: ent.id, ox: ent.dir * rand(ent.r * 0.5, ent.r * 1.3), oy: -rand(ent.h * 0.35, ent.h * 0.8),
          vx: rand(-0.02, 0.02), vy: -rand(0.05, 0.12), grav: -0.0001, life: rand(280, 520), size: rand(2, 4),
          color: Math.random() < 0.3 ? '#ffd27a' : '#ff7a2a', kind: 'glow', born: now });
      }
      if (ent.looks & LOOK_FROST && due(ent.id, LOOK_FROST, 140)) {
        this.spawn({ x: ent.x + rand(-ent.r, ent.r), y: ent.y - rand(ent.h * 0.4, ent.h * 1.1), vx: rand(-0.01, 0.01), vy: rand(0.015, 0.03),
          life: rand(600, 900), size: rand(2, 3), color: '#e8f6ff', kind: 'wisp', born: now });
      }
    }
  }

  // lookGlows 给圣光庇护和火焰武器画常驻的光晕。
  lookGlows(sprites, now: number) {
    for (const ent of this.lookEnts) {
      const pulse = 0.85 + 0.15 * Math.sin(now / 140 + ent.id);
      // 光晕要淡：叠上泛光以后太亮会把角色本身盖住
      if (ent.looks & LOOK_HOLY) blit(sprites, glow('#ffd88a'), ent.x, ent.y - ent.h * 0.5, ent.h * 0.85 * pulse, 0.16);
      if (ent.looks & LOOK_FIRE) blit(sprites, glow('#ff7a2a'), ent.x + ent.dir * ent.r * 0.9, ent.y - ent.h * 0.58, ent.r * 0.9 * pulse, 0.3);
    }
  }

  // slash 是一道弧形刀光：头部最亮、尾部渐隐，下面垫一层墨色，像毛笔扫过。
  slash(ribbons, sprites, f, t) {
    const sp = this.pos(f.src, { x: f.sx, y: f.sy, r: f.sr });
    const dp = this.pos(f.dst, { x: f.dx, y: f.dy, r: f.dr });
    const cy = sp.y - (sp.r || 14) * 0.9;
    const ang = Math.atan2(dp.y - (dp.r || 14) * 0.9 - cy, dp.x - sp.x);
    const reach = Math.min(Math.hypot(dp.x - sp.x, dp.y - sp.y), 70) * 0.55 + (f.heavy ? 26 : 18);
    const sweep = f.heavy ? 2.6 : 2.1;
    const head = easeOutCubic(clamp01(t / 0.4));
    const tail = easeOut(clamp01((t - 0.12) / 0.88));
    const a0 = ang - f.flip * sweep / 2;
    const aHead = a0 + f.flip * sweep * head;
    const aTail = a0 + f.flip * sweep * tail;
    if (Math.abs(aHead - aTail) < 0.02) return;
    const fade = 1 - clamp01((t - 0.5) / 0.5);
    const width = (f.heavy ? 28 : 20) * (1 - t * 0.45);
    const n = 16;
    const pts = new Array(n * 2);
    const ws = new Array(n);
    for (let i = 0; i < n; i++) {
      const k = i / (n - 1);
      const a = aTail + (aHead - aTail) * k;
      pts[i * 2] = sp.x + Math.cos(a) * reach;
      pts[i * 2 + 1] = cy + Math.sin(a) * reach * 0.8;
      ws[i] = width * (0.25 + 0.75 * Math.sin(Math.min(1, k * 1.15) * Math.PI * 0.5));
    }
    const scaled = (m) => ws.map((w) => w * m);
    ribbons.stroke(pts, scaled(1.7), 0x08030c, 0.6 * fade, 'ink');
    ribbons.stroke(pts, scaled(2.2), f.color, 0.75 * fade, 'glow');
    ribbons.stroke(pts, scaled(1), whitenHex(f.rgb, 0.45), fade, 'glow');
    ribbons.stroke(pts, scaled(0.4), 0xffffff, fade, 'glow');
    // 刀尖的闪光
    const gx = pts[(n - 1) * 2];
    const gy = pts[(n - 1) * 2 + 1];
    blit(sprites, glow(f.color), gx, gy, 18 * fade, 0.85 * fade);
  }

  // whirlBlades 是旋风斩的三道风刃：绕着施法者转，头亮尾淡，地面上压扁成椭圆。
  whirlBlades(ribbons, f, t) {
    const R = f.radius;
    const fade = 1 - clamp01((t - 0.5) / 0.5);
    const spin = easeOut(t) * TAU * 1.8;
    const grow = easeOut(clamp01(t / 0.3 + 0.2));
    const n = 14;
    for (let blade = 0; blade < 3; blade++) {
      const r = R * (0.5 + 0.22 * blade) * grow;
      const a0 = spin + (blade * TAU) / 3;
      const len = 2.0 - blade * 0.25;
      const pts = new Array(n * 2);
      const ws = new Array(n);
      for (let i = 0; i < n; i++) {
        const k = i / (n - 1);
        const a = a0 + len * k;
        pts[i * 2] = f.cx + Math.cos(a) * r;
        pts[i * 2 + 1] = f.cy - 14 + Math.sin(a) * r * 0.5;
        ws[i] = (12 - blade * 2.5) * (0.3 + 0.7 * k);
      }
      ribbons.stroke(pts, ws.map((w) => w * 1.8), f.color, 0.7 * fade, 'glow');
      ribbons.stroke(pts, ws.map((w) => w * 0.45), 0xffffff, 0.9 * fade, 'glow');
    }
  }

  // projectilePath 是法球或箭在进度 k 时的位置（略微上拱的弧线）。
  projectilePath(f, k, lift) {
    const sp = this.pos(f.src, { x: f.sx, y: f.sy, r: f.sr });
    const dp = this.pos(f.dst, { x: f.dx, y: f.dy, r: f.dr });
    const x0 = sp.x, y0 = sp.y - (sp.r || 14) * (f.kind === 'orb' ? 1.3 : 1.2);
    const x1 = dp.x, y1 = dp.y - (dp.r || 14) * 1.0;
    const arc = Math.sin(k * Math.PI) * Math.min(lift, Math.hypot(x1 - x0, y1 - y0) * (f.kind === 'orb' ? 0.12 : 0.08));
    return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k - arc };
  }

  // trailPoints 取弹道最近一段的位置做尾迹：从 k - span 到 k。
  trailPoints(f, k, span, lift, width) {
    const n = 10;
    const pts = new Array(n * 2);
    const ws = new Array(n);
    for (let i = 0; i < n; i++) {
      const q = Math.max(0, k - span * (1 - i / (n - 1)));
      const p = this.projectilePath(f, q, lift);
      pts[i * 2] = p.x;
      pts[i * 2 + 1] = p.y;
      ws[i] = width * (0.2 + 0.8 * (i / (n - 1)));
    }
    return { pts, ws };
  }

  orb(ribbons, sprites, f, t, now) {
    const k = clamp01(t);
    const { x, y } = this.projectilePath(f, k, 40);
    const trail = this.trailPoints(f, k, 0.35, 40, 22);
    ribbons.stroke(trail.pts, trail.ws, f.color, 0.7, 'glow');
    ribbons.stroke(trail.pts, trail.ws.map((w) => w * 0.35), 0xffffff, 0.8, 'glow');
    const flick = 1 + Math.sin(now / 30) * 0.1;
    blit(sprites, glow(f.color), x, y, 26 * flick, 0.9);
    blit(sprites, glow('#ffffff'), x, y, 8, 1);
  }

  // arrowTrail 是箭后面一道细细的风痕。
  arrowTrail(ribbons, f, t) {
    const trail = this.trailPoints(f, clamp01(t), 0.22, 28, 5);
    ribbons.stroke(trail.pts, trail.ws, f.color, 0.55, 'glow');
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

  // bubbleShape 是护盾泡泡的椭圆：罩住脚到头顶，略宽于身体。
  bubbleShape(x: number, y: number, r: number, h: number) {
    const ry = h * 0.62 + 6;
    return { cx: x, cy: y - h * 0.5 + 2, rx: Math.max(r * 1.9, ry * 0.78), ry };
  }

  // drawBubble 画一个护盾泡泡。k 是整体亮度，flash 是受击闪光（0..1），ping 是波纹的位置角和进度。
  drawBubble(ctx, b, k: number, flash: number, now: number) {
    const { cx, cy, rx, ry } = b;
    const rgb = rgbOf('#7fd8ff');
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    // 球面：中间透明，越靠边越亮
    const g = ctx.createRadialGradient(0, 0, rx * 0.55, 0, 0, rx);
    g.addColorStop(0, rgba(rgb, 0));
    g.addColorStop(0.8, rgba(rgb, 0.1 * k + 0.25 * flash));
    g.addColorStop(1, rgba(rgb, 0.32 * k + 0.4 * flash));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, TAU);
    ctx.fill();
    // 边缘细线
    ctx.strokeStyle = rgba(whiten(rgb, 0.4), 0.45 * k + 0.5 * flash);
    ctx.lineWidth = 1.4 * rx / ry;
    ctx.stroke();
    // 六边形网格：沿着一条斜带慢慢扫过去，只在带子里显出来
    const cell = 9;
    const sweep = ((now / 1400) % 1) * rx * 3 - rx * 1.5;
    ctx.lineWidth = 0.9;
    for (let gy = -rx; gy <= rx; gy += cell * 1.5) {
      const row = Math.round(gy / (cell * 1.5));
      for (let gx = -rx + (row & 1 ? cell * 0.866 : 0); gx <= rx; gx += cell * 1.732) {
        const d = Math.hypot(gx, gy) / rx;
        if (d > 0.93) continue;
        const band = Math.max(0, 1 - Math.abs(gx * 0.7 + gy * 0.7 - sweep) / (rx * 0.35));
        const a = (band * 0.35 * k + flash * 0.3) * (0.3 + d * 0.7);
        if (a < 0.02) continue;
        ctx.strokeStyle = rgba(rgb, a);
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const ang = Math.PI / 6 + (i * TAU) / 6;
          const hx = gx + Math.cos(ang) * cell * 0.92;
          const hy = gy + Math.sin(ang) * cell * 0.92;
          if (i) ctx.lineTo(hx, hy); else ctx.moveTo(hx, hy);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }
    // 左上角一道高光弧
    ctx.strokeStyle = rgba([255, 255, 255], 0.35 * k + 0.3 * flash);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, rx * 0.84, -2.55, -1.75);
    ctx.stroke();
    ctx.restore();
  }

  // shieldAuras 画所有带护盾实体身上的泡泡（受击时闪一下）。
  shieldAuras(ctx, now: number) {
    for (const a of this.auras()) {
      let flash = 0;
      let ping = null;
      for (const f of this.effects) {
        if (f.kind !== 'shieldPing' || f.anchor !== a.id) continue;
        const t = (now - f.born) / f.life;
        if (t < 0 || t >= 1) continue;
        flash = Math.max(flash, 1 - t);
        ping = { f, t };
      }
      // 护盾快破时闪烁
      const low = a.frac < 0.3 ? 0.55 + 0.45 * Math.sin(now / 70) : 1;
      const k = (0.55 + 0.45 * a.frac) * low;
      const b = this.bubbleShape(a.x, a.y, a.r, a.h);
      this.drawBubble(ctx, b, k, flash, now);
      if (ping) {
        // 受击处的波纹：从泡泡表面的一点荡开
        const { f, t } = ping;
        const px = b.cx + Math.cos(f.a) * b.rx;
        const py = b.cy + Math.sin(f.a) * b.ry;
        ctx.save();
        ctx.translate(px, py);
        ctx.strokeStyle = rgba(f.rgb, (1 - t) * 0.9);
        ctx.lineWidth = 3 * (1 - t) + 0.5;
        ctx.beginPath();
        ctx.ellipse(0, 0, 4 + 22 * easeOut(t), 3 + 14 * easeOut(t), f.a + Math.PI / 2, 0, TAU);
        ctx.stroke();
        ctx.restore();
        blit(ctx, glow(f.color), px, py, 26 * (1 - t) + 6, 1 - t);
      }
    }
  }

  // shieldForm 是护盾成形：泡泡从一圈亮光收拢、显出网格，然后交给 shieldAuras 常驻显示。
  shieldForm(ctx, f, t) {
    const p = this.pos(f.src, { x: f.sx, y: f.sy, r: f.sr });
    const h = p.h || (p.r || 14) * 2.6;
    const b = this.bubbleShape(p.x, p.y, p.r || 14, h);
    const grow = easeOutCubic(clamp01(t / 0.55));
    const s = 1.6 - 0.6 * grow;
    this.drawBubble(ctx, { cx: b.cx, cy: b.cy, rx: b.rx * s, ry: b.ry * s }, grow, 1 - grow * 0.7, f.born + t * f.life);
    // 收拢时的白色外环
    ctx.save();
    ctx.translate(b.cx, b.cy);
    ctx.scale(1, b.ry / b.rx);
    ctx.strokeStyle = rgba([255, 255, 255], (1 - t) * 0.8);
    ctx.lineWidth = 3 * (1 - t) + 0.5;
    ctx.beginPath();
    ctx.arc(0, 0, b.rx * (2.2 - 1.2 * grow), 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // parry 是格挡时盾面上的一道弧光。
  parry(ctx, f, t) {
    const p = this.pos(f.anchor, null);
    const x = p ? p.x + f.ox : f.x;
    const y = p ? p.y + f.oy : f.y;
    const fade = 1 - t;
    const R = f.r * (1.2 + 0.5 * easeOut(t));
    const mid = f.dir > 0 ? 0 : Math.PI;
    ctx.save();
    ctx.strokeStyle = rgba(whiten(f.rgb, 0.5), fade);
    ctx.lineWidth = 5 * fade + 1;
    ctx.beginPath();
    ctx.arc(x - f.dir * R * 0.6, y, R, mid - 0.9, mid + 0.9);
    ctx.stroke();
    ctx.restore();
    blit(ctx, glow('#cfeeff'), x, y, 34 * fade + 8, fade);
  }

  gash(ctx, f, t) {
    const grow = easeOutCubic(clamp01(t / 0.35));
    const fade = 1 - clamp01((t - 0.35) / 0.65);
    const L = f.len * grow;
    const W = 4.5 * fade + 0.5;
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.ang);
    const blade = (w, color, alpha) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(-L, 0); ctx.lineTo(0, -w); ctx.lineTo(L, 0); ctx.lineTo(0, w);
      ctx.closePath();
      ctx.fill();
    };
    ctx.globalCompositeOperation = 'source-over';
    blade(W * 2.2, '#08030c', 0.7 * fade);
    ctx.globalCompositeOperation = 'lighter';
    blade(W * 1.6, rgba(f.rgb, 0.9), fade);
    blade(W * 0.6, '#ffffff', fade);
    ctx.restore();
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

  // particles 用 GPU 精灵画全部粒子（ctx 是 pixi/spriteCtx.ts 的 SpriteCtx，加法混合）。
  particles(ctx, now, dt) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
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
          ctx.streak(x, y, x - p.vx * 28, y - p.vy * 28, p.size, p.color);
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
          ctx.disc(x, y, p.size * (0.6 + k), p.color);
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
    ctx.restore();
  }
}
