// 命中火花序列帧：按材质（金属火星、骨渣、血雾、兽毛、黏液、木屑）各一组小动画，命中时在受击点播一遍。
//
// 和美术管线一样的规则：art/manifest.json 的 fx 里有就用美术画的序列帧（见 docs/art-spec.md），
// 没有就用这里程序画的。程序画的帧也能用 ?bake 导出成模板（render/bake.ts），照着重画再放回去。

import type { Material } from '../audio/recipes';
import { art } from './art';

export const FLIP_SIZE = 96;     // 每帧的边长（图片像素）；画到世界里是 FLIP_SIZE / FLIP_PPU 世界像素
export const FLIP_PPU = 2;
export const FLIP_FRAMES = 7;
export const FLIP_MS = 260;      // 播一遍多长

export interface Flipbook {
  frames: (HTMLCanvasElement | HTMLImageElement)[];
  blend: 'add' | 'normal';      // 火星发光用叠加，骨渣、血、黏液用普通混合
}

type Painter = (g: CanvasRenderingContext2D, k: number, rnd: () => number) => void;

// 每种材质怎么画：k 是这一帧在动画里的进度 0..1，rnd 每帧都从同一个种子开始（同一颗碎屑每帧在同一条轨迹上）。
// 坐标原点在帧中心，命中方向朝 +x（播放时按受击方向翻转）。
const PAINTERS: Record<Material, { blend: Flipbook['blend']; paint: Painter }> = {
  // 金属：一团白黄色的火星呈扇形喷出去，拖着光尾，中心先闪一下
  metal: {
    blend: 'add',
    paint(g, k, rnd) {
      flash(g, k, '255,240,190', 0.35);
      for (let i = 0; i < 16; i++) {
        const angle = (rnd() - 0.5) * 2.4;
        const speed = 18 + rnd() * 30;
        const d = speed * easeOut(k);
        const tail = 10 * (1 - k) + 2;
        const x = Math.cos(angle) * d;
        const y = Math.sin(angle) * d + 10 * k * k;   // 往下掉一点
        g.strokeStyle = `rgba(255,${200 + rnd() * 55},${120 + rnd() * 80},${1 - k})`;
        g.lineWidth = 1.6 * (1 - k) + 0.6;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x - Math.cos(angle) * tail, y - Math.sin(angle) * tail);
        g.stroke();
      }
    },
  },
  // 骨头：几块灰白的碎骨片转着飞出去，下面扬起一点骨粉
  bone: {
    blend: 'normal',
    paint(g, k, rnd) {
      puff(g, k, '220,212,190', 0.35);
      for (let i = 0; i < 8; i++) {
        const angle = (rnd() - 0.5) * 2.6;
        const d = (14 + rnd() * 22) * easeOut(k);
        const x = Math.cos(angle) * d;
        const y = Math.sin(angle) * d + 18 * k * k;
        const size = 2.2 + rnd() * 2.2;
        g.save();
        g.translate(x, y);
        g.rotate(rnd() * 6 + k * (rnd() - 0.5) * 12);
        g.globalAlpha = 1 - k * k;
        g.fillStyle = '#ece4cc';
        g.strokeStyle = '#3a3428';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(-size, -size * 0.4);
        g.lineTo(size * 0.8, -size * 0.6);
        g.lineTo(size, size * 0.5);
        g.lineTo(-size * 0.6, size * 0.6);
        g.closePath();
        g.fill();
        g.stroke();
        g.restore();
      }
    },
  },
  // 肉：暗红的血点溅出去，带一团很快散掉的血雾
  flesh: {
    blend: 'normal',
    paint(g, k, rnd) {
      puff(g, k, '150,20,24', 0.45);
      droplets(g, k, rnd, 12, ['#9b111b', '#c41e24', '#6e0a12']);
    },
  },
  // 野兽：血点加几簇灰毛
  beast: {
    blend: 'normal',
    paint(g, k, rnd) {
      puff(g, k, '140,24,24', 0.35);
      droplets(g, k, rnd, 8, ['#9b111b', '#c41e24']);
      for (let i = 0; i < 5; i++) {
        const angle = (rnd() - 0.5) * 2.2;
        const d = (10 + rnd() * 18) * easeOut(k);
        const x = Math.cos(angle) * d;
        const y = Math.sin(angle) * d + 6 * k;
        g.strokeStyle = `rgba(170,165,160,${1 - k})`;
        g.lineWidth = 1.2;
        g.beginPath();
        for (let j = 0; j < 3; j++) {
          const a = rnd() * 6;
          g.moveTo(x, y);
          g.lineTo(x + Math.cos(a) * 4, y + Math.sin(a) * 4);
        }
        g.stroke();
      }
    },
  },
  // 黏液：几大滴半透明的绿色黏液甩出去，落地时拉长
  goo: {
    blend: 'normal',
    paint(g, k, rnd) {
      for (let i = 0; i < 9; i++) {
        const angle = (rnd() - 0.5) * 2.8;
        const d = (12 + rnd() * 22) * easeOut(k);
        const x = Math.cos(angle) * d;
        const y = Math.sin(angle) * d + 16 * k * k;
        const r = (2.4 + rnd() * 3) * (1 - k * 0.4);
        g.globalAlpha = 1 - k * k;
        g.fillStyle = '#7fe07a';
        g.strokeStyle = '#1d4a1f';
        g.lineWidth = 1.1;
        g.beginPath();
        g.ellipse(x, y, r * (1 + k * 0.6), r * (1 - k * 0.3), angle, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.7)';
        g.beginPath();
        g.arc(x - r * 0.3, y - r * 0.35, r * 0.3, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    },
  },
  // 木头：细长的木刺和几片碎叶
  wood: {
    blend: 'normal',
    paint(g, k, rnd) {
      for (let i = 0; i < 9; i++) {
        const angle = (rnd() - 0.5) * 2.4;
        const d = (12 + rnd() * 22) * easeOut(k);
        const x = Math.cos(angle) * d;
        const y = Math.sin(angle) * d + 14 * k * k;
        const spin = rnd() * 6 + k * (rnd() - 0.5) * 10;
        const leaf = i % 3 === 0;
        g.save();
        g.translate(x, y);
        g.rotate(spin);
        g.globalAlpha = 1 - k * k;
        g.fillStyle = leaf ? '#7fbf4a' : '#a8743c';
        g.strokeStyle = '#2a1a0c';
        g.lineWidth = 1;
        g.beginPath();
        if (leaf) g.ellipse(0, 0, 3.2, 1.6, 0, 0, Math.PI * 2);
        else g.rect(-4, -0.9, 8, 1.8);
        g.fill();
        g.stroke();
        g.restore();
      }
    },
  },
};

const cache = new Map<string, Flipbook>();

// flipbook 是材质 material 的命中序列帧：美术图优先，没有就程序画（画一次缓存起来）。
export function flipbook(material: Material): Flipbook {
  const drawn = art.fx.get(`hit.${material}`);
  if (drawn) return drawn;
  let book = cache.get(material);
  if (!book) {
    book = paintFlipbook(material);
    cache.set(material, book);
  }
  return book;
}

// paintFlipbook 程序画一组序列帧。
export function paintFlipbook(material: Material): Flipbook {
  const painter = PAINTERS[material] ?? PAINTERS.flesh;
  const frames: HTMLCanvasElement[] = [];
  for (let i = 0; i < FLIP_FRAMES; i++) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = FLIP_SIZE;
    const g = canvas.getContext('2d')!;
    g.translate(FLIP_SIZE / 2, FLIP_SIZE / 2);
    g.scale(FLIP_PPU, FLIP_PPU);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    painter.paint(g, i / (FLIP_FRAMES - 1), seeded(0x5eed + material.length * 131));
    frames.push(canvas);
  }
  return { frames, blend: painter.blend };
}

export const FLIP_MATERIALS = Object.keys(PAINTERS) as Material[];

function flash(g: CanvasRenderingContext2D, k: number, rgb: string, until: number): void {
  if (k >= until) return;
  const t = k / until;
  const gradient = g.createRadialGradient(0, 0, 0, 0, 0, 14 * (0.6 + t));
  gradient.addColorStop(0, `rgba(${rgb},${1 - t})`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gradient;
  g.beginPath();
  g.arc(0, 0, 14 * (0.6 + t), 0, Math.PI * 2);
  g.fill();
}

// puff 是一团往外散、很快变淡的雾（血雾、骨粉）。
function puff(g: CanvasRenderingContext2D, k: number, rgb: string, peak: number): void {
  const r = 6 + 16 * easeOut(k);
  const gradient = g.createRadialGradient(4, 0, 0, 4, 0, r);
  gradient.addColorStop(0, `rgba(${rgb},${peak * (1 - k)})`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gradient;
  g.beginPath();
  g.arc(4, 0, r, 0, Math.PI * 2);
  g.fill();
}

function droplets(g: CanvasRenderingContext2D, k: number, rnd: () => number, count: number, colors: string[]): void {
  for (let i = 0; i < count; i++) {
    const angle = (rnd() - 0.5) * 2.4;
    const d = (12 + rnd() * 24) * easeOut(k);
    const x = Math.cos(angle) * d;
    const y = Math.sin(angle) * d + 20 * k * k;
    const r = (1.2 + rnd() * 2) * (1 - k * 0.5);
    g.globalAlpha = 1 - k * k;
    g.fillStyle = colors[i % colors.length];
    g.beginPath();
    g.ellipse(x, y, r * 1.4, r, angle, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
