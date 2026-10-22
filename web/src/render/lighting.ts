// 动态光照（GPU）。世界先按全亮画出来，再在上面盖一层偏冷的暗色，
// 光源的位置把暗色“擦掉”，最后再把每个光源的颜色叠加上去。
// 光源每帧重新收集：玩家、火盆、营火、熔岩、正在播放的特效。
//
// 暗色层画在半分辨率的渲染纹理里（反正是柔和的渐变），彩色光直接用加法混合的精灵画在世界里。

import { Container, Graphics, RenderTexture, Sprite, Texture, type Renderer } from 'pixi.js';
import type { ActorLight } from './pixi/actorView';

const SCALE = 0.5;               // 暗色层相对 CSS 像素的分辨率
const AMBIENT = 0x0a0616;        // 没被照亮的地方盖的颜色
const AMBIENT_ALPHA = 0.58;

interface Light { x: number; y: number; radius: number; color: string; strength: number; glow: number }

function radial(stops: [number, string][]): Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [at, color] of stops) grad.addColorStop(at, color);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return Texture.from(c);
}

// 一组按需增长、每帧复用的精灵。
class SpritePool {
  private items: Sprite[] = [];
  private used = 0;
  constructor(private parent: Container, private texture: () => Texture, private blend: 'erase' | 'add') {}
  begin(): void { this.used = 0; }
  next(): Sprite {
    let s = this.items[this.used];
    if (!s) {
      s = new Sprite(this.texture());
      s.anchor.set(0.5);
      s.blendMode = this.blend;
      this.parent.addChild(s);
      this.items.push(s);
    }
    s.visible = true;
    this.used++;
    return s;
  }
  end(): void { for (let i = this.used; i < this.items.length; i++) this.items[i].visible = false; }
}

export type Lighting = ReturnType<typeof createLighting>;

// createLighting 返回光照层。screen 是屏幕空间的容器（暗色层放这里），
// world 是跟着镜头走的容器（彩色光放这里）。
export function createLighting(renderer: Renderer, screen: Container, world: Container) {
  const lights: Light[] = [];

  // 暗色层：一块铺满的暗色，加上一组用“擦除”混合挖洞的白色光斑
  const darkScene = new Container();
  const darkFill = new Graphics();
  const holes = new Container();
  darkScene.addChild(darkFill, holes);
  const white = radial([[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.8)'], [0.7, 'rgba(255,255,255,0.28)'], [1, 'rgba(255,255,255,0)']]);
  const holePool = new SpritePool(holes, () => white, 'erase');
  let target: RenderTexture | null = null;
  const darkSprite = new Sprite();
  screen.addChild(darkSprite);

  // 彩色光：白色渐变贴图 + tint 着色。渐变终点是透明黑，叠加后衰减和旧版的颜色渐变一致
  const glowLayer = new Container();
  world.addChild(glowLayer);
  const glowTex = radial([[0, 'rgba(255,255,255,1)'], [1, 'rgba(0,0,0,0)']]);
  const glowPool = new SpritePool(glowLayer, () => glowTex, 'add');

  return {
    begin(): void { lights.length = 0; },

    // dominant 找出照在 (x, y) 处角色身上最亮的光源（光源就在角色身上的不算，比如自己的光）。
    // 返回从光源指向角色的方向和强度，附近没有光时返回 null。要在 add 完所有光源之后调用。
    dominant(x: number, y: number): ActorLight | null {
      let best: Light | null = null;
      let bestAmt = 0;
      let bestDx = 0;
      let bestDy = 0;
      for (const l of lights) {
        const dx = x - l.x;
        const dy = y - l.y;
        const d = Math.hypot(dx, dy);
        if (d < 26 || d > l.radius) continue;
        const fall = 1 - d / l.radius;
        const amt = fall * fall * l.strength * (0.4 + l.glow) * 1.3;
        if (amt > bestAmt) { best = l; bestAmt = amt; bestDx = dx / d; bestDy = dy / d; }
      }
      if (!best || bestAmt < 0.03) return null;
      return { dx: bestDx, dy: bestDy, color: best.color, amt: Math.min(0.8, bestAmt) };
    },

    // add 登记一个世界坐标里的光源。strength (0..1) 擦掉多少暗色，glow (0..1) 彩色光强度。
    add(x: number, y: number, radius: number, color: string, strength = 1, glow = 0.35): void {
      if (radius > 1 && strength > 0.01) lights.push({ x, y, radius, color, strength, glow });
    },

    // render 更新光照层。view 是镜头矩形（世界坐标，已经算上屏幕震动）。
    // enabled 为 false（简化画质）时整层隐藏。
    render(view: { x: number; y: number; w: number; h: number }, enabled: boolean): void {
      darkSprite.visible = enabled;
      glowLayer.visible = enabled;
      if (!enabled) return;
      const w = Math.ceil(view.w * SCALE);
      const h = Math.ceil(view.h * SCALE);
      if (!target || target.width !== w || target.height !== h) {
        target?.destroy(true);
        target = RenderTexture.create({ width: w, height: h, resolution: 1 });
        darkSprite.texture = target;
      }
      darkFill.clear().rect(0, 0, w, h).fill({ color: AMBIENT, alpha: AMBIENT_ALPHA });
      holePool.begin();
      glowPool.begin();
      for (const l of lights) {
        const x = (l.x - view.x) * SCALE;
        const y = (l.y - view.y) * SCALE;
        const r = l.radius * SCALE;
        if (x + r < 0 || y + r < 0 || x - r > w || y - r > h) continue;
        // 光落在地面上：像镜头一样压扁
        const s = holePool.next();
        s.position.set(x, y);
        s.width = r * 2;
        s.height = r * 1.6;
        s.alpha = Math.min(1, l.strength);
        if (l.glow > 0) {
          const rr = l.radius * 0.85;
          const gsp = glowPool.next();
          gsp.position.set(l.x, l.y);
          gsp.width = rr * 2;
          gsp.height = rr * 1.6;
          gsp.tint = l.color;
          gsp.alpha = Math.min(1, l.glow * l.strength);
        }
      }
      holePool.end();
      glowPool.end();
      renderer.render({ container: darkScene, target, clear: true });
      darkSprite.position.set(0, 0);
      darkSprite.scale.set(1 / SCALE);
    },
  };
}
