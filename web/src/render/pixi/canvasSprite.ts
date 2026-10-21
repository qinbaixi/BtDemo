// CanvasSprite：用 Canvas 2D 画内容、交给 Pixi 显示的精灵。
// 现在的模型、动态物件和部分特效都是程序化画的，用它接进 Pixi；
// 以后换成美术贴图，直接换成普通 Sprite 即可。

import { CanvasSource, Rectangle, Sprite, Texture } from 'pixi.js';

export class CanvasSprite extends Sprite {
  readonly canvas = document.createElement('canvas');
  readonly ctx = this.canvas.getContext('2d')!;
  private source: CanvasSource | null = null;
  private res = 1;

  /**
   * paint 重画内容。box 是要画的范围 [x0, y0, x1, y1]（本地坐标，精灵原点就是 0, 0），
   * res 是每个本地单位多少像素；draw 收到的 ctx 已经平移、缩放好，直接按本地坐标画。
   */
  paint(box: readonly number[], res: number, draw: (ctx: CanvasRenderingContext2D) => void): void {
    // 起点对齐到像素格，避免显示时被插值糊掉
    const x0 = Math.floor(box[0] * res) / res;
    const y0 = Math.floor(box[1] * res) / res;
    const [, , x1, y1] = box;
    const w = Math.max(1, Math.ceil((x1 - x0) * res));
    const h = Math.max(1, Math.ceil((y1 - y0) * res));
    // 画布够用就复用，避免每帧重新分配；纹理用 frame 截取实际用到的部分。
    // 上传时整张画布都会传到显卡，所以画布比需要的大太多时缩回来。
    let grown = false;
    const tooSmall = this.canvas.width < w || this.canvas.height < h;
    const tooBig = this.canvas.width * this.canvas.height > Math.max(4 * w * h, 256 * 256);
    if (tooSmall || tooBig || !this.source) {
      this.canvas.width = tooBig ? w : Math.max(this.canvas.width, w);
      this.canvas.height = tooBig ? h : Math.max(this.canvas.height, h);
      this.source?.destroy();
      this.source = new CanvasSource({ resource: this.canvas });
      grown = true;
    }
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, w, h);
    g.setTransform(res, 0, 0, res, -x0 * res, -y0 * res);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    draw(g);
    if (!grown) this.source.update();
    const tex = this.texture;
    if (grown || tex.frame.width !== w || tex.frame.height !== h) {
      if (tex !== Texture.EMPTY) tex.destroy(false);
      this.texture = new Texture({ source: this.source, frame: new Rectangle(0, 0, w, h) });
    }
    this.res = res;
    this.scale.set(1 / res);
    this.pivot.set(-x0 * res, -y0 * res);
  }

  get resolution(): number { return this.res; }

  destroy(): void {
    if (this.texture !== Texture.EMPTY) this.texture.destroy(false);
    this.source?.destroy();
    super.destroy();
  }
}
