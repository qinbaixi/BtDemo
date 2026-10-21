// 墨线着色器：在 GPU 上给角色加上
//   1. 一圈粗黑描边（8 个方向采样透明度），
//   2. 左上方向的彩色轮廓光（自身减去向右下平移的自身），
//   3. 受击后一瞬间的整体白闪。
// 以前这些在 CPU 上用离屏画布逐层合成（旧 ink.js），现在每个角色只是一个带滤镜的精灵；
// 以后换成美术贴图或 Spine 骨骼动画，同一个滤镜照样能用。

import { defaultFilterVert, Filter, GlProgram, UniformGroup } from 'pixi.js';

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

    // 白闪：身体剪影（不含描边）覆盖一层白色
    if (uFlashAmt > 0.0) {
        float k = 0.65 * uFlashAmt * body.a;
        col = vec4(uFlash, 1.0) * k + col * (1.0 - k);
    }
    finalColor = col;
}
`;

let program: GlProgram | null = null;

export const OUTLINE_PX = 2.2;   // 描边粗细，CSS 像素
const RIM_SHIFT = 2.4;           // 轮廓光宽度，CSS 像素

function rgb(hex: string): Float32Array {
  const n = parseInt(hex.replace('#', ''), 16);
  return new Float32Array([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]);
}

export class InkFilter extends Filter {
  private u: UniformGroup;

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
}
