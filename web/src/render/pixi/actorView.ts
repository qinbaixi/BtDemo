// 一个角色在 Pixi 里的显示：地面阴影、自己脚下的金色印记、身体精灵（带墨线着色器）。
// 身体有美术图（art.ts 的清单里有这个模型）就播放图片动画，否则用程序化模型画到画布上；
// 阴影、印记、着色器两种情况都一样。

import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { MODEL_SCALE, modelBox } from '../../game/config';
import { art, type LoadedCharacter } from '../art';
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
  blocking?: boolean;   // 正在格挡（举盾）
  knockX?: number;      // 受击被推开的显示偏移（像素，服务端位置不变）
  knockY?: number;
  squash?: number;      // 受击形变：正数横向变宽、纵向变扁
  dissolve?: number;    // 尸体溶解进度 0..1，-1 或不填表示不溶解
  burn?: string;        // 溶解边缘的火光颜色
  light?: ActorLight | null;   // 附近最亮的光源（给身体加一道那个颜色的轮廓光）
}

// ActorLight 是照在角色身上的主光源：(dx, dy) 是从光源指向角色的单位向量，amt 是强度 0..1。
export interface ActorLight { dx: number; dy: number; color: string; amt: number }

export class ActorView {
  readonly root = new Container();
  dissolving = false;                 // 已经开始溶解（world.ts 用它在开始时放一次灰烬）
  private shadow = new Graphics();
  private sigil = new Container();
  private sigilRing = new Graphics();
  private figure = new Container();   // 身体 + 白闪，受击形变整体缩放这一层（以脚底为原点）
  private body: Sprite;
  private canvasBody: CanvasSprite | null = null;
  private sheet: LoadedCharacter | null;
  private flash = new Sprite();
  private ink: InkFilter | null = null;
  private drawnAt = -1e9;
  private drawnR = 0;
  private drawnRes = 0;
  private drawnDead = false;
  private shadowR = 0;

  constructor(private model: string, private rim: string, parent: Container) {
    this.sheet = art.characters.get(model) ?? null;
    this.body = this.sheet ? new Sprite() : (this.canvasBody = new CanvasSprite());
    this.sigil.scale.set(1, 0.42);
    this.sigil.addChild(this.sigilRing);
    this.flash.blendMode = 'add';
    this.figure.addChild(this.body, this.flash);
    this.root.addChild(this.shadow, this.sigil, this.figure);
    parent.addChild(this.root);
  }

  /**
   * update 每帧调用。pose 是本帧姿势（x、y 为脚底的世界坐标），
   * res 是像素密度，hq 为 true 时启用墨线着色器。
   */
  update(pose: Pose, zIndex: number, res: number, hq: boolean, now: number): void {
    const r = pose.r;
    // 对齐到设备像素：角色精灵按整像素显示更清晰
    // 受击推开只挪身体，影子留在脚下；尸体被打飞时影子跟着走
    const corpse = pose.dead >= 0;
    const knockX = pose.knockX || 0;
    const knockY = pose.knockY || 0;
    const x = pose.x + (corpse ? knockX : 0);
    const y = pose.y + (corpse ? knockY : 0);
    this.root.position.set(Math.round(x * res) / res, Math.round(y * res) / res);
    this.figure.position.set(corpse ? 0 : Math.round(knockX * res) / res, corpse ? 0 : Math.round(knockY * res) / res);
    this.root.zIndex = zIndex;
    const squash = pose.squash || 0;
    this.figure.scale.set(1 + squash, 1 - squash * 0.8);
    const dissolve = pose.dissolve ?? -1;
    // 溶解完了就整个藏起来，等复活
    this.root.visible = dissolve < 1;
    this.shadow.alpha = dissolve > 0 ? 1 - dissolve : 1;

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
    if (this.sheet) {
      this.showFrame(pose);
    } else if (now - this.drawnAt >= REDRAW_MS || r !== this.drawnR || res !== this.drawnRes || dead !== this.drawnDead) {
      // 范围要容得下武器和倒地的姿势
      const box = modelBox(this.model, r);
      this.canvasBody!.paint(box, res, (g) => drawModel(g, this.model, { ...pose, x: 0, y: 0, bare: true }));
      this.drawnAt = now;
      this.drawnR = r;
      this.drawnDead = dead;
      this.drawnRes = res;
    }

    const flash = !dead && pose.hit >= 0 && pose.hit < HIT_FLASH ? 1 - pose.hit / HIT_FLASH : 0;
    if (hq) {
      this.ink ??= new InkFilter(this.rim);
      this.ink.set(dead, flash);
      this.ink.setDissolve(dissolve, pose.burn || '#ff6a2a');
      this.ink.setLight(pose.light ?? null);
      if (this.body.filters?.[0] !== this.ink) this.body.filters = [this.ink];
      this.body.alpha = 1;
      this.flash.visible = false;
    } else {
      if (this.body.filters) this.body.filters = null;
      // 简化画质没有溶解着色器：直接淡出
      this.body.alpha = dissolve > 0 ? 1 - dissolve : 1;
      // 简化画质的受击：同一张图用加法混合再叠一次
      this.flash.visible = flash > 0;
      if (flash > 0) {
        this.flash.texture = this.body.texture;
        this.flash.scale.copyFrom(this.body.scale);
        this.flash.pivot.copyFrom(this.body.pivot);
        this.flash.anchor.copyFrom(this.body.anchor);
        this.flash.alpha = 0.5 * flash;
      }
    }
  }

  // showFrame 按姿势挑美术动画的一帧：死亡、受击、攻击按进度，走路按步伐相位，待机按时间循环。
  private showFrame(pose: Pose): void {
    const { def, anims } = this.sheet!;
    const pick = (): [Texture[] | undefined, number] => {
      if (pose.dead >= 0 && anims.death) return [anims.death, pose.dead];
      if (pose.hit >= 0 && anims.hit) return [anims.hit, pose.hit];
      if (pose.attack >= 0 && anims.attack) return [anims.attack, pose.attack];
      if (pose.blocking && anims.block) return [anims.block, 0];
      if (pose.moving && anims.walk) return [anims.walk, (((pose.walk / (Math.PI * 2)) % 1) + 1) % 1];
      const idle = anims.idle || anims.walk;
      const fps = def.anims.idle?.fps ?? 8;
      return [idle, idle ? ((pose.time / 1000) * fps / idle.length) % 1 : 0];
    };
    const [frames, k] = pick();
    if (!frames?.length) return;
    this.body.texture = frames[Math.min(frames.length - 1, Math.floor(k * frames.length))];
    const [fw, fh] = def.frame;
    this.body.anchor.set(def.anchor[0] / fw, def.anchor[1] / fh);
    // 图按 refR 的体型画的：实体半径不同就等比缩放
    let s = 1 / (def.ppu || 2);
    if (def.refR) s *= pose.r / (def.refR * MODEL_SCALE);
    const dir = Math.cos(pose.facing) < -0.1 ? -1 : 1;
    this.body.scale.set(s * dir, s);
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
    if (this.sheet) this.body.texture = Texture.EMPTY;   // 美术贴图是共用的，不能跟着角色销毁
    this.root.destroy({ children: true });
  }
}
