// 墨线着色器：在 GPU 上给角色加上
//   1. 一圈粗黑描边（8 个方向采样透明度），
//   2. 左上方向的彩色轮廓光（自身减去向右下平移的自身），
//   3. 附近主光源（火堆、魂火……）方向的一道光源颜色轮廓光，
//   4. 受击后一瞬间的整体白闪，
//   5. 尸体消失时的噪声溶解，边缘带火光。
// 以前这些在 CPU 上用离屏画布逐层合成（旧 ink.js），现在每个角色只是一个带滤镜的精灵；
// 以后换成美术贴图或 Spine 骨骼动画，同一个滤镜照样能用。

import { defaultFilterVert, Filter, GlProgram, UniformGroup } from 'pixi.js';
import type { ActorLight } from './actorView';

const fragment = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputSize;    // 输入纹理尺寸（CSS 像素），zw 是一个 CSS 像素的 uv 大小
uniform vec4 uInputClamp;   // 可采样的 uv 范围

uniform vec3 uInk;          // 描边颜色
uniform float uOutline;     // 描边粗细（CSS 像素）
uniform float uDead;        // 1 = 尸体：描边变淡，不画轮廓光
uniform vec3 uRim;          // 轮廓光颜色
uniform float uRimOn;       // 0 = 不画轮廓光
uniform vec2 uRimShift;     // 轮廓光的平移（CSS 像素），指向背光的方向
uniform vec3 uFlash;        // 白闪颜色
uniform float uFlashAmt;    // 白闪强度 0..1
uniform float uDissolve;    // 溶解进度 0..1，小于 0 不溶解
uniform vec3 uBurn;         // 溶解边缘的火光颜色
uniform vec3 uLight;        // 附近主光源的颜色
uniform float uLightAmt;    // 主光源强度 0..1，0 不画
uniform vec2 uLightShift;   // 从光源指向角色的方向 × 宽度（CSS 像素）

// 值噪声：格点上随机数，格子里平滑插值
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float alphaAt(vec2 uv) {
    return texture(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw)).a;
}

void main() {
    vec2 px = uInputSize.zw;
    vec4 body = texture(uTexture, vTextureCoord);

    // 描边：8 个方向上有多少个采样点落在身体里
    float hits = 0.0;
    for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.7853982;
        hits += step(0.02, alphaAt(vTextureCoord + vec2(cos(a), sin(a)) * uOutline * px));
    }
    // 活着：只要有一个方向碰到就是实心描边；尸体：每个方向叠 0.18，和旧版一致
    float ink = uDead > 0.5 ? 1.0 - pow(0.82, hits) : step(0.5, hits);

    // 先画描边，再把身体盖上去（预乘透明度）
    vec4 col = vec4(uInk, 1.0) * ink;
    col = body + col * (1.0 - body.a);

    // 轮廓光：身体里、但平移后的身体覆盖不到的地方，叠加 0.75
    if (uRimOn > 0.5 && uDead < 0.5) {
        float rim = body.a * (1.0 - alphaAt(vTextureCoord - uRimShift * px));
        col.rgb += uRim * rim * 0.75;
    }

    // 主光源：朝着光的那一侧边缘亮一道光源颜色，身上也略微染上一点
    if (uLightAmt > 0.01) {
        float lit = body.a * (1.0 - alphaAt(vTextureCoord - uLightShift * px));
        col.rgb += uLight * lit * uLightAmt * (uDead > 0.5 ? 0.4 : 0.9);
        col.rgb += body.rgb * uLight * uLightAmt * 0.18;
    }

    // 白闪：身体剪影（不含描边）覆盖一层白色
    if (uFlashAmt > 0.0) {
        float k = 0.65 * uFlashAmt * body.a;
        col = vec4(uFlash, 1.0) * k + col * (1.0 - k);
    }

    // 溶解：噪声低于阈值的像素烧掉，阈值附近一圈发出火光（亮到能被泛光晕开）
    if (uDissolve >= 0.0) {
        vec2 p = vTextureCoord * uInputSize.xy;
        float n = vnoise(p / 7.0) * 0.65 + vnoise(p / 2.5) * 0.35;
        float cut = uDissolve * 1.15 - 0.08;
        float keep = step(cut, n);
        float edge = keep * (1.0 - smoothstep(cut, cut + 0.09, n)) * step(0.001, uDissolve);
        col *= keep;
        col.rgb += uBurn * edge * col.a * 2.0;
    }
    finalColor = col;
}
`;

let program: GlProgram | null = null;

export const OUTLINE_PX = 2.2;   // 描边粗细，CSS 像素
const RIM_SHIFT = 2.4;           // 轮廓光宽度，CSS 像素
const LIGHT_SHIFT = 2.8;         // 主光源轮廓光的宽度，CSS 像素

// rgb 把 #rrggbb 或 #rgb 转成 0..1 的颜色；格式不对时返回白色，避免着色器里出现 NaN。
function rgb(hex: string): Float32Array {
  let digits = typeof hex === 'string' ? hex.replace('#', '') : '';
  if (digits.length === 3) digits = digits.split('').map((ch) => ch + ch).join('');
  if (!/^[0-9a-f]{6}$/i.test(digits)) return new Float32Array([1, 1, 1]);
  const n = parseInt(digits, 16);
  return new Float32Array([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]);
}

export class InkFilter extends Filter {
  private u: UniformGroup;
  private burn = '';
  private lightColor = '';

  constructor(rimColor: string | null) {
    program ??= GlProgram.from({ vertex: defaultFilterVert, fragment, name: 'btdemo-ink', preferredFragmentPrecision: 'highp' });
    const u = new UniformGroup({
      uInk: { value: rgb('#07040a'), type: 'vec3<f32>' },
      uOutline: { value: OUTLINE_PX, type: 'f32' },
      uDead: { value: 0, type: 'f32' },
      uRim: { value: rgb(rimColor || '#ffffff'), type: 'vec3<f32>' },
      uRimOn: { value: rimColor ? 1 : 0, type: 'f32' },
      uRimShift: { value: new Float32Array([RIM_SHIFT * 0.8, RIM_SHIFT]), type: 'vec2<f32>' },
      uFlash: { value: rgb('#fff6e8'), type: 'vec3<f32>' },
      uFlashAmt: { value: 0, type: 'f32' },
      uDissolve: { value: -1, type: 'f32' },
      uBurn: { value: rgb('#ff6a2a'), type: 'vec3<f32>' },
      uLight: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
      uLightAmt: { value: 0, type: 'f32' },
      uLightShift: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
    });
    super({ glProgram: program, resources: { inkUniforms: u }, padding: Math.ceil(OUTLINE_PX + 2), resolution: 'inherit' });
    this.u = u;
  }

  // set 每帧更新：dead 是否尸体，flash 白闪强度 0..1。
  set(dead: boolean, flash: number): void {
    const v = this.u.uniforms;
    v.uDead = dead ? 1 : 0;
    v.uFlashAmt = flash;
  }

  // setDissolve 设置溶解进度（-1 不溶解）和边缘火光颜色。
  setDissolve(progress: number, burn: string): void {
    const v = this.u.uniforms;
    v.uDissolve = progress;
    if (progress >= 0 && burn !== this.burn) {
      this.burn = burn;
      v.uBurn = rgb(burn);
    }
  }

  // setLight 设置照在角色身上的主光源，null 表示附近没有光。
  setLight(light: ActorLight | null): void {
    const v = this.u.uniforms;
    v.uLightAmt = light ? light.amt : 0;
    if (!light) return;
    if (light.color !== this.lightColor) {
      this.lightColor = light.color;
      v.uLight = rgb(light.color);
    }
    const shift = v.uLightShift as Float32Array;
    shift[0] = light.dx * LIGHT_SHIFT;
    shift[1] = light.dy * LIGHT_SHIFT;
  }
}
