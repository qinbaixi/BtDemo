// 一个角色在 Pixi 里的显示：地面阴影、自己脚下的金色印记、身体精灵（带墨线着色器）。
// 身体现在是程序化模型画到画布上；接入美术后换成贴图动画或 Spine，阴影、印记、着色器不用变。

import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { drawModel } from '../models';
import { CanvasSprite } from './canvasSprite';
import { InkFilter } from './inkFilter';

// 模型每秒最多重画 24 次，中间复用上一张；位置每帧仍然跟随插值，所以移动是平滑的。
// 手绘动画也大致是这个节奏。
const REDRAW_MS = 1000 / 24;
const HIT_FLASH = 0.35;          // 受击动作里白闪占的比例

// Pose 是模型的一帧姿势（见 models.ts 的 drawModel）。
export interface Pose {
  x: number; y: number; r: number; color: string; facing: number; walk: number;
  moving: boolean; attack: number; hit: number; dead: number; time: number; isSelf: boolean;
}

export class ActorView {
  readonly root = new Container();
  private shadow = new Graphics();
  private sigil = new Container();
  private sigilRing = new Graphics();
  private body = new CanvasSprite();
  private flash = new Sprite();
  private ink: InkFilter | null = null;
  private drawnAt = -1e9;
  private drawnR = 0;
  private drawnRes = 0;
  private drawnDead = false;
  private shadowR = 0;

  constructor(private model: string, private rim: string, parent: Container) {
    this.sigil.scale.set(1, 0.42);
    this.sigil.addChild(this.sigilRing);
    this.flash.blendMode = 'add';
    this.root.addChild(this.shadow, this.sigil, this.body, this.flash);
    parent.addChild(this.root);
  }

  /**
   * update 每帧调用。pose 是本帧姿势（x、y 为脚底的世界坐标），
   * res 是像素密度，hq 为 true 时启用墨线着色器。
   */
  update(pose: Pose, zIndex: number, res: number, hq: boolean, now: number): void {
    const r = pose.r;
    // 对齐到设备像素：角色精灵按整像素显示更清晰
    this.root.position.set(Math.round(pose.x * res) / res, Math.round(pose.y * res) / res);
    this.root.zIndex = zIndex;

    // 硬阴影；自己脚下多一个旋转的金色印记
    if (this.shadowR !== r) {
      this.shadowR = r;
      this.shadow.clear().ellipse(0, 0, r * 1.05, r * 0.4).fill({ color: 0x000000, alpha: 0.5 });
      this.drawSigil(r);
    }
    this.sigil.visible = pose.isSelf && pose.dead < 0;
    this.sigilRing.rotation = now / 2400;

    // 身体：按节奏重画；尸体状态、半径或像素密度变了立刻重画
    const dead = pose.dead >= 0;
    if (now - this.drawnAt >= REDRAW_MS || r !== this.drawnR || res !== this.drawnRes || dead !== this.drawnDead) {
      // 范围要容得下武器和倒地的姿势
      const box = [-r * 3, -r * 3.5, r * 3, r * 1.3];
      this.body.paint(box, res, (g) => drawModel(g, this.model, { ...pose, x: 0, y: 0, bare: true }));
      this.drawnAt = now;
      this.drawnR = r;
      this.drawnDead = dead;
      this.drawnRes = res;
    }

    const flash = !dead && pose.hit >= 0 && pose.hit < HIT_FLASH ? 1 - pose.hit / HIT_FLASH : 0;
    if (hq) {
      this.ink ??= new InkFilter(this.rim);
      this.ink.set(dead, flash);
      if (this.body.filters?.[0] !== this.ink) this.body.filters = [this.ink];
      this.flash.visible = false;
    } else {
      if (this.body.filters) this.body.filters = null;
      // 简化画质的受击：同一张图用加法混合再叠一次
      this.flash.visible = flash > 0;
      if (flash > 0) {
        this.flash.texture = this.body.texture;
        this.flash.scale.copyFrom(this.body.scale);
        this.flash.pivot.copyFrom(this.body.pivot);
        this.flash.alpha = 0.5 * flash;
      }
    }
  }

  private drawSigil(r: number): void {
    const g = this.sigilRing.clear();
    g.circle(0, 0, r + 12).stroke({ width: 2, color: 0xffcf6a, alpha: 0.75 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const pt = (x: number, y: number): [number, number] => [x * c - y * s, x * s + y * c];
      g.poly([...pt(r + 12, -4), ...pt(r + 18, 0), ...pt(r + 12, 4), ...pt(r + 6, 0)]).fill({ color: 0xffcf6a, alpha: 0.9 });
    }
  }

  destroy(): void {
    this.body.filters = null;
    this.ink?.destroy();
    this.flash.texture = Texture.EMPTY;   // 和身体共用贴图，由身体负责销毁
    this.root.destroy({ children: true });
  }
}
