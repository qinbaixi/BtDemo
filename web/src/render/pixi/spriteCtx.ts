// SpriteCtx：用 GPU 精灵画粒子和光晕，接口模仿一小部分 Canvas 2D（drawImage、fillRect、globalAlpha……），
// 这样 fx.ts 的粒子和 scenery.ts 的环境粒子几乎不用改写，就从“整屏 2D 画布每帧上传”变成了一批精灵。
//
// 每帧：begin() → 各处调用画图方法 → end()。精灵按需创建、每帧复用，没用到的隐藏。
// 支持的混合：'lighter'（加法，发光）和 'source-over'（普通）。

import { Container, Sprite, Texture } from 'pixi.js';

type Blend = 'add' | 'normal';

const canvasTextures = new WeakMap<HTMLCanvasElement | HTMLImageElement, Texture>();

// textureOf 把 2D 画布（光晕、雾团这些预先画好的小图）包成贴图，同一张画布只包一次。
function textureOf(image: HTMLCanvasElement | HTMLImageElement): Texture {
  let texture = canvasTextures.get(image);
  if (!texture) {
    texture = Texture.from(image);
    canvasTextures.set(image, texture);
  }
  return texture;
}

// 白色实心圆，着色后用
let discTexture: Texture | null = null;

function makeDisc(): Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(16, 16, 15.5, 0, Math.PI * 2);
  g.fill();
  return Texture.from(c);
}

export class SpriteCtx {
  globalAlpha = 1;
  globalCompositeOperation: string = 'source-over';
  fillStyle = '#ffffff';
  private stack: [number, string, string][] = [];
  private pool: Sprite[] = [];
  private used = 0;

  constructor(readonly layer: Container) {}

  begin(): void {
    this.used = 0;
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.stack.length = 0;
  }

  end(): void {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].visible = false;
  }

  save(): void { this.stack.push([this.globalAlpha, this.globalCompositeOperation, this.fillStyle]); }

  restore(): void {
    const top = this.stack.pop();
    if (top) [this.globalAlpha, this.globalCompositeOperation, this.fillStyle] = top;
  }

  // drawImage 在 (x, y) 处画一张 w×h 的图（只支持这一种参数形式）。
  drawImage(image: HTMLCanvasElement | HTMLImageElement, x: number, y: number, w: number, h: number): void {
    if (this.globalAlpha <= 0.004 || w <= 0 || h <= 0) return;
    const sprite = this.next(textureOf(image), 0xffffff);
    sprite.anchor.set(0, 0);
    sprite.rotation = 0;
    sprite.position.set(x, y);
    sprite.width = w;
    sprite.height = h;
  }

  // fillRect 用 fillStyle 的颜色画实心矩形（只支持 #rrggbb 颜色）。
  fillRect(x: number, y: number, w: number, h: number): void {
    if (this.globalAlpha <= 0.004) return;
    const sprite = this.next(Texture.WHITE, this.fillStyle);
    sprite.anchor.set(0, 0);
    sprite.rotation = 0;
    sprite.position.set(x, y);
    sprite.width = w;
    sprite.height = h;
  }

  // streak 画一段线（火花的拖尾），width 是线宽。火花都很细，直接用旋转的细长矩形。
  streak(x0: number, y0: number, x1: number, y1: number, width: number, color: string): void {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (this.globalAlpha <= 0.004 || width <= 0) return;
    const sprite = this.next(Texture.WHITE, color);
    sprite.anchor.set(0, 0.5);
    sprite.position.set(x0, y0);
    sprite.rotation = Math.atan2(y1 - y0, x1 - x0);
    sprite.width = Math.max(len, width);
    sprite.height = width;
  }

  // disc 画一个实心圆。
  disc(x: number, y: number, r: number, color: string): void {
    if (this.globalAlpha <= 0.004 || r <= 0) return;
    discTexture ??= makeDisc();
    const sprite = this.next(discTexture, color);
    sprite.anchor.set(0.5, 0.5);
    sprite.rotation = 0;
    sprite.position.set(x, y);
    sprite.width = sprite.height = r * 2;
  }

  private next(texture: Texture, tint: number | string): Sprite {
    let sprite = this.pool[this.used];
    if (!sprite) {
      sprite = new Sprite(texture);
      this.layer.addChild(sprite);
      this.pool.push(sprite);
    }
    this.used++;
    sprite.visible = true;
    sprite.texture = texture;
    sprite.tint = tint;
    sprite.alpha = Math.min(1, this.globalAlpha);
    const blend: Blend = this.globalCompositeOperation === 'lighter' ? 'add' : 'normal';
    if (sprite.blendMode !== blend) sprite.blendMode = blend;
    return sprite;
  }
}
