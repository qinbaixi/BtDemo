// 传送门：通往别的场景的门（Welcome.scene.portals，地图 portals 图层）。站进去一会儿（服务端 0.6 秒）就出发。
//
// 画法和回血区一样，每扇门两张只覆盖自己范围的小画布：
//   base  正常混合：一圈刻着符文的黑石门框、门里深色的漩涡底、墨线描边
//   glow  加法混合：转动的漩涡光臂、门心的亮光、门框上的符文（交给泛光）
// 往上飘的光点交给 fx 的粒子，照亮周围交给动态光照，门上方的“通往 xx”写在叠加层（drawPortalLabels）。
// 门的颜色按去的场景：去墓园是幽紫色，回村子是暖金色，没配的场景用青色。

import type { Container } from 'pixi.js';
import { FONT, ZONE_ASPECT } from '../game/config';
import { hypot } from '../game/math';
import type { PortalInfo } from '../net/types';
import type { FX } from './fx';
import { CanvasSprite } from './pixi/canvasSprite';

const TAU = Math.PI * 2;
const DWELL_MS = 600;           // 站进去多久出发（服务端 portal.Dwell）
const RIM = 9;                  // 门框石圈的宽度（压扁前）
const ARMS = 5;                 // 漩涡光臂的条数

// 去各个场景的门的颜色：[亮色, 暗色]
const PORTAL_COLORS: Record<string, [string, string]> = {
  graveyard: ['#b99bff', '#2a1846'],
  village: ['#ffd98a', '#3a2610'],
};
const DEFAULT_COLORS: [string, string] = ['#8ef0ff', '#0f2c38'];

type RGB = [number, number, number];

function rgbOf(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba([r, g, b]: RGB, a: number): string {
  return `rgba(${r | 0},${g | 0},${b | 0},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

function whiten([r, g, b]: RGB, k: number): RGB {
  return [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k];
}

function colorsOf(portal: PortalInfo): { light: RGB; dark: RGB; hex: string } {
  const [light, dark] = PORTAL_COLORS[portal.to] || DEFAULT_COLORS;
  return { light: rgbOf(light), dark: rgbOf(dark), hex: light };
}

// boxOf 是门的画布范围（世界坐标）：门框外沿再留一点给描边和光晕
function boxOf(portal: PortalInfo): number[] {
  const rx = portal.r + RIM + 8;
  const ry = (portal.r + RIM) * ZONE_ASPECT + 12;
  return [portal.x - rx, portal.y - ry - 4, portal.x + rx, portal.y + ry];
}

// inEllipse 把画布变换到门中心、纵向压扁，接下来按圆来画
function inEllipse(ctx: CanvasRenderingContext2D, portal: PortalInfo, fn: () => void): void {
  ctx.save();
  ctx.translate(portal.x, portal.y);
  ctx.scale(1, ZONE_ASPECT);
  fn();
  ctx.restore();
}

function circle(ctx: CanvasRenderingContext2D, radius: number): void {
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(0, radius), 0, TAU);
}

// paintBase：门框侧面（往下错开几个像素显出厚度）、门框顶面的石块、门里的漩涡底
function paintBase(ctx: CanvasRenderingContext2D, portal: PortalInfo, now: number): void {
  const { light, dark } = colorsOf(portal);
  const R = portal.r;
  const outer = R + RIM;
  // 地上一圈淡淡的染色，远远就能看出这里有东西
  inEllipse(ctx, portal, () => {
    const halo = ctx.createRadialGradient(0, 0, R, 0, 0, outer + 8);
    halo.addColorStop(0, rgba(dark, 0.5));
    halo.addColorStop(1, rgba(dark, 0));
    ctx.fillStyle = halo;
    circle(ctx, outer + 8);
    ctx.fill();
  });
  // 侧面
  ctx.save();
  ctx.translate(0, 5);
  inEllipse(ctx, portal, () => {
    circle(ctx, outer);
    ctx.fillStyle = '#1b1922';
    ctx.fill();
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = '#0b080e';
    ctx.stroke();
  });
  ctx.restore();
  inEllipse(ctx, portal, () => {
    // 顶面：一圈黑石
    ctx.beginPath();
    ctx.arc(0, 0, outer, 0, TAU);
    ctx.arc(0, 0, R, 0, TAU, true);
    ctx.fillStyle = '#3b3946';
    ctx.fill();
    // 石缝
    ctx.strokeStyle = '#0b080e';
    ctx.lineWidth = 1.4;
    const stones = 10;
    for (let i = 0; i < stones; i++) {
      const angle = (i / stones) * TAU + 0.2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * R, Math.sin(angle) * R);
      ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
      ctx.stroke();
    }
    // 石头朝上的亮边（光从左上来）
    ctx.strokeStyle = '#6d6a7c';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(0, 0, outer - 2.5, Math.PI * 1.05, Math.PI * 1.75);
    ctx.stroke();
    // 门里：深色漩涡底，边上最暗，中间透出门那边的颜色
    const well = ctx.createRadialGradient(0, 0, 2, 0, 0, R);
    well.addColorStop(0, rgba(whiten(light, 0.2), 0.95));
    well.addColorStop(0.35, rgba(light, 0.55));
    well.addColorStop(0.75, rgba(dark, 0.95));
    well.addColorStop(1, rgba(dark, 1));
    ctx.fillStyle = well;
    circle(ctx, R);
    ctx.fill();
    // 漩涡的暗纹：几条往里卷的深色弧线，慢慢转
    const spin = now / 1400;
    ctx.strokeStyle = rgba(dark, 0.8);
    ctx.lineWidth = 3;
    for (let arm = 0; arm < ARMS; arm++) spiral(ctx, R * 0.95, spin + (arm / ARMS) * TAU + 0.6);
    // 墨线描边：门框内外两圈
    ctx.strokeStyle = '#0b080e';
    ctx.lineWidth = 2.2;
    circle(ctx, R);
    ctx.stroke();
    circle(ctx, outer);
    ctx.stroke();
  });
}

// spiral 画一条从外沿往门心卷进去的弧线
function spiral(ctx: CanvasRenderingContext2D, radius: number, start: number): void {
  ctx.beginPath();
  for (let step = 0; step <= 16; step++) {
    const t = step / 16;
    const angle = start + t * 2.4;
    const r = radius * (1 - t * 0.85);
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (step === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// paintGlow：转动的漩涡光臂、一明一暗的门心、门框上的符文
function paintGlow(ctx: CanvasRenderingContext2D, portal: PortalInfo, now: number): void {
  const { light } = colorsOf(portal);
  const R = portal.r;
  const breath = 0.75 + 0.25 * Math.sin(now / 520 + portal.x);
  inEllipse(ctx, portal, () => {
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.8);
    core.addColorStop(0, rgba(whiten(light, 0.6), 0.85 * breath));
    core.addColorStop(0.5, rgba(light, 0.3 * breath));
    core.addColorStop(1, rgba(light, 0));
    ctx.fillStyle = core;
    circle(ctx, R * 0.8);
    ctx.fill();
    const spin = now / 1400;
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = rgba(whiten(light, 0.4), 0.55);
    for (let arm = 0; arm < ARMS; arm++) spiral(ctx, R * 0.92, spin + (arm / ARMS) * TAU);
    // 门框上一圈符文小点，依次亮起
    const runes = 10;
    for (let i = 0; i < runes; i++) {
      const angle = ((i + 0.5) / runes) * TAU + 0.2;
      const lit = 0.35 + 0.65 * Math.max(0, Math.sin(now / 300 - i * 0.9));
      ctx.beginPath();
      ctx.arc(Math.cos(angle) * (R + RIM / 2), Math.sin(angle) * (R + RIM / 2), 1.8, 0, TAU);
      ctx.fillStyle = rgba(whiten(light, 0.3), 0.75 * lit);
      ctx.fill();
    }
  });
}

class PortalView {
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

// PortalLayer 把当前场景的传送门画到 layer 上（和回血区同一层：地表之上、角色之下）。
export class PortalLayer {
  private views: PortalView[] = [];
  private moteDebt: number[] = [];

  constructor(readonly layer: Container) {}

  // update 画一帧；镜头外的门不画。换了场景（门的数量变了）就重建。
  update(portals: PortalInfo[], now: number, view: { x: number; y: number; w: number; h: number }, res: number): void {
    if (this.views.length !== portals.length) {
      this.clear();
      this.views = portals.map(() => new PortalView(this.layer));
      this.moteDebt = portals.map(() => 0);
    }
    portals.forEach((portal, i) => {
      const portalView = this.views[i];
      const box = boxOf(portal);
      const onScreen = box[2] > view.x && box[0] < view.x + view.w && box[3] > view.y && box[1] < view.y + view.h;
      if (!onScreen) { portalView.hide(); return; }
      portalView.base.visible = portalView.glow.visible = true;
      portalView.base.paint(box, res, (ctx) => paintBase(ctx, portal, now));
      portalView.glow.paint(box, res, (ctx) => paintGlow(ctx, portal, now));
    });
  }

  // motes 让镜头里的门往上冒光点（fx 的粒子，参与泛光）。
  motes(fx: FX, portals: PortalInfo[], now: number, dt: number, view: { x: number; y: number; w: number; h: number }): void {
    portals.forEach((portal, i) => {
      if (portal.x < view.x - 60 || portal.x > view.x + view.w + 60 || portal.y < view.y - 60 || portal.y > view.y + view.h + 60) return;
      const { light } = colorsOf(portal);
      let debt = (this.moteDebt[i] ?? 0) + (9 * Math.min(dt, 100)) / 1000;
      for (; debt >= 1; debt--) {
        const angle = Math.random() * TAU;
        const distance = Math.sqrt(Math.random()) * portal.r * 0.9;
        fx.spawn({
          x: portal.x + Math.cos(angle) * distance,
          y: portal.y + Math.sin(angle) * distance * ZONE_ASPECT - 2,
          vx: (Math.random() - 0.5) * 0.008,
          vy: -(0.03 + Math.random() * 0.04),
          life: 1100 + Math.random() * 900,
          size: 1.6 + Math.random() * 1.8,
          color: Math.random() < 0.3 ? '#ffffff' : colorsOf(portal).hex,
          kind: 'wisp',
          born: now,
        });
      }
      this.moteDebt[i] = debt;
    });
  }

  clear(): void {
    for (const portalView of this.views) portalView.destroy();
    this.views = [];
    this.moteDebt = [];
  }
}

// portalLights 报告门照亮周围的光。
export function portalLights(
  add: (x: number, y: number, radius: number, color: string, strength?: number, glow?: number) => void,
  portals: PortalInfo[],
  now: number,
): void {
  for (const portal of portals) {
    const breath = 0.85 + 0.15 * Math.sin(now / 520 + portal.x);
    add(portal.x, portal.y - 10, portal.r * 3.2, colorsOf(portal).hex, 0.7 * breath, 0.25);
  }
}

// standIn 记下自己站进门的时刻，画出发进度用（服务端站够 0.6 秒才出发，这里只是估计）。
let standing: { portal: PortalInfo; since: number } | null = null;

// drawPortalLabels 在叠加层上给每扇门写“通往 xx”，自己站在门里时画一圈出发进度。
// ctx 已经是世界坐标；me 是自己脚下的位置（死了或还没进游戏为 null）。
export function drawPortalLabels(
  ctx: CanvasRenderingContext2D, portals: PortalInfo[], me: { x: number; y: number } | null, now: number,
): void {
  let inside: PortalInfo | null = null;
  for (const portal of portals) {
    const { light } = colorsOf(portal);
    const y = portal.y - (portal.r + RIM) * ZONE_ASPECT - 14;
    ctx.font = `bold 13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(8,5,10,0.9)';
    const text = `通往 ${portal.toName}`;
    ctx.strokeText(text, portal.x, y);
    ctx.fillStyle = rgba(whiten(light, 0.35), 1);
    ctx.fillText(text, portal.x, y);
    if (me && hypot(me.x, me.y, portal.x, portal.y) <= portal.r) inside = portal;
  }
  if (!inside) { standing = null; return; }
  if (standing?.portal !== inside) standing = { portal: inside, since: now };
  const progress = Math.min(1, (now - standing.since) / DWELL_MS);
  ctx.save();
  ctx.translate(inside.x, inside.y);
  ctx.scale(1, ZONE_ASPECT);
  ctx.beginPath();
  ctx.arc(0, 0, inside.r + RIM + 4, -Math.PI / 2, -Math.PI / 2 + progress * TAU);
  ctx.lineWidth = 3;
  ctx.strokeStyle = rgba(whiten(colorsOf(inside).light, 0.5), 0.9);
  ctx.stroke();
  ctx.restore();
}
