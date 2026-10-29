// 地面印记：重击砸出的裂纹、火球烧焦的黑斑、冰霜留下的白霜、被击退时在地上蹭出的拖痕。
//
// 画在地面和区域光圈上面、角色下面，会被暗部遮罩压暗（夜里看不太清，和地面一样）。
// 最多同时留 MAX_DECALS 个，多了先挤掉最早的；每个停留 HOLD_MS 后淡出。
// 贴图是程序画的小画布（每种几张变体，第一次用时画好缓存）；fx.ts 只往 FX.decals 里排请求，这里每帧取走。

import { Container, Sprite, Texture } from 'pixi.js';

export type DecalKind = 'crack' | 'scorch' | 'frost' | 'drag';

export interface DecalRequest {
  kind: DecalKind;
  x: number;
  y: number;
  at: number;          // 什么时候出现（击退的拖痕等滑完再出现）
  size?: number;       // 直径（世界像素），默认按种类
  angle?: number;      // 拖痕的方向
  length?: number;     // 拖痕的长度
  growMs?: number;     // 长出来用多久（拖痕跟着击退滑动的时间画出来）
}

export const MAX_DECALS = 40;
const HOLD_MS = 6000;
const FADE_MS = 1500;
const GROW_MS = 120;        // 出现时从小长大（裂纹“砸开”的感觉）
const VARIANTS = 3;
const PPU = 2;              // 贴图每个世界像素画两个像素

const DEFAULT_SIZE: Record<DecalKind, number> = { crack: 96, scorch: 72, frost: 80, drag: 14 };
const PEAK_ALPHA: Record<DecalKind, number> = { crack: 0.9, scorch: 0.9, frost: 0.75, drag: 0.8 };

interface Decal {
  sprite: Sprite;
  kind: DecalKind;
  at: number;
  size: number;
  length: number;
  growMs: number;
}

export class DecalLayer {
  private decals: Decal[] = [];
  private pending: DecalRequest[] = [];
  private textures = new Map<string, Texture>();

  constructor(readonly layer: Container) {}

  add(request: DecalRequest): void {
    this.pending.push(request);
  }

  clear(): void {
    for (const decal of this.decals) decal.sprite.destroy();
    this.decals.length = 0;
    this.pending.length = 0;
  }

  get count(): number {
    return this.decals.length;
  }

  // update 每帧调用：到时间的请求变成印记，老的淡出、删掉。
  update(now: number): void {
    if (this.pending.length) {
      const waiting: DecalRequest[] = [];
      for (const request of this.pending) {
        if (request.at > now) waiting.push(request);
        else this.spawn(request);
      }
      this.pending = waiting;
    }
    let kept = 0;
    for (const decal of this.decals) {
      const age = now - decal.at;
      if (age >= HOLD_MS + FADE_MS) {
        decal.sprite.destroy();
        continue;
      }
      this.decals[kept++] = decal;
      const grow = Math.min(1, age / decal.growMs);
      const fade = age > HOLD_MS ? 1 - (age - HOLD_MS) / FADE_MS : 1;
      decal.sprite.alpha = PEAK_ALPHA[decal.kind] * fade * (decal.kind === 'drag' ? 1 : Math.min(1, grow * 1.5));
      const scale = decal.kind === 'drag' ? 1 : 0.7 + 0.3 * easeOut(grow);
      // 拖痕沿方向拉长（贴图本身是一段横条）；其余的压扁成地面上的椭圆
      const texture = decal.sprite.texture;
      if (decal.kind === 'drag') decal.sprite.scale.set((decal.length * grow) / texture.width, (decal.size * 2) / texture.height);
      else decal.sprite.scale.set((decal.size * scale) / texture.width, (decal.size * scale * 0.55) / texture.height);
    }
    this.decals.length = kept;
  }

  private spawn(request: DecalRequest): void {
    while (this.decals.length >= MAX_DECALS) this.decals.shift()!.sprite.destroy();
    const variant = Math.floor(Math.random() * VARIANTS);
    const sprite = new Sprite(this.texture(request.kind, variant));
    sprite.anchor.set(request.kind === 'drag' ? 0 : 0.5, 0.5);
    sprite.position.set(request.x, request.y);
    sprite.alpha = 0;
    if (request.kind === 'drag') sprite.rotation = request.angle ?? 0;
    this.layer.addChild(sprite);
    this.decals.push({
      sprite,
      kind: request.kind,
      at: request.at,
      size: request.size ?? DEFAULT_SIZE[request.kind],
      length: Math.max(8, request.length ?? 30),
      growMs: Math.max(16, request.growMs ?? GROW_MS),
    });
  }

  private texture(kind: DecalKind, variant: number): Texture {
    const key = `${kind}:${variant}`;
    let texture = this.textures.get(key);
    if (!texture) {
      texture = Texture.from(paintDecal(kind, variant));
      this.textures.set(key, texture);
    }
    return texture;
  }
}

// paintDecal 程序画一种印记的一张变体（俯视的圆形图，放到地上时再压扁）。导出给 render/bake.ts 做模板。
export function paintDecal(kind: DecalKind, variant: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const rnd = seeded(0xdeca1 + variant * 977 + kind.length * 31);
  if (kind === 'drag') {
    // 一段横条：两三道从深到浅的土痕，左端（起点）淡、中间最深、右端（落点）堆起一点土
    canvas.width = 64 * PPU;
    canvas.height = 32 * PPU;
    const g = canvas.getContext('2d')!;
    g.scale(PPU, PPU);
    for (let i = 0; i < 3; i++) {
      const y = 16 + (i - 1) * (5 + rnd() * 2);
      const gradient = g.createLinearGradient(0, 0, 64, 0);
      gradient.addColorStop(0, 'rgba(40,28,18,0)');
      gradient.addColorStop(0.35, 'rgba(40,28,18,0.7)');
      gradient.addColorStop(0.9, 'rgba(30,20,12,0.9)');
      gradient.addColorStop(1, 'rgba(30,20,12,0)');
      g.strokeStyle = gradient;
      g.lineWidth = 2.2 - i * 0.4 + rnd();
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(2, y);
      for (let x = 8; x <= 60; x += 8) g.lineTo(x, y + (rnd() - 0.5) * 1.6);
      g.stroke();
    }
    // 两边翻起来的浅色土（暗地面上主要靠它看出来）
    for (const side of [-1, 1]) {
      const y = 16 + side * 9;
      const dust = g.createLinearGradient(0, 0, 64, 0);
      dust.addColorStop(0, 'rgba(190,170,135,0)');
      dust.addColorStop(0.5, 'rgba(190,170,135,0.45)');
      dust.addColorStop(1, 'rgba(190,170,135,0.6)');
      g.strokeStyle = dust;
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(6, y);
      for (let x = 12; x <= 62; x += 10) g.lineTo(x, y + side * (rnd() * 1.5));
      g.stroke();
    }
    g.fillStyle = 'rgba(150,128,96,0.8)';
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.arc(56 + rnd() * 6, 8 + rnd() * 16, 1 + rnd() * 1.6, 0, Math.PI * 2);
      g.fill();
    }
    return canvas;
  }
  const size = 64;
  canvas.width = canvas.height = size * PPU;
  const g = canvas.getContext('2d')!;
  g.scale(PPU, PPU);
  g.translate(size / 2, size / 2);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (kind === 'crack') {
    // 中心一个砸坑，几道折线裂纹往外散，主裂纹上再分叉
    const pit = g.createRadialGradient(0, 0, 0, 0, 0, 15);
    pit.addColorStop(0, 'rgba(10,7,5,0.9)');
    pit.addColorStop(0.7, 'rgba(14,10,8,0.5)');
    pit.addColorStop(1, 'rgba(14,10,8,0)');
    g.fillStyle = pit;
    g.beginPath();
    g.arc(0, 0, 15, 0, Math.PI * 2);
    g.fill();
    const arms = 6 + Math.floor(rnd() * 3);
    for (let i = 0; i < arms; i++) {
      const angle = (i / arms) * Math.PI * 2 + (rnd() - 0.5) * 0.6;
      crackLine(g, rnd, Math.cos(angle) * 3, Math.sin(angle) * 3, angle, 14 + rnd() * 14, 2.4, 2);
    }
    return canvas;
  }
  if (kind === 'scorch') {
    // 焦黑的一团，边缘不规则，中间偏棕，散着几点还没灭的火星
    for (let i = 0; i < 7; i++) {
      const x = (rnd() - 0.5) * 18;
      const y = (rnd() - 0.5) * 18;
      const r = 12 + rnd() * 12;
      const blot = g.createRadialGradient(x, y, 0, x, y, r);
      blot.addColorStop(0, 'rgba(14,8,4,0.8)');
      blot.addColorStop(0.6, 'rgba(26,14,6,0.55)');
      blot.addColorStop(1, 'rgba(30,16,8,0)');
      g.fillStyle = blot;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    // 外圈一层灰白的灰烬：暗地面上靠它看出轮廓
    const ash = g.createRadialGradient(0, 0, 16, 0, 0, 30);
    ash.addColorStop(0, 'rgba(150,140,128,0)');
    ash.addColorStop(0.6, 'rgba(150,140,128,0.3)');
    ash.addColorStop(1, 'rgba(150,140,128,0)');
    g.fillStyle = ash;
    g.beginPath();
    g.arc(0, 0, 30, 0, Math.PI * 2);
    g.fill();
    for (let i = 0; i < 9; i++) {
      const angle = rnd() * Math.PI * 2;
      const d = rnd() * 16;
      g.fillStyle = i % 3 ? 'rgba(255,120,40,0.9)' : 'rgba(255,210,120,0.95)';
      g.beginPath();
      g.arc(Math.cos(angle) * d, Math.sin(angle) * d, 0.6 + rnd() * 0.8, 0, Math.PI * 2);
      g.fill();
    }
    return canvas;
  }
  // frost：一层白蓝色的霜，外圈一圈冰刺，里面几道细裂纹
  const haze = g.createRadialGradient(0, 0, 4, 0, 0, 28);
  haze.addColorStop(0, 'rgba(220,240,255,0.6)');
  haze.addColorStop(0.7, 'rgba(170,215,250,0.35)');
  haze.addColorStop(1, 'rgba(170,215,250,0)');
  g.fillStyle = haze;
  g.beginPath();
  g.arc(0, 0, 28, 0, Math.PI * 2);
  g.fill();
  const spikes = 14;
  for (let i = 0; i < spikes; i++) {
    const angle = (i / spikes) * Math.PI * 2 + (rnd() - 0.5) * 0.3;
    const inner = 12 + rnd() * 6;
    const outer = inner + 6 + rnd() * 9;
    const width = 0.12 + rnd() * 0.08;
    g.fillStyle = i % 2 ? 'rgba(235,248,255,0.95)' : 'rgba(180,225,255,0.9)';
    g.beginPath();
    g.moveTo(Math.cos(angle - width) * inner, Math.sin(angle - width) * inner);
    g.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
    g.lineTo(Math.cos(angle + width) * inner, Math.sin(angle + width) * inner);
    g.closePath();
    g.fill();
  }
  g.strokeStyle = 'rgba(120,180,230,0.7)';
  g.lineWidth = 0.8;
  for (let i = 0; i < 5; i++) {
    const angle = rnd() * Math.PI * 2;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(Math.cos(angle) * (8 + rnd() * 8), Math.sin(angle) * (8 + rnd() * 8));
    g.stroke();
  }
  return canvas;
}

// crackLine 画一道往外的折线裂纹，越往外越细，中途可能再分出一支。
function crackLine(
  g: CanvasRenderingContext2D,
  rnd: () => number,
  startX: number,
  startY: number,
  angle: number,
  length: number,
  width: number,
  depth: number,
): void {
  let x = startX;
  let y = startY;
  const steps = 4;
  for (let i = 0; i < steps; i++) {
    const heading = angle + (rnd() - 0.5) * 0.7;
    const nx = x + Math.cos(heading) * (length / steps);
    const ny = y + Math.sin(heading) * (length / steps);
    const w = width * (1 - i / steps) + 0.4;
    // 深色裂缝 + 一侧亮边（裂开翘起的地面）
    g.strokeStyle = 'rgba(200,180,150,0.22)';
    g.lineWidth = w + 1.4;
    g.beginPath();
    g.moveTo(x + 0.6, y - 0.6);
    g.lineTo(nx + 0.6, ny - 0.6);
    g.stroke();
    g.strokeStyle = 'rgba(12,8,6,0.95)';
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(nx, ny);
    g.stroke();
    if (depth > 0 && i === 1 && rnd() < 0.7) {
      crackLine(g, rnd, nx, ny, heading + (rnd() < 0.5 ? -0.7 : 0.7), length * 0.45, w * 0.7, depth - 1);
    }
    x = nx;
    y = ny;
  }
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
