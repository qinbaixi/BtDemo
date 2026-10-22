// 装备图标：每件装备一个小画像，背包和装备栏用（ui/bag.ts）。
// 画在 32 × 32 的格子坐标里再缩放到 size；ctx 已经按设备像素比缩放过，size 是 CSS 像素。
// 风格和模型一致：实心色块、深色描边、一道亮边。底板按稀有度着色。

import type { ItemInfo } from '../net/types';
import { RARITY_COLOR } from '../game/config';

type Ctx = CanvasRenderingContext2D;

const INK = '#0b0710';

// shape 填一个路径并描深色边。
function shape(ctx: Ctx, path: (c: Ctx) => void, fill: string, lineWidth = 1.6): void {
  ctx.beginPath();
  path(ctx);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = INK;
  ctx.stroke();
}

// stroke 画一条带深色描边的线（弓身、链子）。
function stroke(ctx: Ctx, path: (c: Ctx) => void, color: string, width: number): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  path(ctx);
  ctx.strokeStyle = INK;
  ctx.lineWidth = width + 2;
  ctx.stroke();
  ctx.beginPath();
  path(ctx);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function highlight(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, alpha = 0.7): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
  ctx.lineWidth = 0.9;
  ctx.stroke();
}

// sword 画一把斜放的剑（剑尖在右上）：blade 剑身、edge 刃口光、guard 护手、width 剑身宽。
function sword(ctx: Ctx, blade: string, edge: string, guard: string, width = 2.6, length = 20): void {
  ctx.save();
  ctx.translate(9, 23);
  ctx.rotate(-Math.PI / 4);
  shape(ctx, (c) => {
    c.moveTo(2, -width);
    c.lineTo(length - 3, -width * 0.8);
    c.lineTo(length + 1, 0);
    c.lineTo(length - 3, width * 0.8);
    c.lineTo(2, width);
    c.closePath();
  }, blade);
  if (edge) {
    ctx.strokeStyle = edge;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(4, -width * 0.55);
    ctx.lineTo(length - 3, -width * 0.45);
    ctx.stroke();
  } else {
    highlight(ctx, 4, -width * 0.4, length - 4, -width * 0.3);
  }
  shape(ctx, (c) => c.rect(0, -width - 3, 2.4, width * 2 + 6), guard, 1.3);
  shape(ctx, (c) => c.rect(-5, -1.3, 5, 2.6), '#5a3a22', 1.3);
  shape(ctx, (c) => c.arc(-6, 0, 1.8, 0, Math.PI * 2), guard, 1.2);
  ctx.restore();
}

// bow 画一把竖放的弓（弓背朝右）和绷直的弦。
function bow(ctx: Ctx, wood: string, tip: string, grip: string): void {
  stroke(ctx, (c) => {
    c.moveTo(12, 4);
    c.quadraticCurveTo(25, 9, 20, 16);
    c.quadraticCurveTo(25, 23, 12, 28);
  }, wood, 2.6);
  ctx.beginPath();
  ctx.moveTo(12, 4);
  ctx.lineTo(12, 28);
  ctx.strokeStyle = 'rgba(240,235,215,0.9)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  shape(ctx, (c) => c.rect(19, 14, 3.4, 4), grip, 1.2);
  shape(ctx, (c) => { c.arc(12, 4, 1.4, 0, Math.PI * 2); }, tip, 1);
  shape(ctx, (c) => { c.arc(12, 28, 1.4, 0, Math.PI * 2); }, tip, 1);
}

// chest 画一件正面的上衣 / 胸甲。
function chest(ctx: Ctx, body: string, trim: string): void {
  shape(ctx, (c) => {
    c.moveTo(9, 6);
    c.lineTo(13, 5);
    c.quadraticCurveTo(16, 9, 19, 5);
    c.lineTo(23, 6);
    c.lineTo(27, 12);
    c.lineTo(23.5, 14);
    c.lineTo(23, 27);
    c.lineTo(9, 27);
    c.lineTo(8.5, 14);
    c.lineTo(5, 12);
    c.closePath();
  }, body);
  ctx.strokeStyle = trim;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(9.4, 23);
  ctx.lineTo(22.6, 23);
  ctx.stroke();
  highlight(ctx, 10.5, 9, 12, 20, 0.5);
}

// pendant 画挂在链子上的坠子。
function chain(ctx: Ctx): void {
  stroke(ctx, (c) => {
    c.moveTo(8, 5);
    c.quadraticCurveTo(16, 18, 24, 5);
  }, '#c9a65a', 1);
}

const PAINT: Record<string, (ctx: Ctx) => void> = {
  recruit_sword: (ctx) => sword(ctx, '#e3e9f0', '', '#c99a3e'),
  blood_blade: (ctx) => {
    sword(ctx, '#7a1c26', '#ff5a64', '#2a2228');
    shape(ctx, (c) => { c.moveTo(22, 15); c.quadraticCurveTo(24.5, 19, 22, 20.5); c.quadraticCurveTo(19.5, 19, 22, 15); }, '#d8283a', 1);
  },
  flame_greatsword: (ctx) => {
    sword(ctx, '#4a2a22', '#ff8a2a', '#e2802a', 3.6, 21);
    shape(ctx, (c) => {
      c.moveTo(24, 10); c.quadraticCurveTo(29, 6, 26, 1.5); c.quadraticCurveTo(25, 5, 22.5, 6);
      c.quadraticCurveTo(22, 3, 20, 2); c.quadraticCurveTo(21, 7, 24, 10);
    }, '#ff9a3a', 1);
  },
  thorn_plate: (ctx) => {
    chest(ctx, '#8a929e', '#5a3a22');
    for (const [x, y, dx] of [[5, 12, -3], [27, 12, 3], [9, 18, -3.4], [23, 18, 3.4]]) {
      shape(ctx, (c) => { c.moveTo(x, y - 1.6); c.lineTo(x + dx, y); c.lineTo(x, y + 1.6); c.closePath(); }, '#d8dde6', 1);
    }
  },
  guardian_mail: (ctx) => {
    chest(ctx, '#c3cbd6', '#e2b04a');
    shape(ctx, (c) => {
      c.moveTo(12.5, 11); c.lineTo(19.5, 11); c.lineTo(19.5, 15.5); c.quadraticCurveTo(16, 20, 16, 20);
      c.quadraticCurveTo(12.5, 17, 12.5, 15.5); c.closePath();
    }, '#e2b04a', 1.2);
  },
  hunter_bow: (ctx) => bow(ctx, '#a87a48', '#d8c8a0', '#5a3a1e'),
  wind_bow: (ctx) => {
    bow(ctx, '#dfe8cf', '#7fe0c8', '#2f6a5a');
    shape(ctx, (c) => { c.moveTo(12, 4); c.quadraticCurveTo(6, 7, 5, 12); c.quadraticCurveTo(9, 9, 12, 6); }, '#7fe0c8', 1);
    shape(ctx, (c) => { c.moveTo(12, 28); c.quadraticCurveTo(6, 25, 5, 20); c.quadraticCurveTo(9, 23, 12, 26); }, '#7fe0c8', 1);
  },
  frost_bow: (ctx) => {
    bow(ctx, '#9fd8f0', '#eef9ff', '#3a6a8a');
    for (const [x, y] of [[12, 4], [12, 28], [21, 16]]) {
      shape(ctx, (c) => { c.moveTo(x, y - 4); c.lineTo(x + 2, y); c.lineTo(x, y + 3); c.lineTo(x - 2, y); c.closePath(); }, '#d8f4ff', 1);
    }
  },
  shadow_leather: (ctx) => {
    chest(ctx, '#3a3346', '#8a6ac8');
    shape(ctx, (c) => { c.moveTo(11, 5.5); c.quadraticCurveTo(16, 0.5, 21, 5.5); c.quadraticCurveTo(16, 9, 11, 5.5); }, '#4a3a66', 1.2);
  },
  leather_vest: (ctx) => {
    chest(ctx, '#8a5a34', '#4a2c16');
    for (const y of [11, 14.5, 18]) shape(ctx, (c) => c.arc(16, y, 0.9, 0, Math.PI * 2), '#d8b070', 0.8);
  },
  life_charm: (ctx) => {
    chain(ctx);
    shape(ctx, (c) => {
      c.moveTo(16, 27); c.bezierCurveTo(6, 20, 9, 12, 16, 16.5); c.bezierCurveTo(23, 12, 26, 20, 16, 27);
    }, '#5ad88a');
    highlight(ctx, 11.5, 17, 13, 16, 0.8);
  },
  hawk_pendant: (ctx) => {
    chain(ctx);
    shape(ctx, (c) => {
      c.moveTo(16, 15); c.quadraticCurveTo(22, 20, 17, 29); c.quadraticCurveTo(11, 22, 16, 15);
    }, '#e8d6b0');
    ctx.strokeStyle = '#7a5a34';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(16, 16); ctx.quadraticCurveTo(17, 22, 17, 28);
    ctx.stroke();
  },
  sage_ring: (ctx) => {
    stroke(ctx, (c) => c.ellipse(16, 20, 7.5, 6, 0, 0, Math.PI * 2), '#e2b04a', 2.4);
    shape(ctx, (c) => { c.moveTo(16, 7); c.lineTo(20.5, 12); c.lineTo(16, 17); c.lineTo(11.5, 12); c.closePath(); }, '#b46aff', 1.3);
    highlight(ctx, 14, 10, 15.5, 8.6, 0.9);
  },
};

// 没有专门画法的装备按槽位画个通用的
const BY_SLOT: Record<string, (ctx: Ctx) => void> = {
  weapon: (ctx) => sword(ctx, '#e3e9f0', '', '#c99a3e'),
  armor: (ctx) => chest(ctx, '#8a5a34', '#4a2c16'),
  trinket: (ctx) => { chain(ctx); shape(ctx, (c) => c.arc(16, 20, 5, 0, Math.PI * 2), '#c9a65a'); },
};

// drawItemIcon 在 (0, 0)–(size, size) 画一件装备的图标：稀有度色的底板加装备的画像。
export function drawItemIcon(ctx: Ctx, item: ItemInfo, size: number): void {
  const rarity = RARITY_COLOR[item.rarity] || RARITY_COLOR.common;
  ctx.save();
  ctx.scale(size / 32, size / 32);
  // 底板：深色，往中间亮一点，边框是稀有度色
  const ground = ctx.createRadialGradient(16, 14, 2, 16, 16, 20);
  ground.addColorStop(0, '#2c2432');
  ground.addColorStop(1, '#141018');
  ctx.beginPath();
  ctx.roundRect(1, 1, 30, 30, 5);
  ctx.fillStyle = ground;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = rarity;
  ctx.stroke();
  // 史诗装备底下一圈淡淡的稀有度光
  if (item.rarity === 'epic') {
    const halo = ctx.createRadialGradient(16, 17, 2, 16, 17, 14);
    halo.addColorStop(0, 'rgba(199,125,255,0.35)');
    halo.addColorStop(1, 'rgba(199,125,255,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(2, 2, 28, 28);
  }
  (PAINT[item.id] || BY_SLOT[item.slot] || BY_SLOT.trinket)(ctx);
  ctx.restore();
}
