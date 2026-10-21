// 场景在 Pixi 里的显示：地表切块成贴图，物件变成精灵，和角色一起按脚底 y 排序。

import { Container, Sprite, Texture } from 'pixi.js';
import type { Point, Scenery } from '../../game/state';
import { CanvasSprite } from './canvasSprite';

const CHUNK = 1024;      // 地表切块大小，避免超出显卡的最大贴图尺寸
const LIVE_MS = 1000 / 24;   // 动态物件（火焰）每秒重画 24 次，和角色一致

interface PropView {
  p: any;
  node: Sprite;
  live: boolean;          // 需要不断重画（火焰）
  paintedAt: number;
}

export class SceneView {
  private ground = new Container();
  private props: PropView[] = [];
  private byProp = new Map<any, PropView>();
  private textures = new Map<HTMLCanvasElement, Texture>();

  constructor(private scenery: Scenery, groundLayer: Container, private depth: Container, private res: number) {
    this.buildGround();
    groundLayer.addChild(this.ground);
    for (const p of scenery.props) this.addProp(p);
  }

  private buildGround(): void {
    const src = this.scenery.ground as HTMLCanvasElement;
    for (let y = 0; y < src.height; y += CHUNK) {
      for (let x = 0; x < src.width; x += CHUNK) {
        const w = Math.min(CHUNK, src.width - x);
        const h = Math.min(CHUNK, src.height - y);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d')!.drawImage(src, x, y, w, h, 0, 0, w, h);
        const s = new Sprite(Texture.from(c));
        s.position.set(x, y);
        this.ground.addChild(s);
      }
    }
  }

  private addProp(p: any): void {
    const def = this.scenery.kindOf(p);
    let node: Sprite;
    let live = false;
    if (def.live) {
      const cs = new CanvasSprite();
      cs.position.set(p.x, p.y);
      if (def.still) {
        // 墙：范围由两端点决定，只画一次
        const s = p.s;
        const dx = (p.dx || 0) * s;
        const dy = (p.dy || 0) * s;
        const box = [Math.min(0, dx) - 12 * s, Math.min(0, dy) - 22 * s, Math.max(0, dx) + 12 * s, Math.max(0, dy) + 6 * s];
        cs.paint(box, this.res, (g) => this.scenery.drawLive(g, p, 0));
      } else {
        live = true;
      }
      node = cs;
    } else {
      const sp = this.scenery.propSprite(p);
      let tex = this.textures.get(sp.canvas);
      if (!tex) {
        tex = Texture.from(sp.canvas);
        this.textures.set(sp.canvas, tex);
      }
      node = new Sprite(tex);
      node.position.set(p.x - sp.ox, p.y - sp.oy);
      node.width = sp.w;
      node.height = sp.h;
    }
    node.zIndex = p.y;
    node.visible = false;
    this.depth.addChild(node);
    const v = { p, node, live, paintedAt: -1e9 };
    this.props.push(v);
    this.byProp.set(p, v);
  }

  // update 每帧调用：只显示镜头里的物件，重画动态物件，处理高物件的半透明。
  update(view: { x: number; y: number; w: number; h: number }, time: number, focus: Point | null): void {
    for (const v of this.props) v.node.visible = false;
    for (const p of this.scenery.visible(view)) {
      const v = this.byProp.get(p);
      if (!v) continue;
      v.node.visible = true;
      v.node.alpha = this.scenery.seeThrough(p, focus) ? 0.42 : 1;
      if (v.live && time - v.paintedAt >= LIVE_MS) {
        v.paintedAt = time;
        const def = this.scenery.kindOf(p);
        const box = def.box.map((n: number) => n * p.s);
        (v.node as CanvasSprite).paint(box, this.res, (g) => this.scenery.drawLive(g, p, time));
      }
    }
  }

  destroy(): void {
    this.ground.destroy({ children: true, texture: true, textureSource: true });
    for (const v of this.props) v.node.destroy();
    for (const t of this.textures.values()) t.destroy(true);
  }
}
