// 剪影着色器：角色被房子、大树挡住时，在物件上面再画一次角色，只画一圈金色轮廓和很淡的填充，
// 玩家隔着物件也能看到自己在哪（见 actorView.ts 的 xray 精灵）。

import { defaultFilterVert, Filter, GlProgram, UniformGroup } from 'pixi.js';

const fragment = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uInputClamp;
uniform vec3 uColor;        // 剪影颜色
uniform float uWidth;       // 轮廓粗细（贴图像素，高清屏上按像素密度放大，见 XrayFilter.setResolution）

float alphaAt(vec2 uv) {
    return texture(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw)).a;
}

void main() {
    vec2 px = uInputSize.zw;
    float body = texture(uTexture, vTextureCoord).a;
    float near = 0.0;
    for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.7853982;
        near = max(near, alphaAt(vTextureCoord + vec2(cos(a), sin(a)) * uWidth * px));
    }
    // 轮廓：身体外面一圈；里面淡淡填一层
    float ring = near * (1.0 - body);
    float k = ring * 0.95 + body * 0.22;
    finalColor = vec4(uColor, 1.0) * k;
}
`;

let program: GlProgram | null = null;

export class XrayFilter extends Filter {
  constructor(color: [number, number, number] = [1, 0.81, 0.42]) {
    program ??= GlProgram.from({ vertex: defaultFilterVert, fragment, name: 'btdemo-xray', preferredFragmentPrecision: 'highp' });
    const uniforms = new UniformGroup({
      uColor: { value: new Float32Array(color), type: 'vec3<f32>' },
      uWidth: { value: 2, type: 'f32' },
    });
    super({ glProgram: program, resources: { xrayUniforms: uniforms }, padding: 4, resolution: 'inherit' });
    this.xrayUniforms = uniforms;
  }

  private xrayUniforms: UniformGroup;

  // setResolution 按像素密度设置轮廓粗细，屏幕上始终约 2 个 CSS 像素。
  setResolution(res: number): void {
    this.xrayUniforms.uniforms.uWidth = 2 * res;
  }
}
