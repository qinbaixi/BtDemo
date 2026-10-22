// 地上的回血区：出生点的常驻泉水（look = spring）和“治愈之泉”放下的法阵（look = rune）。
//
// 每块区域两张只覆盖自己范围的小画布：base 正常混合（地面的底色、池沿的石头、线条的墨线和色线），
// glow 加法混合（线条的亮芯、水面的光）。往上飘的光点交给 fx 的粒子，照亮周围交给动态光照。
// 区域是压扁的椭圆（纵向半径 = 横向半径 × ZONE_ASPECT），和服务端判断站没站在里面的范围一致。

import type { Container } from 'pixi.js';
import { ZONE_ASPECT } from '../game/config';
import type { ClientZone } from '../game/state';
import type { FX } from './fx';
import { CanvasSprite } from './pixi/canvasSprite';

export const ZONE_FADE_MS = 700;   // 服务端去掉之后淡出多久
const BIRTH_MS = 650;              // 法阵从掌心铺开要多久
const END_FADE_MS = 1500;          // 到时间前多久开始变淡
const WARN_S = 5;                  // 最后几秒闪烁提醒
const POOL_R = 30;                 // 泉水池的半径（压扁前）
const TAU = Math.PI * 2;

const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const rand = (a: number, b: number) => a + Math.random() * (b - a);

type RGB = [number, number, number];

function rgbOf(hex: string | undefined): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0x7dffb0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba([r, g, b]: RGB, a: number): string {
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

// whiten 把颜色往白色混 k（0..1）
function whiten([r, g, b]: RGB, k: number): RGB {
  return [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k];
}

// 一块区域这一帧的状态：显不显示、整体透明度、铺开进度、剩余时间比例、回血脉冲的相位
interface Phase {
  alpha: number;
  grow: number;       // 0..1 铺开进度
  birth: number;      // 0..1 出现的进度（线性）
  left: number;       // 0..1 剩余时间占总时长的比例；常驻的为 1
  leftS: number;      // 剩余秒数；常驻的为 Infinity
  pulse: number;      // 0..1 本次回血脉冲的进度
}

function phaseOf(zone: ClientZone, now: number): Phase | null {
  if (now < zone.born) return null;
  const birth = clamp01((now - zone.born) / BIRTH_MS);
  const leftMs = zone.endsAt ? zone.endsAt - now : Infinity;
  const total = (zone.dur || 0) * 1000;
  const left = zone.endsAt && total > 0 ? clamp01(leftMs / total) : 1;
  let alpha = Math.min(clamp01(birth * 3), zone.endsAt ? clamp01(leftMs / END_FADE_MS) : 1);
  if (zone.goneAt) alpha *= 1 - clamp01((now - zone.goneAt) / ZONE_FADE_MS);
  // 快到时间了：一闪一闪地提醒
  if (leftMs < WARN_S * 1000) alpha *= 0.72 + 0.28 * Math.cos((now - zone.born) / 95);
  if (alpha <= 0.003) return null;
  const interval = (zone.interval || 1) * 1000;
  // 服务端从放下的那一刻起每隔 interval 回一次血，脉冲跟着这个节奏（不是跟着铺开动画）
  const pulse = (((now - zone.pulseFrom) % interval) + interval) % interval / interval;
  return { alpha, grow: easeOutCubic(birth), birth, left, leftS: leftMs / 1000, pulse };
}

// 一块区域的两张画布
class ZoneView {
  readonly base = new CanvasSprite();
  readonly glow = new CanvasSprite();

  constructor(layer: Container) {
    this.glow.blendMode = 'add';
    layer.addChild(this.base, this.glow);
  }

  hide(): void {
    this.base.visible = false;
    this.glow.visible = false;
  }

  destroy(): void {
    this.base.destroy();
    this.glow.destroy();
  }
}

// ZoneLayer 把 state.zones 画到 layer 上（地表之上、地面标记和角色之下）。
export class ZoneLayer {
  private views = new Map<number, ZoneView>();
  private moteDebt = new Map<number, number>();   // 区域 id -> 还欠着没冒出来的光点（小数部分）

  constructor(readonly layer: Container) {}

  // update 画一帧；view 是镜头范围，镜头外的区域不画。
  update(zones: ClientZone[], now: number, view: { x: number; y: number; w: number; h: number }, res: number): void {
    const alive = new Set<number>();
    for (const zone of zones) {
      alive.add(zone.id);
      let zoneView = this.views.get(zone.id);
      if (!zoneView) {
        zoneView = new ZoneView(this.layer);
        this.views.set(zone.id, zoneView);
      }
      const phase = phaseOf(zone, now);
      const box = boxOf(zone);
      const onScreen = box[2] > view.x && box[0] < view.x + view.w && box[3] > view.y && box[1] < view.y + view.h;
      if (!phase || !onScreen) { zoneView.hide(); continue; }
      zoneView.base.visible = zoneView.glow.visible = true;
      const spring = zone.look === 'spring';
      zoneView.base.paint(box, res, (ctx) => (spring ? springBase : runeBase)(ctx, zone, phase, now));
      zoneView.glow.paint(box, res, (ctx) => (spring ? springGlow : runeGlow)(ctx, zone, phase, now));
    }
    for (const [id, zoneView] of this.views) {
      if (!alive.has(id)) {
        zoneView.destroy();
        this.views.delete(id);
        this.moteDebt.delete(id);
      }
    }
  }

  // motes 让镜头里的区域往上冒光点和小十字（fx 的粒子，参与泛光）。
  motes(fx: FX, zones: ClientZone[], now: number, dt: number, view: { x: number; y: number; w: number; h: number }): void {
    for (const zone of zones) {
      const phase = phaseOf(zone, now);
      const box = boxOf(zone);
      if (!phase || phase.alpha < 0.3 || zone.goneAt) continue;
      if (box[2] < view.x || box[0] > view.x + view.w || box[3] < view.y || box[1] > view.y + view.h) continue;
      const radius = zone.radius * phase.grow;
      // 每秒的光点数随面积变化：半径 110 的法阵大约每秒 7 个
      const perSecond = 6 * (radius / 110) * (radius / 110) + 1;
      let debt = (this.moteDebt.get(zone.id) ?? 0) + (perSecond * Math.min(dt, 100)) / 1000;
      const color = zone.color || '#7dffb0';
      for (; debt >= 1; debt--) {
        const angle = rand(0, TAU);
        const distance = Math.sqrt(Math.random()) * radius * 0.95;
        const plus = Math.random() < 0.18;
        fx.spawn({
          x: zone.x + Math.cos(angle) * distance,
          y: zone.y + Math.sin(angle) * distance * ZONE_ASPECT - 2,
          vx: rand(-0.004, 0.004),
          vy: -rand(0.022, 0.05),
          life: rand(1300, 2300),
          size: plus ? rand(1.6, 2.2) : rand(1.6, 3.2),
          color: Math.random() < 0.3 ? '#eafff0' : color,
          kind: plus ? 'plus' : 'wisp',
          born: now,
        });
      }
      this.moteDebt.set(zone.id, debt);
    }
  }

  clear(): void {
    for (const zoneView of this.views.values()) zoneView.destroy();
    this.views.clear();
    this.moteDebt.clear();
  }
}

// pruneZones 去掉淡出完的区域（服务端早就去掉了，只是留着画淡出）。
export function pruneZones(zones: ClientZone[], now: number): ClientZone[] {
  return zones.some((zone) => zone.goneAt && now - zone.goneAt >= ZONE_FADE_MS)
    ? zones.filter((zone) => !zone.goneAt || now - zone.goneAt < ZONE_FADE_MS)
    : zones;
}

// zoneLights 报告区域照亮周围的光（绿色的柔光，回血脉冲时亮一下）。
export function zoneLights(
  add: (x: number, y: number, radius: number, color: string, strength?: number, glow?: number) => void,
  zones: ClientZone[],
  now: number,
): void {
  for (const zone of zones) {
    const phase = phaseOf(zone, now);
    if (!phase) continue;
    const beat = Math.pow(1 - phase.pulse, 3);
    const spring = zone.look === 'spring';
    // 光不要太强：出生点在亮的石板广场上，照多了会白成一片
    const strength = (spring ? 0.45 : 0.38) * phase.alpha * (1 + 0.3 * beat);
    add(zone.x, zone.y - 8, zone.radius * phase.grow * 1.3, zone.color || '#7dffb0', strength, 0.2);
  }
}

// boxOf 是区域画布要覆盖的范围（世界坐标）：椭圆加上铺开时外扩的闪光和池沿厚度
function boxOf(zone: ClientZone): number[] {
  const rx = zone.radius * 1.18 + 6;
  const ry = zone.radius * ZONE_ASPECT * 1.18 + 10;
  return [zone.x - rx, zone.y - ry, zone.x + rx, zone.y + ry];
}

// inEllipse 把画布变换到区域中心、纵向压扁，接下来按圆来画
function inEllipse(ctx: CanvasRenderingContext2D, zone: ClientZone, fn: () => void): void {
  ctx.save();
  ctx.translate(zone.x, zone.y);
  ctx.scale(1, ZONE_ASPECT);
  fn();
  ctx.restore();
}

function circle(ctx: CanvasRenderingContext2D, radius: number): void {
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(0, radius), 0, TAU);
}

/* ------------------------------ 画笔 ------------------------------ */

// 光环、符文这些线条画三遍，叠起来在亮的石板地和暗的草地上都看得清：
//   ink    墨色粗线衬底（正常混合，和角色的描边一个风格）
//   color  区域颜色压暗一点的实线（正常混合）
//   glow   细的亮芯（加法混合，暗处发光、交给泛光）
type Pass = 'ink' | 'color' | 'glow';
const INK: RGB = [6, 22, 14];

class Pen {
  private readonly mid: RGB;

  constructor(
    readonly ctx: CanvasRenderingContext2D,
    readonly pass: Pass,
    readonly rgb: RGB,
  ) {
    this.mid = darken(rgb, 0.42);
  }

  // stroke 描当前路径。hot（0..1）越大越接近白色
  stroke(width: number, alpha: number, hot = 0): void {
    const ctx = this.ctx;
    if (this.pass === 'ink') {
      ctx.lineWidth = width * 1.3 + 3;
      ctx.strokeStyle = rgba(INK, Math.min(1, alpha * 1.2) * 0.85);
    } else if (this.pass === 'color') {
      ctx.lineWidth = width * 1.3;
      ctx.strokeStyle = rgba(whiten(this.mid, hot * 0.6), Math.min(1, alpha * 1.15));
    } else {
      ctx.lineWidth = Math.max(0.8, width * 0.6);
      ctx.strokeStyle = rgba(whiten(this.rgb, 0.35 + hot * 0.5), alpha * 0.5);
    }
    ctx.stroke();
  }

  // fill 填充当前路径（墨色那遍不填）
  fill(alpha: number, hot = 0): void {
    const ctx = this.ctx;
    if (this.pass === 'ink') return;
    ctx.fillStyle = this.pass === 'color'
      ? rgba(whiten(darken(this.rgb, 0.4), hot * 0.5), alpha * 0.7)
      : rgba(whiten(this.rgb, hot * 0.6), alpha * 0.4);
    ctx.fill();
  }

  // dot 画一个实心小圆点（墨色那遍画大一圈的底）
  dot(x: number, y: number, r: number, alpha: number, hot = 0): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, this.pass === 'ink' ? r + 1.6 : r, 0, TAU);
    if (this.pass === 'ink') {
      ctx.fillStyle = rgba(INK, alpha * 0.75);
      ctx.fill();
    } else this.fill(alpha * 1.6, hot);
  }
}

function darken([r, g, b]: RGB, k: number): RGB {
  return [r * (1 - k), g * (1 - k), b * (1 - k)];
}

/* ------------------------------ 泉水 ------------------------------ */

// springBase：地面微微染绿，中间一圈石头池沿和一池水，再加区域边缘的墨线和色线
function springBase(ctx: CanvasRenderingContext2D, zone: ClientZone, phase: Phase, now: number): void {
  const R = zone.radius;
  const rgb = rgbOf(zone.color);
  ctx.globalAlpha = phase.alpha;
  inEllipse(ctx, zone, () => {
    const ground = ctx.createRadialGradient(0, 0, POOL_R, 0, 0, R);
    const tint = darken(rgb, 0.55);
    ground.addColorStop(0, rgba(tint, 0.28));
    ground.addColorStop(0.8, rgba(tint, 0.14));
    ground.addColorStop(1, rgba(tint, 0.24));
    ctx.fillStyle = ground;
    circle(ctx, R);
    ctx.fill();
  });
  springLines(ctx, zone, phase, now, 'ink');
  springLines(ctx, zone, phase, now, 'color');
  // 池沿前面露出的侧面（往下错开几个像素），让池子有厚度
  ctx.save();
  ctx.translate(0, 4);
  inEllipse(ctx, zone, () => {
    circle(ctx, POOL_R + 9);
    ctx.fillStyle = '#272a35';
    ctx.fill();
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = '#120d16';
    ctx.stroke();
  });
  ctx.restore();
  inEllipse(ctx, zone, () => {
    // 池沿顶面：一圈石头
    ctx.beginPath();
    ctx.arc(0, 0, POOL_R + 9, 0, TAU);
    ctx.arc(0, 0, POOL_R, 0, TAU, true);
    ctx.fillStyle = '#545a68';
    ctx.fill();
    // 石缝
    ctx.strokeStyle = '#120d16';
    ctx.lineWidth = 1.3;
    const stones = 12;
    for (let i = 0; i < stones; i++) {
      const angle = (i / stones) * TAU + Math.sin(i * 7.3 + zone.seed) * 0.12;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * POOL_R, Math.sin(angle) * POOL_R);
      ctx.lineTo(Math.cos(angle) * (POOL_R + 9), Math.sin(angle) * (POOL_R + 9));
      ctx.stroke();
    }
    // 石头朝上的亮边（光从左上来）
    ctx.strokeStyle = '#8a91a1';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(0, 0, POOL_R + 6.5, Math.PI * 1.05, Math.PI * 1.75);
    ctx.stroke();
    // 水：靠近池沿深，中间浅
    const water = ctx.createRadialGradient(0, 4, 2, 0, 0, POOL_R);
    water.addColorStop(0, '#36c9a4');
    water.addColorStop(0.65, '#17736e');
    water.addColorStop(1, '#0a3439');
    ctx.fillStyle = water;
    circle(ctx, POOL_R);
    ctx.fill();
    // 墨线描边：池沿内外两圈
    ctx.strokeStyle = '#120d16';
    ctx.lineWidth = 2;
    circle(ctx, POOL_R);
    ctx.stroke();
    circle(ctx, POOL_R + 9);
    ctx.stroke();
  });
}

// springLines：区域边缘缓缓转动的虚线光圈、每次回血从池沿推到边上的一圈光、边上一闪一闪的小星
function springLines(ctx: CanvasRenderingContext2D, zone: ClientZone, phase: Phase, now: number, pass: Pass): void {
  const R = zone.radius;
  const pen = new Pen(ctx, pass, rgbOf(zone.color));
  inEllipse(ctx, zone, () => {
    circle(ctx, R);
    pen.stroke(1.2, 0.45);
    ctx.setLineDash([22, 12]);
    ctx.lineDashOffset = -now / 70;
    circle(ctx, R - 6);
    pen.stroke(2.4, 0.9, 0.3);
    ctx.setLineDash([]);
    if (phase.pulse < 0.98) {
      const wave = POOL_R + 10 + (R - POOL_R - 16) * easeOut(phase.pulse);
      circle(ctx, wave);
      pen.stroke(2.2, 0.7 * (1 - phase.pulse), 0.5);
    }
    if (pass === 'ink') return;
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * TAU + zone.seed;
      const twinkle = Math.max(0, Math.sin(now / 420 + i * 2.1));
      if (twinkle < 0.05) continue;
      const color = pass === 'glow' ? rgba(whiten(rgbOf(zone.color), 0.7), 0.8 * twinkle) : rgba(darken(rgbOf(zone.color), 0.25), 0.9 * twinkle);
      star(ctx, Math.cos(angle) * (R - 6), Math.sin(angle) * (R - 6), 5 * twinkle, color);
    }
  });
}

// springGlow：边缘光圈的亮芯、水面的光、往外扩的涟漪
function springGlow(ctx: CanvasRenderingContext2D, zone: ClientZone, phase: Phase, now: number): void {
  const rgb = rgbOf(zone.color);
  const bright = whiten(rgb, 0.55);
  ctx.globalAlpha = phase.alpha;
  springLines(ctx, zone, phase, now, 'glow');
  inEllipse(ctx, zone, () => {
    // 水面发光，随呼吸微微明暗
    const breath = 0.85 + 0.15 * Math.sin(now / 700);
    const shine = ctx.createRadialGradient(0, 2, 0, 0, 0, POOL_R);
    shine.addColorStop(0, rgba(bright, 0.6 * breath));
    shine.addColorStop(0.6, rgba(rgb, 0.22 * breath));
    shine.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = shine;
    circle(ctx, POOL_R);
    ctx.fill();
    // 涟漪：三圈从中间往外扩
    ctx.lineWidth = 1.3;
    for (let i = 0; i < 3; i++) {
      const ripple = (now / 1900 + i / 3 + zone.seed) % 1;
      ctx.strokeStyle = rgba(bright, 0.5 * (1 - ripple));
      circle(ctx, 3 + ripple * (POOL_R - 4));
      ctx.stroke();
    }
  });
}

/* ------------------------------ 法阵 ------------------------------ */

// runeBase：法阵烙在地上的暗绿底色，加线条的墨线和色线两遍
function runeBase(ctx: CanvasRenderingContext2D, zone: ClientZone, phase: Phase, now: number): void {
  const R = zone.radius * phase.grow;
  const tint = darken(rgbOf(zone.color), 0.55);
  ctx.globalAlpha = phase.alpha;
  inEllipse(ctx, zone, () => {
    const ground = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    ground.addColorStop(0, rgba(tint, 0.3));
    ground.addColorStop(0.7, rgba(tint, 0.14));
    ground.addColorStop(1, rgba(tint, 0.26));
    ctx.fillStyle = ground;
    circle(ctx, R);
    ctx.fill();
  });
  runeLines(ctx, zone, phase, now, 'ink');
  runeLines(ctx, zone, phase, now, 'color');
}

// runeGlow：线条的亮芯和中心的光
function runeGlow(ctx: CanvasRenderingContext2D, zone: ClientZone, phase: Phase, now: number): void {
  const rgb = rgbOf(zone.color);
  const beat = Math.pow(1 - phase.pulse, 3);
  ctx.globalAlpha = phase.alpha;
  runeLines(ctx, zone, phase, now, 'glow');
  inEllipse(ctx, zone, () => {
    const radius = zone.radius * 0.36 * phase.grow;
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    core.addColorStop(0, rgba(whiten(rgb, 0.5), 0.25 + 0.3 * beat));
    core.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = core;
    circle(ctx, radius);
    ctx.fill();
  });
}

// runeLines：外圈两道光环（粗亮的那段是剩余时间）、一圈慢慢转的符文、中间六片叶子、回血时往外推的光圈
function runeLines(ctx: CanvasRenderingContext2D, zone: ClientZone, phase: Phase, now: number, pass: Pass): void {
  const R = zone.radius;
  const grow = phase.grow;
  const pen = new Pen(ctx, pass, rgbOf(zone.color));
  const beat = Math.pow(1 - phase.pulse, 3);
  const turn = ((now - zone.born) / 1000) * 0.22 + zone.seed;
  const inner = clamp01((phase.birth - 0.35) / 0.45);   // 符文和叶子在外圈铺开之后才亮起来
  inEllipse(ctx, zone, () => {
    // 外圈：一道细的整圈，一道粗的倒计时弧（从正上方顺时针，剩多少画多少）
    circle(ctx, R * grow);
    pen.stroke(1.4, 0.75);
    circle(ctx, R * 0.88 * grow);
    pen.stroke(1.1, 0.6);
    if (phase.left > 0.002) {
      const start = -Math.PI / 2;
      const end = start + TAU * phase.left;
      ctx.beginPath();
      ctx.arc(0, 0, R * grow, start, end);
      pen.stroke(3.6, 0.95, 0.35);
      pen.dot(Math.cos(end) * R * grow, Math.sin(end) * R * grow, 3.4, 1, 1);
    }

    if (inner > 0) {
      ctx.save();
      ctx.globalAlpha *= inner;
      // 符文带：两道光环之间一圈小符号，慢慢转
      const glyphs = 16;
      for (let i = 0; i < glyphs; i++) {
        const angle = (i / glyphs) * TAU + turn;
        ctx.save();
        ctx.translate(Math.cos(angle) * R * 0.94 * grow, Math.sin(angle) * R * 0.94 * grow);
        ctx.rotate(angle + Math.PI / 2);
        glyph(ctx, (i * 5 + Math.floor(zone.seed)) % 4, 4);
        pen.stroke(1.4, 0.9, 0.2);
        ctx.restore();
      }
      // 内圈和一圈小点
      circle(ctx, R * 0.6 * grow);
      pen.stroke(1.2, 0.7);
      for (let i = 0; i < 20; i++) {
        const angle = (i / 20) * TAU - turn * 0.5;
        pen.dot(Math.cos(angle) * R * 0.69 * grow, Math.sin(angle) * R * 0.69 * grow, 1.3, 0.8);
      }
      // 六片叶子从中心长出去，反着转，回血时张开一点
      const petals = 6;
      const reach = R * 0.52 * grow * (0.94 + 0.06 * beat);
      for (let i = 0; i < petals; i++) {
        const angle = (i / petals) * TAU - turn * 0.6;
        ctx.save();
        ctx.rotate(angle);
        leaf(ctx, reach * 0.18, reach);
        pen.fill(0.22 + 0.2 * beat, beat);
        pen.stroke(1.5, 0.85, 0.15);
        ctx.beginPath();
        ctx.moveTo(reach * 0.24, 0);
        ctx.lineTo(reach * 0.85, 0);
        pen.stroke(0.8, 0.6);
        ctx.restore();
      }
      circle(ctx, R * 0.12 * grow);
      pen.stroke(1.4, 0.85, 0.3);
      ctx.restore();
    }

    // 回血脉冲：一圈光从中心推到外圈
    if (phase.birth >= 1 && phase.pulse < 0.98) {
      circle(ctx, R * (0.15 + 0.8 * easeOut(phase.pulse)));
      pen.stroke(2.4, 0.75 * (1 - phase.pulse), 0.5);
    }
    // 铺开时外圈前面跑着一道光
    if (phase.birth < 1) {
      circle(ctx, R * (grow + 0.1 * phase.birth));
      pen.stroke(1 + 4 * (1 - phase.birth), 0.9 * (1 - phase.birth), 0.8);
    }
  });
}

// glyph 画一个小符号（局部坐标，size 是半高）：0 竖线带勾、1 尖角、2 小叶、3 圆点和横杠
function glyph(ctx: CanvasRenderingContext2D, kind: number, size: number): void {
  ctx.beginPath();
  switch (kind) {
    case 0:
      ctx.moveTo(0, -size);
      ctx.lineTo(0, size);
      ctx.moveTo(0, -size * 0.3);
      ctx.lineTo(size * 0.7, -size * 0.8);
      break;
    case 1:
      ctx.moveTo(-size * 0.75, size * 0.6);
      ctx.lineTo(0, -size * 0.7);
      ctx.lineTo(size * 0.75, size * 0.6);
      break;
    case 2:
      ctx.moveTo(0, -size);
      ctx.quadraticCurveTo(size * 0.9, 0, 0, size);
      ctx.quadraticCurveTo(-size * 0.9, 0, 0, -size);
      break;
    default:
      ctx.arc(0, -size * 0.45, size * 0.35, 0, TAU);
      ctx.moveTo(-size * 0.7, size * 0.5);
      ctx.lineTo(size * 0.7, size * 0.5);
  }
  ctx.stroke();
}

// leaf 沿 +x 方向画一片叶子的路径：从 start 到 tip，中间最宽
function leaf(ctx: CanvasRenderingContext2D, start: number, tip: number): void {
  const width = (tip - start) * 0.26;
  const middle = (start + tip) / 2;
  ctx.beginPath();
  ctx.moveTo(start, 0);
  ctx.quadraticCurveTo(middle, -width * 2, tip, 0);
  ctx.quadraticCurveTo(middle, width * 2, start, 0);
  ctx.closePath();
}

// star 画一颗四角星
function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x + r * 0.18, y - r * 0.18, x + r, y);
  ctx.quadraticCurveTo(x + r * 0.18, y + r * 0.18, x, y + r);
  ctx.quadraticCurveTo(x - r * 0.18, y + r * 0.18, x - r, y);
  ctx.quadraticCurveTo(x - r * 0.18, y - r * 0.18, x, y - r);
  ctx.fillStyle = color;
  ctx.fill();
}
