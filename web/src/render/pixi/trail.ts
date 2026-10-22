// 拖尾丝带：沿一串点铺一条有宽度的网格，贴一张“尾部透明 → 头部最亮、两边柔和”的渐变图。
// 刀光、旋风斩的风刃、法球和箭的尾迹都用它画（fx.ts 的 drawTrails）。
//
// 每帧：begin() → 若干次 stroke() → end()。网格按需创建、每帧复用，没用到的隐藏。

import { Container, MeshSimple, Texture } from 'pixi.js';

const SEGMENTS = 24;              // 每条丝带固定分成这么多段（输入的点会重新均匀取样）
const POINTS = SEGMENTS + 1;

let glowTexture: Texture | null = null;
let inkTexture: Texture | null = null;

// makeTrailTexture 画丝带贴图：横向是长度（左尾右头），纵向是宽度。
// soft = true 时两边是柔和的光晕；false 时边缘较硬（墨色衬底，像毛笔的一笔）。
function makeTrailTexture(soft: boolean): Texture {
  const w = 256;
  const h = 64;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const across = 1 - Math.abs((y + 0.5) / h * 2 - 1);            // 中心 1，两边 0
    const edge = soft ? Math.pow(across, 1.6) : Math.min(1, across * 3.5);
    for (let x = 0; x < w; x++) {
      const along = (x + 0.5) / w;
      // 尾部渐隐，头部最后一小段再收一点，避免切口太硬
      const fade = Math.pow(along, 1.4) * Math.min(1, (1 - along) * 14 + 0.25);
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(255 * Math.min(1, fade * edge));
    }
  }
  g.putImageData(img, 0, 0);
  return Texture.from(c);
}

export type RibbonStyle = 'glow' | 'ink';

export class RibbonPool {
  private pools: Record<RibbonStyle, { meshes: MeshSimple[]; used: number }> = {
    glow: { meshes: [], used: 0 },
    ink: { meshes: [], used: 0 },
  };
  private xs = new Float32Array(POINTS);
  private ys = new Float32Array(POINTS);
  private ws = new Float32Array(POINTS);

  // inkLayer 放墨色衬底，glowLayer 放发光丝带（墨色层要在下面）
  constructor(readonly inkLayer: Container, readonly glowLayer: Container) {}

  begin(): void {
    this.pools.glow.used = 0;
    this.pools.ink.used = 0;
  }

  end(): void {
    for (const pool of Object.values(this.pools)) {
      for (let i = pool.used; i < pool.meshes.length; i++) pool.meshes[i].visible = false;
    }
  }

  /**
   * stroke 画一条丝带。points 是 [x0, y0, x1, y1, ...]，从尾到头；widths 是每个点的宽度（和点一一对应）。
   * style 'glow' 是加法混合的发光，'ink' 是普通混合的深色衬底。
   */
  stroke(points: ArrayLike<number>, widths: ArrayLike<number>, color: string | number, alpha: number, style: RibbonStyle): void {
    const count = points.length / 2;
    if (count < 2 || alpha <= 0.01) return;
    // 按下标均匀重新取样成固定点数
    for (let i = 0; i < POINTS; i++) {
      const at = (i / SEGMENTS) * (count - 1);
      const j = Math.min(count - 2, Math.floor(at));
      const k = at - j;
      this.xs[i] = points[j * 2] + (points[j * 2 + 2] - points[j * 2]) * k;
      this.ys[i] = points[j * 2 + 1] + (points[j * 2 + 3] - points[j * 2 + 1]) * k;
      this.ws[i] = widths[j] + (widths[j + 1] - widths[j]) * k;
    }
    const mesh = this.next(style);
    const v = mesh.vertices;
    for (let i = 0; i < POINTS; i++) {
      // 法线：前后两点连线的垂直方向
      const a = Math.max(0, i - 1);
      const b = Math.min(SEGMENTS, i + 1);
      let tx = this.xs[b] - this.xs[a];
      let ty = this.ys[b] - this.ys[a];
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;
      const half = this.ws[i] / 2;
      v[i * 4] = this.xs[i] - ty * half;
      v[i * 4 + 1] = this.ys[i] + tx * half;
      v[i * 4 + 2] = this.xs[i] + ty * half;
      v[i * 4 + 3] = this.ys[i] - tx * half;
    }
    mesh.vertices = v;
    mesh.tint = color;
    mesh.alpha = Math.min(1, alpha);
  }

  private next(style: RibbonStyle): MeshSimple {
    const pool = this.pools[style];
    let mesh = pool.meshes[pool.used];
    if (!mesh) {
      const texture = style === 'ink' ? (inkTexture ??= makeTrailTexture(false)) : (glowTexture ??= makeTrailTexture(true));
      const uvs = new Float32Array(POINTS * 4);
      const indices = new Uint32Array(SEGMENTS * 6);
      for (let i = 0; i < POINTS; i++) {
        uvs.set([i / SEGMENTS, 0, i / SEGMENTS, 1], i * 4);
      }
      for (let i = 0; i < SEGMENTS; i++) {
        const p = i * 2;
        indices.set([p, p + 1, p + 2, p + 1, p + 3, p + 2], i * 6);
      }
      mesh = new MeshSimple({ texture, vertices: new Float32Array(POINTS * 4), uvs, indices });
      mesh.blendMode = style === 'ink' ? 'normal' : 'add';
      (style === 'ink' ? this.inkLayer : this.glowLayer).addChild(mesh);
      pool.meshes.push(mesh);
    }
    pool.used++;
    mesh.visible = true;
    return mesh;
  }
}
