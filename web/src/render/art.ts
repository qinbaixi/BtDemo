// 美术资源：读 /art/manifest.json，把美术画的图接进画面。
//
// 规则很简单：清单里有的就用图，没有的继续用程序画（models.ts、scenery.ts）。
// 所以美术可以一个一个地替换，不用一次全部做完。格式和要求见 docs/art-spec.md。
//
// 图片放在 web/public/art/ 下，构建时原样复制、嵌进服务端；路径都相对 art/ 目录。

import { Assets, Rectangle, Texture } from 'pixi.js';

// 角色动画：一张图一行一个动画，每格一样大。
export interface CharacterArt {
  sheet: string;                       // 图片路径
  frame: [number, number];             // 每格的宽、高（像素）
  anchor: [number, number];            // 格子里脚底中心的位置（像素）
  ppu?: number;                        // 每个世界像素对应几个图片像素，默认 2
  refR?: number;                       // 画的时候按哪个碰撞半径画的；实体半径不同时按比例缩放
  anims: Partial<Record<AnimName, { row: number; frames: number; fps?: number }>>;
}

export type AnimName = 'idle' | 'walk' | 'attack' | 'hit' | 'death' | 'block';

// 物件：每个外观变体一张图（或一行动画帧）。
export interface PropArt {
  images: string[];                    // 下标 = 变体 v
  anchor: [number, number];            // 图片里脚底点的位置（像素）
  ppu?: number;
  frames?: number;                     // 动态物件（火盆、营火）：图片横向排着几帧
  fps?: number;
}

export interface Manifest {
  characters?: Record<string, CharacterArt>;
  props?: Record<string, PropArt>;
  ground?: string;                     // 整张地图的地表图（和地图一样大，ppu 1）
  lut?: string;                        // 调色 LUT（1024x32）
}

// 加载好的角色：每个动画一组贴图。
export interface LoadedCharacter {
  def: CharacterArt;
  anims: Partial<Record<AnimName, Texture[]>>;
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
      art.characters.set(name, { def, anims: sliceSheet(t, def) });
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
  await Promise.all(jobs);
}

function sliceSheet(t: Texture, def: CharacterArt): Partial<Record<AnimName, Texture[]>> {
  const [fw, fh] = def.frame;
  const out: Partial<Record<AnimName, Texture[]>> = {};
  for (const [name, a] of Object.entries(def.anims) as [AnimName, { row: number; frames: number }][]) {
    const frames: Texture[] = [];
    for (let i = 0; i < a.frames; i++) {
      frames.push(new Texture({ source: t.source, frame: new Rectangle(i * fw, a.row * fh, fw, fh) }));
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
