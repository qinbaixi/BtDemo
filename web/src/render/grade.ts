// 调色：生成后期处理用的颜色查找表（LUT）。
//
// LUT 是一张 (N*N) x N 的横条图：N 块方格按蓝色从小到大排开，每块里横向是红、纵向是绿，
// 每个格子存“这个颜色调色后变成什么”。着色器查表就能把任意调色一次做完。
// 现在的表由下面的 gradeColor 计算；美术可以用 Photoshop / DaVinci 等工具调好一张同格式的 LUT 图片，
// 调 loadLut(url) 换上（需要 N = 32 的横条格式，即 1024x32）。

import { Texture, type TextureSource } from 'pixi.js';

export const LUT_SIZE = 32;

const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// gradeColor 是默认的调色：冥界的冷紫阴影、暖金高光，略提对比和饱和度。
// 输入输出都是 0..1 的 RGB。
export function gradeColor(r: number, g: number, b: number): [number, number, number] {
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // 饱和度 +12%
  const sat = 1.12;
  r = lum + (r - lum) * sat;
  g = lum + (g - lum) * sat;
  b = lum + (b - lum) * sat;
  // 轻微 S 形对比曲线（和原色按 35% 混合）
  r = r + (smooth(clamp01(r)) - r) * 0.35;
  g = g + (smooth(clamp01(g)) - g) * 0.35;
  b = b + (smooth(clamp01(b)) - b) * 0.35;
  // 分离色调：暗部偏紫，亮部偏金
  const shadow = Math.pow(1 - lum, 3);
  const light = Math.pow(lum, 2);
  r += shadow * 0.025 + light * 0.05;
  g += shadow * 0.0 + light * 0.025;
  b += shadow * 0.05 - light * 0.03;
  return [clamp01(r), clamp01(g), clamp01(b)];
}

// makeLut 把调色函数烘焙成 LUT 贴图。
export function makeLut(fn: typeof gradeColor = gradeColor): TextureSource {
  const N = LUT_SIZE;
  const c = document.createElement('canvas');
  c.width = N * N;
  c.height = N;
  const g = c.getContext('2d')!;
  const img = g.createImageData(N * N, N);
  for (let bi = 0; bi < N; bi++) {
    for (let gi = 0; gi < N; gi++) {
      for (let ri = 0; ri < N; ri++) {
        const [r, gg, b] = fn(ri / (N - 1), gi / (N - 1), bi / (N - 1));
        const i = (gi * N * N + bi * N + ri) * 4;
        img.data[i] = Math.round(r * 255);
        img.data[i + 1] = Math.round(gg * 255);
        img.data[i + 2] = Math.round(b * 255);
        img.data[i + 3] = 255;
      }
    }
  }
  g.putImageData(img, 0, 0);
  return Texture.from(c).source;
}

// loadLut 加载美术提供的 LUT 图片（1024x32 横条）。
export async function loadLut(url: string): Promise<TextureSource> {
  const img = new Image();
  img.src = url;
  await img.decode();
  if (img.width !== LUT_SIZE * LUT_SIZE || img.height !== LUT_SIZE) {
    throw new Error(`${url}: LUT 必须是 ${LUT_SIZE * LUT_SIZE}x${LUT_SIZE}`);
  }
  return Texture.from(img).source;
}
