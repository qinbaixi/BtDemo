// 后期处理：整个画面渲染完以后再加两道效果。
//   1. 泛光（bloom）：把亮的地方（火、岩浆、魂火、技能特效）提出来、模糊、再加回去，亮处会晕开一圈光。
//   2. 调色（color grading）：用一张 LUT 颜色查找表把每个颜色映射成新颜色，统一整个画面的色调。
//      LUT 默认由 grade.ts 的 gradeColor 生成；美术可以在 Photoshop 等工具里调好色，导出 LUT 图片替换。
//
// 做法：亮部提取 → 多次 Kawase 模糊（每次 4 个斜向采样、偏移越来越大，便宜又够柔和）→
// 最后一遍把原图、泛光和调色合在一起输出。

import {
  defaultFilterVert, Filter, FilterSystem, GlProgram, RenderSurface, Texture, TexturePool, UniformGroup,
  type TextureSource,
} from 'pixi.js';
import { LUT_SIZE } from '../grade';

// 亮部提取：亮度超过阈值的部分保留，阈值附近平滑过渡（soft knee），避免一刀切的硬边
const brightFrag = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uThreshold;
uniform float uKnee;
void main() {
    vec3 c = texture(uTexture, vTextureCoord).rgb;
    float b = max(c.r, max(c.g, c.b));
    float soft = clamp(b - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-4);
    float k = max(soft, b - uThreshold) / max(b, 1e-4);
    finalColor = vec4(c * k, 1.0);
}`;

// Kawase 模糊的一次：在四个斜角方向各采样一次取平均
const kawaseFrag = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uInputClamp;
uniform float uOffset;
vec4 at(vec2 d) {
    return texture(uTexture, clamp(vTextureCoord + d * uInputSize.zw, uInputClamp.xy, uInputClamp.zw));
}
void main() {
    float o = uOffset;
    finalColor = (at(vec2(-o, -o)) + at(vec2(o, -o)) + at(vec2(-o, o)) + at(vec2(o, o))) * 0.25;
}`;

// 合成：原图 + 泛光，再查 LUT 调色
const compositeFrag = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uBloom;
uniform sampler2D uLut;
uniform float uBloomAmt;
uniform float uGradeAmt;

const float N = ${LUT_SIZE.toFixed(1)};
// LUT 是一张 (N*N) x N 的横条：N 块小方格按蓝色从小到大排开，每块里横向是红、纵向是绿
vec3 lut(vec3 c) {
    float b = c.b * (N - 1.0);
    float b0 = floor(b);
    float b1 = min(b0 + 1.0, N - 1.0);
    vec2 uv = vec2((c.r * (N - 1.0) + 0.5) / (N * N), (c.g * (N - 1.0) + 0.5) / N);
    vec3 c0 = texture(uLut, vec2(uv.x + b0 / N, uv.y)).rgb;
    vec3 c1 = texture(uLut, vec2(uv.x + b1 / N, uv.y)).rgb;
    return mix(c0, c1, b - b0);
}

void main() {
    vec3 c = texture(uTexture, vTextureCoord).rgb;
    vec3 bloom = texture(uBloom, vTextureCoord).rgb;
    // 加上泛光后超过 1 的部分柔和地压回去，不会一片死白
    c += bloom * uBloomAmt;
    c = c / (1.0 + max(c - 0.8, 0.0) * 0.6);
    c = clamp(c, 0.0, 1.0);
    c = mix(c, lut(c), uGradeAmt);
    finalColor = vec4(c, 1.0);
}`;

const programs = new Map<string, GlProgram>();
function program(name: string, fragment: string): GlProgram {
  let p = programs.get(name);
  if (!p) {
    p = GlProgram.from({ vertex: defaultFilterVert, fragment, name, preferredFragmentPrecision: 'highp' });
    programs.set(name, p);
  }
  return p;
}

// 每次模糊的采样偏移（CSS 像素）：越往后越大，叠起来泛光半径约 20 像素
const KAWASE = [0.5, 1.5, 2.5, 3.5, 4.5];

export interface PostOptions {
  bloom: number;       // 泛光强度，0 关闭
  threshold: number;   // 亮度超过多少开始发光（0..1）
  grade: number;       // 调色强度 0..1，0 不调色
}

export class PostFilter extends Filter {
  private bright: Filter;
  private brightU: UniformGroup;
  private kawase: Filter;
  private kawaseU: UniformGroup;
  private u: UniformGroup;
  private opts: PostOptions;

  constructor(lut: TextureSource, opts: PostOptions) {
    const u = new UniformGroup({
      uBloomAmt: { value: opts.bloom, type: 'f32' },
      uGradeAmt: { value: opts.grade, type: 'f32' },
    });
    super({
      glProgram: program('btdemo-post', compositeFrag),
      resources: { postUniforms: u, uBloom: Texture.EMPTY.source, uLut: lut },
      resolution: 'inherit',
    });
    this.u = u;
    this.opts = { ...opts };
    this.brightU = new UniformGroup({
      uThreshold: { value: opts.threshold, type: 'f32' },
      uKnee: { value: 0.12, type: 'f32' },
    });
    this.bright = new Filter({ glProgram: program('btdemo-bright', brightFrag), resources: { brightUniforms: this.brightU }, resolution: 'inherit' });
    this.kawaseU = new UniformGroup({ uOffset: { value: 1, type: 'f32' } });
    this.kawase = new Filter({ glProgram: program('btdemo-kawase', kawaseFrag), resources: { kawaseUniforms: this.kawaseU }, resolution: 'inherit' });
  }

  // set 调整参数（比如画质切换、调试时试参数）。
  set(opts: Partial<PostOptions>): void {
    Object.assign(this.opts, opts);
    this.u.uniforms.uBloomAmt = this.opts.bloom;
    this.u.uniforms.uGradeAmt = this.opts.grade;
    this.brightU.uniforms.uThreshold = this.opts.threshold;
  }

  // setLut 换一张调色 LUT（见 grade.ts）。
  setLut(lut: TextureSource): void {
    this.resources.uLut = lut;
  }

  apply(fm: FilterSystem, input: Texture, output: RenderSurface, clearMode: boolean): void {
    let bloom: Texture = Texture.WHITE;
    const temps: Texture[] = [];
    if (this.opts.bloom > 0) {
      let a = TexturePool.getSameSizeTexture(input);
      let b = TexturePool.getSameSizeTexture(input);
      temps.push(a, b);
      fm.applyFilter(this.bright, input, a, true);
      for (const o of KAWASE) {
        this.kawaseU.uniforms.uOffset = o;
        fm.applyFilter(this.kawase, a, b, true);
        [a, b] = [b, a];
      }
      bloom = a;
    }
    this.resources.uBloom = bloom.source;
    fm.applyFilter(this, input, output, clearMode);
    for (const t of temps) TexturePool.returnTexture(t);
  }

  destroy(): void {
    this.bright.destroy();
    this.kawase.destroy();
    super.destroy();
  }
}
