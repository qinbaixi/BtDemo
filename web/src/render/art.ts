// 美术资源：读 /art/manifest.json，把美术画的图接进画面。
//
// 规则很简单：清单里有的就用图，没有的继续用程序画（models.ts、scenery.ts）。
// 所以美术可以一个一个地替换，不用一次全部做完。格式和要求见 docs/art-spec.md。
//
// 图片放在 web/public/art/ 下，构建时原样复制、嵌进服务端；路径都相对 art/ 目录。

import { Assets, Rectangle, Texture } from 'pixi.js';
import type { Flipbook } from './flipbook';
import { MUZZLE_OVERRIDE } from './knightActions';

// 角色动画：一张图一行一个动画，每格一样大。
export interface CharacterArt {
  sheet: string;                       // 图片路径
  frame: [number, number];             // 每格的宽、高（像素）
  anchor: [number, number];            // 格子里脚底中心的位置（像素）
  ppu?: number;                        // 每个世界像素对应几个图片像素，默认 2
  refR?: number;                       // 画的时候按哪个碰撞半径画的；实体半径不同时按比例缩放
  columns?: number;                    // 一行几格（动画用 start 写起始格时需要）
  // 换装：键是 "皮肤|武器"（如 "obsidian|blood_blade"），值是那套外观的图。每张图的格子排法都一样。
  // 没列出的组合用 sheet。用到哪套才加载哪套。
  variants?: Record<string, string>;
  // 飞行道具出手点（模型坐标：相对脚底，x 朝前，y 朝下），键是技能的 fx 名；不写就用程序模型算出来的
  muzzles?: Record<string, [number, number]>;
  anims: Partial<Record<AnimName, AnimDef>>;
}

// 一个动画在图里的位置：row 表示占第几行（从行首开始）；或者用 start 写起始格的序号（从 0 数，按行排），
// 这样短动画可以一个接一个排，不用每个占一整行。
export interface AnimDef { row?: number; start?: number; frames: number; fps?: number }

// 动画名：基础的六个，加上完美格挡 parry、破防 broken，以及技能专属动作 "act:<技能的 fx 名>"。
// 缺哪个都可以：技能动作缺了用 attack，parry 缺了用 block，broken 缺了照常站着。
export type AnimName = 'idle' | 'walk' | 'attack' | 'hit' | 'death' | 'block' | 'parry' | 'broken' | `act:${string}`;

type AnimFrames = Partial<Record<AnimName, Texture[]>>;

// 物件：每个外观变体一张图（或一行动画帧）。
export interface PropArt {
  images: string[];                    // 下标 = 变体 v
  anchor: [number, number];            // 图片里脚底点的位置（像素）
  ppu?: number;
  frames?: number;                     // 动态物件（火盆、营火）：图片横向排着几帧
  fps?: number;
}

// 特效序列帧（命中火花等）：一张图横向排着几帧，每格一样大，帧中心就是命中点，命中方向朝右。
export interface FxArt {
  sheet: string;
  frame: [number, number];             // 每格的宽、高（像素），应该和 render/flipbook.ts 的 FLIP_SIZE 一样（96x96）
  frames: number;
  blend?: 'add' | 'normal';            // 发光的火星用 add，碎屑、血用 normal（默认）
}

export interface Manifest {
  characters?: Record<string, CharacterArt>;
  props?: Record<string, PropArt>;
  ground?: string;                     // 整张地图的地表图（和地图一样大，ppu 1）
  lut?: string;                        // 调色 LUT（1024x32）
  fx?: Record<string, FxArt>;          // 键名如 hit.metal、hit.flesh
}

// 加载好的角色：每个动画一组贴图。
export interface LoadedCharacter {
  def: CharacterArt;
  anims: AnimFrames;
  variants: Map<string, AnimFrames | null>;   // 已经加载（或正在加载，值为 null）的换装
}

/**
 * characterFrames 返回角色某套外观（皮肤 + 武器）的动画贴图。那套图还没加载好时先用默认的，
 * 加载完下一帧自动换上。
 */
export function characterFrames(character: LoadedCharacter, skin?: string, gear?: string): AnimFrames {
  const variants = character.def.variants;
  if (!variants) return character.anims;
  const path = variants[`${skin || ''}|${gear || ''}`];
  if (!path || path === character.def.sheet) return character.anims;
  const loaded = character.variants.get(path);
  if (loaded) return loaded;
  if (loaded === undefined) {
    character.variants.set(path, null);
    Assets.load<Texture>(BASE + path)
      .then((texture) => character.variants.set(path, sliceSheet(texture, character.def)))
      .catch((err) => console.error(`美术资源 ${path} 加载失败`, err));
  }
  return character.anims;
}

export interface LoadedProp {
  def: PropArt;
  variants: Texture[][];               // [变体][帧]
}

export const art = {
  characters: new Map<string, LoadedCharacter>(),
  props: new Map<string, LoadedProp>(),
  ground: null as Texture | null,
  lut: null as Texture | null,
  fx: new Map<string, Flipbook>(),     // 特效是画在 2D 画布上的，所以存成切好的小画布，不是 Pixi 贴图
};

const BASE = 'art/';

// loadArt 在启动时调用一次。没有清单就什么都不做；某张图坏了只跳过那一项并报错，不影响别的。
export async function loadArt(): Promise<void> {
  let m: Manifest;
  try {
    const res = await fetch(BASE + 'manifest.json', { cache: 'no-cache' });
    if (!res.ok) return;
    m = await res.json();
    if (!m || typeof m !== 'object') return;
  } catch {
    return;
  }
  const tex = (path: string) => Assets.load<Texture>(BASE + path);
  const jobs: Promise<void>[] = [];
  const pair = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number');
  for (const [name, def] of Object.entries(m.characters || {})) {
    if (!def || typeof def.sheet !== 'string' || !pair(def.frame) || !pair(def.anchor) || !def.anims) {
      console.error(`美术资源 ${name}：清单缺少 sheet、frame、anchor 或 anims，已跳过`);
      continue;
    }
    jobs.push(tex(def.sheet).then((t) => {
      art.characters.set(name, { def, anims: sliceSheet(t, def), variants: new Map() });
      for (const [action, point] of Object.entries(def.muzzles || {})) {
        if (pair(point)) MUZZLE_OVERRIDE[action] = { x: point[0], y: point[1] };
      }
    }).catch((err) => console.error(`美术资源 ${name} 加载失败`, err)));
  }
  for (const [kind, def] of Object.entries(m.props || {})) {
    if (!def || !Array.isArray(def.images) || !def.images.length || !pair(def.anchor)) {
      console.error(`美术资源 ${kind}：清单缺少 images 或 anchor，已跳过`);
      continue;
    }
    jobs.push(Promise.all(def.images.map(tex)).then((ts) => {
      art.props.set(kind, { def, variants: ts.map((t) => sliceStrip(t, def.frames || 1)) });
    }).catch((err) => console.error(`美术资源 ${kind} 加载失败`, err)));
  }
  if (m.ground) jobs.push(tex(m.ground).then((t) => { art.ground = t; }).catch((err) => console.error('地表图加载失败', err)));
  if (m.lut) jobs.push(tex(m.lut).then((t) => { art.lut = t; }).catch((err) => console.error('LUT 加载失败', err)));
  for (const [name, def] of Object.entries(m.fx || {})) {
    if (!def || typeof def.sheet !== 'string' || !pair(def.frame) || !Number.isInteger(def.frames) || def.frames < 1) {
      console.error(`特效 ${name}：清单缺少 sheet、frame 或 frames，已跳过`);
      continue;
    }
    jobs.push(loadImage(BASE + def.sheet).then((img) => {
      art.fx.set(name, { frames: sliceImage(img, def), blend: def.blend === 'add' ? 'add' : 'normal' });
    }).catch((err) => console.error(`特效 ${name} 加载失败`, err)));
  }
  await Promise.all(jobs);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(src));
    img.src = src;
  });
}

// sliceImage 把横排的序列帧切成一格一个小画布。
function sliceImage(img: HTMLImageElement, def: FxArt): HTMLCanvasElement[] {
  const [frameWidth, frameHeight] = def.frame;
  return Array.from({ length: def.frames }, (_, i) => {
    const canvas = document.createElement('canvas');
    canvas.width = frameWidth;
    canvas.height = frameHeight;
    canvas.getContext('2d')!.drawImage(img, i * frameWidth, 0, frameWidth, frameHeight, 0, 0, frameWidth, frameHeight);
    return canvas;
  });
}

function sliceSheet(t: Texture, def: CharacterArt): AnimFrames {
  const [fw, fh] = def.frame;
  const columns = def.columns || Math.max(1, Math.floor(t.width / fw));
  const out: AnimFrames = {};
  for (const [name, a] of Object.entries(def.anims) as [AnimName, AnimDef][]) {
    const frames: Texture[] = [];
    const first = a.start ?? (a.row || 0) * columns;
    for (let i = 0; i < a.frames; i++) {
      const cell = first + i;
      frames.push(new Texture({ source: t.source, frame: new Rectangle((cell % columns) * fw, Math.floor(cell / columns) * fh, fw, fh) }));
    }
    out[name] = frames;
  }
  return out;
}

function sliceStrip(t: Texture, n: number): Texture[] {
  if (n <= 1) return [t];
  const w = Math.floor(t.width / n);
  return Array.from({ length: n }, (_, i) => new Texture({ source: t.source, frame: new Rectangle(i * w, 0, w, t.height) }));
}
