// 后期处理：整个画面渲染完以后再加几道效果。
//   1. 扭曲：技能的冲击波把画面往外推一圈，火焰上方的热浪让画面轻轻晃动（只改采样位置，几乎不花钱）。
//   2. 泛光（bloom）：把亮的地方（火、岩浆、魂火、技能特效）提出来、模糊、再加回去，亮处会晕开一圈光。
//      做法是降采样金字塔：亮部先画到 1/2 分辨率，再逐级缩到 1/4、1/8、1/16，然后逐级放大叠回来。
//      每一级都只做 4 次采样，低分辨率上的模糊很便宜，叠起来光晕又大又柔。
//   3. 调色（color grading）：用 LUT 颜色查找表把每个颜色映射成新颜色。可以同时给两张 LUT 按比例混合，
//      走到不同区域时调色平滑过渡（grade.ts 的 ZONE_GRADES）。
//
// 坐标说明：Pixi 滤镜里 uInputSize 是 CSS 像素，所以采样偏移都按 CSS 像素算。

import {
  defaultFilterVert, Filter, FilterSystem, GlProgram, RenderSurface, Texture, TexturePool, UniformGroup,
  type TextureSource,
} from 'pixi.js';
import { LUT_SIZE } from '../grade';

// 冲击波和热浪最多各几个（着色器里是固定大小的数组）
export const MAX_WAVES = 8;
export const MAX_HEAT = 8;

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

// 金字塔的一次缩小或放大：在四个斜角方向各采样一次取平均，再乘一个权重
const kawaseFrag = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uInputClamp;
uniform float uOffset;
uniform float uWeight;
vec4 at(vec2 d) {
    return texture(uTexture, clamp(vTextureCoord + d * uInputSize.zw, uInputClamp.xy, uInputClamp.zw));
}
void main() {
    float o = uOffset;
    finalColor = (at(vec2(-o, -o)) + at(vec2(o, -o)) + at(vec2(-o, o)) + at(vec2(o, o))) * 0.25 * uWeight;
}`;

// 合成：扭曲采样位置 → 原图 + 泛光 → 两张 LUT 按比例混合调色
const compositeFrag = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uBloom;
uniform sampler2D uLut;
uniform sampler2D uLut2;
uniform vec4 uInputSize;
uniform vec4 uInputClamp;
uniform float uBloomAmt;
uniform float uGradeAmt;
uniform float uLutMix;
uniform vec2 uBloomScale;            // 泛光纹理和画面纹理的底图大小不同：画面 uv × 这个比例 = 泛光 uv
uniform vec2 uBloomClamp;            // 泛光纹理里有内容的范围（池里的纹理比画面大，外面是旧内容）
uniform float uTime;
uniform vec4 uWaves[${MAX_WAVES}];   // 屏幕坐标 x, y（CSS 像素）、半径、推开的距离
uniform float uWaveCount;
uniform vec4 uHeat[${MAX_HEAT}];     // 屏幕坐标 x, y（火焰底部）、宽度、强度
uniform float uHeatCount;

const float N = ${LUT_SIZE.toFixed(1)};
// LUT 是一张 (N*N) x N 的横条：N 块小方格按蓝色从小到大排开，每块里横向是红、纵向是绿
vec3 lutOf(sampler2D table, vec3 c) {
    float b = c.b * (N - 1.0);
    float b0 = floor(b);
    float b1 = min(b0 + 1.0, N - 1.0);
    vec2 uv = vec2((c.r * (N - 1.0) + 0.5) / (N * N), (c.g * (N - 1.0) + 0.5) / N);
    vec3 c0 = texture(table, vec2(uv.x + b0 / N, uv.y)).rgb;
    vec3 c1 = texture(table, vec2(uv.x + b1 / N, uv.y)).rgb;
    return mix(c0, c1, b - b0);
}

vec2 distortion(vec2 pos) {
    vec2 off = vec2(0.0);
    for (int i = 0; i < ${MAX_WAVES}; i++) {
        if (float(i) >= uWaveCount) break;
        vec4 w = uWaves[i];
        vec2 d = pos - w.xy;
        d.y *= 1.6;                                    // 地面上的圈是压扁的椭圆
        float dist = length(d);
        float width = 10.0 + w.z * 0.12;
        float ring = exp(-pow((dist - w.z) / width, 2.0));
        vec2 normal = normalize(vec2(d.x, d.y * 1.6) + 1e-4);   // 椭圆的法线方向（d.y 已经乘过一次 1.6）
        off -= normal * ring * w.w;                    // 圈上的像素从外面采样：画面像被往外推
    }
    for (int i = 0; i < ${MAX_HEAT}; i++) {
        if (float(i) >= uHeatCount) break;
        vec4 h = uHeat[i];
        vec2 rel = pos - h.xy;
        // 火焰上方一片：横向越靠中间越强，往上先变强再慢慢消失
        float across = max(0.0, 1.0 - abs(rel.x) / h.z);
        float up = -rel.y / h.z;
        float rise = smoothstep(-0.2, 0.4, up) * (1.0 - smoothstep(1.2, 2.6, up));
        float k = across * across * rise * h.w;
        off.x += sin(pos.y * 0.21 - uTime * 7.0 + h.x * 0.1) * k;
        off.y += cos(pos.x * 0.17 - uTime * 5.0) * k * 0.6;
    }
    return off;
}

void main() {
    vec2 pos = vTextureCoord * uInputSize.xy;
    vec2 uv = clamp(vTextureCoord + distortion(pos) * uInputSize.zw, uInputClamp.xy, uInputClamp.zw);
    vec3 c = texture(uTexture, uv).rgb;
    vec3 bloom = texture(uBloom, min(uv * uBloomScale, uBloomClamp)).rgb;
    // 加上泛光后超过 1 的部分柔和地压回去，不会一片死白
    c += bloom * uBloomAmt * 0.6;   // 金字塔几级叠起来比单张模糊亮，压回到原来的亮度附近
    c = c / (1.0 + max(c - 0.8, 0.0) * 0.6);
    c = clamp(c, 0.0, 1.0);
    vec3 graded = mix(lutOf(uLut, c), lutOf(uLut2, c), uLutMix);
    c = mix(c, graded, uGradeAmt);
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

// 金字塔每一级相对画面的分辨率：第一级是亮部提取的结果
const LEVELS = [0.5, 0.25, 0.125, 0.0625];
// 放大叠回来时每一级的权重：越大的光晕越淡
const UP_WEIGHT = [0.7, 0.55, 0.45];

export interface PostOptions {
  bloom: number;       // 泛光强度，0 关闭
  threshold: number;   // 亮度超过多少开始发光（0..1）
  grade: number;       // 调色强度 0..1，0 不调色
}

// 一个冲击波或热源，屏幕坐标（CSS 像素）
export interface Distort { x: number; y: number; radius: number; strength: number }

export class PostFilter extends Filter {
  private bright: Filter;
  private brightU: UniformGroup;
  private down: Filter;
  private downU: UniformGroup;
  private up: Filter;
  private upU: UniformGroup;
  private u: UniformGroup;
  private opts: PostOptions;

  constructor(lut: TextureSource, opts: PostOptions) {
    const u = new UniformGroup({
      uBloomAmt: { value: opts.bloom, type: 'f32' },
      uGradeAmt: { value: opts.grade, type: 'f32' },
      uLutMix: { value: 0, type: 'f32' },
      uBloomScale: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
      uBloomClamp: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
      uTime: { value: 0, type: 'f32' },
      uWaves: { value: new Float32Array(MAX_WAVES * 4), type: 'vec4<f32>', size: MAX_WAVES },
      uWaveCount: { value: 0, type: 'f32' },
      uHeat: { value: new Float32Array(MAX_HEAT * 4), type: 'vec4<f32>', size: MAX_HEAT },
      uHeatCount: { value: 0, type: 'f32' },
    });
    super({
      glProgram: program('btdemo-post', compositeFrag),
      resources: { postUniforms: u, uBloom: Texture.EMPTY.source, uLut: lut, uLut2: lut },
      resolution: 'inherit',
    });
    this.u = u;
    this.opts = { ...opts };
    this.brightU = new UniformGroup({
      uThreshold: { value: opts.threshold, type: 'f32' },
      uKnee: { value: 0.12, type: 'f32' },
    });
    this.bright = new Filter({ glProgram: program('btdemo-bright', brightFrag), resources: { brightUniforms: this.brightU } });
    const kawase = () => new UniformGroup({ uOffset: { value: 1, type: 'f32' }, uWeight: { value: 1, type: 'f32' } });
    this.downU = kawase();
    this.down = new Filter({ glProgram: program('btdemo-kawase', kawaseFrag), resources: { kawaseUniforms: this.downU } });
    this.upU = kawase();
    this.up = new Filter({ glProgram: program('btdemo-kawase', kawaseFrag), resources: { kawaseUniforms: this.upU } });
    this.up.blendMode = 'add';   // 放大时叠加到上一级已有的内容上
  }

  // set 调整参数（比如画质切换、调试时试参数）。
  set(opts: Partial<PostOptions>): void {
    Object.assign(this.opts, opts);
    this.u.uniforms.uBloomAmt = this.opts.bloom;
    this.u.uniforms.uGradeAmt = this.opts.grade;
    this.brightU.uniforms.uThreshold = this.opts.threshold;
  }

  // setLuts 设置调色：两张 LUT（见 grade.ts）按 mix（0..1，0 全用第一张）混合。
  setLuts(first: TextureSource, second: TextureSource, mix: number): void {
    this.resources.uLut = first;
    this.resources.uLut2 = second;
    this.u.uniforms.uLutMix = mix;
  }

  // setDistortion 设置这一帧的冲击波和热浪（屏幕坐标），time 是秒，让热浪动起来。
  setDistortion(waves: Distort[], heat: Distort[], time: number): void {
    const v = this.u.uniforms;
    const pack = (list: Distort[], into: Float32Array, max: number) => {
      const n = Math.min(max, list.length);
      for (let i = 0; i < n; i++) into.set([list[i].x, list[i].y, list[i].radius, list[i].strength], i * 4);
      return n;
    };
    v.uWaveCount = pack(waves, v.uWaves as Float32Array, MAX_WAVES);
    v.uHeatCount = pack(heat, v.uHeat as Float32Array, MAX_HEAT);
    v.uTime = time;
  }

  apply(fm: FilterSystem, input: Texture, output: RenderSurface, clearMode: boolean): void {
    let bloom: Texture = Texture.WHITE;
    const temps: Texture[] = [];
    if (this.opts.bloom > 0) {
      const res = input.source._resolution;
      // 金字塔每级都和画面一样大（CSS 像素），只是分辨率更低：Pixi 的滤镜坐标都按 CSS 像素算，这样最省事
      const levels = LEVELS.map((scale) => {
        const texture = TexturePool.getOptimalTexture({ width: input.width, height: input.height, resolution: res * scale });
        temps.push(texture);
        return texture;
      });
      fm.applyFilter(this.bright, input, levels[0], true);
      // 逐级缩小：偏移一个源纹素（CSS 像素 = 1 / 分辨率）
      for (let i = 1; i < levels.length; i++) {
        this.downU.uniforms.uOffset = 1 / (res * LEVELS[i - 1]);
        this.downU.uniforms.uWeight = 1;
        fm.applyFilter(this.down, levels[i - 1], levels[i], true);
      }
      // 逐级放大，叠加到上一级上
      for (let i = levels.length - 1; i > 0; i--) {
        this.upU.uniforms.uOffset = 0.5 / (res * LEVELS[i]);
        this.upU.uniforms.uWeight = UP_WEIGHT[i - 1];
        fm.applyFilter(this.up, levels[i], levels[i - 1], false);
      }
      bloom = levels[0];
    }
    this.resources.uBloom = bloom.source;
    const scale = this.u.uniforms.uBloomScale as Float32Array;
    scale[0] = input.source.width / bloom.source.width;
    scale[1] = input.source.height / bloom.source.height;
    const clampTo = this.u.uniforms.uBloomClamp as Float32Array;
    clampTo[0] = (bloom.frame.width - 1) / bloom.source.width;
    clampTo[1] = (bloom.frame.height - 1) / bloom.source.height;
    fm.applyFilter(this, input, output, clearMode);
    for (const t of temps) TexturePool.returnTexture(t);
  }

  destroy(): void {
    this.bright.destroy();
    this.down.destroy();
    this.up.destroy();
    super.destroy();
  }
}
