// 烘焙美术模板：把程序画的角色、物件、地表按美术规范的格式导出成图片和清单。
//
// 用途：给美术当“描红模板”——尺寸、锚点、动画帧数都已经对好，照着重画、替换掉就行。
// 也用来验证资源管线：把导出的东西原样放进 web/public/art/，画面应该和程序画的一样。
//
// 只在地址带 ?bake 时挂到 window.btdemo.bake 上，不影响正常游戏。项目文件里的 btdemo/art-templates/
// 就是用它导出的（脚本见 docs/art-spec.md）。

import { MODEL_SCALE, modelBox } from '../game/config';
import { state } from '../game/state';
import type { AnimName, CharacterArt, Manifest, PropArt } from './art';
import { drawModel } from './models';

const PPU = 2;   // 模板按 2 倍分辨率导出（1 世界像素 = 2 图片像素）

// 各模型烘焙时用的碰撞半径（和 config/monsters.yaml、world.yaml 一致）和默认颜色
const CHARACTERS: Record<string, { r: number; color: string }> = {
  knight: { r: 16, color: '#4da3ff' },
  guard: { r: 16, color: '#3b82f6' },
  villager: { r: 13, color: '#f4c27a' },
  slime: { r: 14, color: '#6ccf6c' },
  wolf: { r: 15, color: '#9a9a9a' },
  skeleton_archer: { r: 14, color: '#e8e3d0' },
  ogre_chief: { r: 26, color: '#c0392b' },
};

// 每个动画的帧数；待机按 fps 循环，其余按进度取帧
const ANIMS: [AnimName, number, number?][] = [
  ['idle', 8, 6], ['walk', 8], ['attack', 8], ['hit', 4], ['death', 8],
];

export interface Baked { files: Record<string, string>; manifest: Manifest }   // 文件名 -> data URL

export function bakeAll(): Baked {
  const files: Record<string, string> = {};
  const manifest: Manifest = { characters: {}, props: {} };
  for (const [name, c] of Object.entries(CHARACTERS)) {
    const { canvas, def } = bakeCharacter(name, c.r, c.color);
    files[def.sheet] = canvas.toDataURL('image/png');
    manifest.characters![name] = def;
  }
  if (state.scenery) {
    for (const [kind, { def, canvases }] of Object.entries(bakeProps())) {
      def.images.forEach((path, i) => { files[path] = canvases[i].toDataURL('image/png'); });
      manifest.props![kind] = def;
    }
    manifest.ground = 'ground/ground.png';
    files[manifest.ground] = (state.scenery.ground as HTMLCanvasElement).toDataURL('image/png');
  }
  return { files, manifest };
}

// bakeCharacter 把一个模型的全部动画排成一张图：每行一个动画，每格一帧。
export function bakeCharacter(model: string, radius: number, color?: string): { canvas: HTMLCanvasElement; def: CharacterArt } {
  const r = radius * MODEL_SCALE;
  // 和 ActorView 画程序模型时的范围一样，容得下武器和倒地
  const box = modelBox(model, r);
  const fw = Math.ceil((box[2] - box[0]) * PPU);
  const fh = Math.ceil((box[3] - box[1]) * PPU);
  const cols = Math.max(...ANIMS.map((a) => a[1]));
  const canvas = document.createElement('canvas');
  canvas.width = fw * cols;
  canvas.height = fh * ANIMS.length;
  const g = canvas.getContext('2d')!;
  const def: CharacterArt = {
    sheet: `characters/${model}.png`, frame: [fw, fh], anchor: [Math.round(-box[0] * PPU), Math.round(-box[1] * PPU)],
    ppu: PPU, refR: radius, anims: {},
  };
  ANIMS.forEach(([name, n, fps], row) => {
    def.anims[name] = fps ? { row, frames: n, fps } : { row, frames: n };
    for (let i = 0; i < n; i++) {
      const k = i / n;
      const pose = {
        x: 0, y: 0, r, color, facing: 0, walk: 0, moving: false, attack: -1, hit: -1, dead: -1,
        time: 0, isSelf: false, bare: true,
      };
      if (name === 'idle') pose.time = (i / fps!) * 1000;
      if (name === 'walk') { pose.moving = true; pose.walk = k * Math.PI * 2; }
      if (name === 'attack') pose.attack = (i + 0.5) / n;
      if (name === 'hit') pose.hit = (i + 0.5) / n;
      if (name === 'death') pose.dead = (i + 1) / n;
      g.save();
      g.beginPath();
      g.rect(i * fw, row * fh, fw, fh);
      g.clip();
      g.translate(i * fw + def.anchor[0], row * fh + def.anchor[1]);
      g.scale(PPU, PPU);
      g.lineJoin = 'round';
      g.lineCap = 'round';
      drawModel(g, model, pose);
      g.restore();
    }
  });
  return { canvas, def };
}

// bakeProps 导出地图上每种物件的每个外观变体；火盆、营火等动态物件导出一行动画帧。
function bakeProps(): Record<string, { def: PropArt; canvases: HTMLCanvasElement[] }> {
  const sc = state.scenery!;
  const variants = new Map<string, number>();
  for (const p of sc.props) variants.set(p.kind, Math.max(variants.get(p.kind) ?? 0, p.variant || 0));
  const out: Record<string, { def: PropArt; canvases: HTMLCanvasElement[] }> = {};
  for (const [kind, maxV] of variants) {
    const kd = sc.kindOf({ kind });
    if (kd.still) continue;   // 墙按两端点画，不是一张图能表示的
    const canvases: HTMLCanvasElement[] = [];
    let anchor: [number, number] = [0, 0];
    let frames = 1;
    for (let v = 0; v <= maxV; v++) {
      const p = { kind, x: 0, y: 0, s: 1, variant: v, flip: false };
      if (kd.live) {
        // 动态物件：横向排 12 帧，1 秒一个循环
        frames = 12;
        const [x0, y0, x1, y1] = kd.box;
        const w = Math.ceil((x1 - x0) * PPU);
        const h = Math.ceil((y1 - y0) * PPU);
        const c = document.createElement('canvas');
        c.width = w * frames;
        c.height = h;
        const g = c.getContext('2d')!;
        for (let i = 0; i < frames; i++) {
          g.save();
          g.beginPath();
          g.rect(i * w, 0, w, h);
          g.clip();
          g.translate(i * w - x0 * PPU, -y0 * PPU);
          g.scale(PPU, PPU);
          g.lineJoin = 'round';
          g.lineCap = 'round';
          sc.drawLive(g, p, (i / frames) * 1000);
          g.restore();
        }
        anchor = [Math.round(-x0 * PPU), Math.round(-y0 * PPU)];
        canvases.push(c);
      } else {
        const sp = sc.propSprite(p);
        anchor = [Math.round(sp.ox * PPU), Math.round(sp.oy * PPU)];
        canvases.push(sp.canvas);
      }
    }
    const images = canvases.map((_, v) => `props/${kind}_${v}.png`);
    out[kind] = { def: frames > 1 ? { images, anchor, ppu: PPU, frames, fps: 12 } : { images, anchor, ppu: PPU }, canvases };
  }
  return out;
}
