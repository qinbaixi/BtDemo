// 画世界：Pixi（WebGL）负责地表、物件、角色、光照，叠加层（overlay.ts）负责特效和文字。
//
// 显示层次（从下到上）：
//   scene        整个画面，高画质时加后期处理（泛光 + 调色，见 pixi/postFilter.ts）
//     world      跟随镜头：地表 → 地面标记（AOI、射程、目标圈）→ 地面特效 → 角色和物件（按脚底 y 排序）
//     darkness   光照的暗色层（屏幕空间）
//     glow       光源的彩色叠加（跟随镜头）
//     fx         技能特效和环境粒子（暂时用 Canvas 2D 画，整屏一张画布；不开后期处理时改画在 overlay 上）
//   overlay      另一块 2D 画布：头顶文字、调试线条、暗角（不参与泛光和调色，保持清晰）

import { Application, Container, Graphics } from 'pixi.js';
import { ATTACK_MS, DEATH_MS, HIT_MS, MODEL_SCALE, RIM } from '../game/config';
import { clamp, hypot } from '../game/math';
import { posOf, state, type ClientEntity, type Point, type Scenery } from '../game/state';
import { art } from './art';
import { makeLut } from './grade';
import { createLighting, type Lighting } from './lighting';
import { drawOverlay, initOverlay, resizeOverlay } from './overlay';
import { ActorView, type Pose } from './pixi/actorView';
import { CanvasSprite } from './pixi/canvasSprite';
import { PostFilter } from './pixi/postFilter';
import { SceneView } from './pixi/sceneView';

let app: Application;
let scene: Container;          // 整个画面（后期处理加在这一层）
let post: PostFilter;
let world: Container;          // 跟随镜头的世界层
let glowWorld: Container;      // 光照彩色层，和 world 用同一个镜头变换
let fxWorld: Container;        // 技能特效和环境粒子，同样跟随镜头
let overFx: CanvasSprite;
let groundLayer: Container;
let marks: Graphics;           // 地面标记
let targetRing: Container;     // 目标脚下的旋转圈
let targetRingArcs: Graphics;
let underFx: CanvasSprite;     // 地面特效（暂时用 Canvas 2D 画）
let depth: Container;          // 角色和物件，按 zIndex（脚底 y）排序
let lighting: Lighting;
let sceneView: SceneView | null = null;
let sceneFor: Scenery | null = null;
let sceneRes = 0;               // 场景按这个像素密度画的，变了要重建
const actors = new Map<number, ActorView>();

// 后期处理参数：泛光强度、发光阈值（亮度 0..1）、调色强度
const POST = { bloom: 0.8, threshold: 0.68, grade: 1 };

// initWorld 创建 Pixi 应用（异步：要等 WebGL 初始化完）。
export async function initWorld(canvas: HTMLCanvasElement, overlay: HTMLCanvasElement): Promise<void> {
  state.dpr = Math.min(window.devicePixelRatio || 1, 2);
  app = new Application();
  await app.init({
    canvas,
    preference: 'webgl',
    width: window.innerWidth,
    height: window.innerHeight,
    resolution: state.dpr,
    autoDensity: false,
    antialias: true,
    background: 0x07050c,
    autoStart: false,
    sharedTicker: false,
  });
  app.ticker.stop();

  world = new Container();
  groundLayer = new Container();
  marks = new Graphics();
  targetRing = new Container();
  targetRing.scale.set(1, 0.42);
  targetRingArcs = new Graphics();
  targetRing.addChild(targetRingArcs);
  underFx = new CanvasSprite();
  underFx.blendMode = 'normal';
  depth = new Container();
  depth.sortableChildren = true;
  world.addChild(groundLayer, marks, targetRing, underFx, depth);

  const darkness = new Container();
  glowWorld = new Container();
  fxWorld = new Container();
  overFx = new CanvasSprite();
  fxWorld.addChild(overFx);
  scene = new Container();
  scene.addChild(world, darkness, glowWorld, fxWorld);
  scene.filterArea = app.screen;   // 后期处理整屏做，不用每帧算整个世界的包围盒
  app.stage.addChild(scene);
  lighting = createLighting(app.renderer, darkness, glowWorld);
  post = new PostFilter(art.lut?.source ?? makeLut(), POST);   // 美术给了 LUT 就用美术的

  initOverlay(overlay);
  resize();
}

// resize 让画布跟窗口和设备像素比一致。
export function resize(): void {
  state.dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (!app) return;
  app.renderer.resolution = state.dpr;
  app.renderer.resize(window.innerWidth, window.innerHeight);
  resizeOverlay(state.dpr);
}

export function updateCamera(now: number): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { w, h } = state.map;
  const me = state.ents.get(state.myId);
  const p = me ? posOf(me, now) : { x: w / 2, y: h / 2 };
  const x = w <= vw ? (w - vw) / 2 : clamp(p.x - vw / 2, 0, w - vw);
  const y = h <= vh ? (h - vh) / 2 : clamp(p.y - vh / 2, 0, h - vh);
  state.cam = { x, y, w: vw, h: vh };
}

// drawWorld 画一帧。debugOpen 时额外画被观察实体的 AI 路径。
export function drawWorld(now: number, dt: number, debugOpen: boolean): void {
  const view = state.cam;
  const shake = state.fx.shakeOffset(dt);
  for (const c of [world, glowWorld, fxWorld]) c.position.set(-view.x + shake.x, -view.y + shake.y);

  const me = state.ents.get(state.myId);
  const mp = me ? posOf(me, now) : null;

  // 地图换了（新的 welcome）或像素密度变了（换显示器、缩放）就重建场景
  if (state.scenery !== sceneFor || state.dpr !== sceneRes) {
    sceneView?.destroy();
    sceneView = state.scenery ? new SceneView(state.scenery, groundLayer, depth, state.dpr) : null;
    sceneFor = state.scenery;
    sceneRes = state.dpr;
  }
  sceneView?.update(view, now, mp);

  drawMarks(mp, now);
  drawUnderFx(now);

  // 角色：每个实体一个 ActorView，实体被移除（离开 AOI）后销毁
  const ents: { e: ClientEntity; p: Point }[] = [];
  for (const e of state.ents.values()) {
    const p = posOf(e, now);
    ents.push({ e, p });
    let v = actors.get(e.id);
    if (!v) {
      v = new ActorView(e.model, RIM[e.kind], depth);
      actors.set(e.id, v);
    }
    // 尸体是躺平的，排在站在它上面的东西后面
    v.update(poseOf(e, p, now), p.y - (e.dead ? 30 : 0), state.dpr, state.hq, now);
  }
  for (const [id, v] of actors) {
    if (!state.ents.has(id)) { v.destroy(); actors.delete(id); }
  }

  updateLights(now, mp, shake);
  // 开后期处理时特效画进 Pixi 才能发光；不开时直接画在叠加层上，省掉每帧整屏上传纹理
  const usePost = state.hq && state.post;
  if (usePost !== (scene.filters?.[0] === post)) scene.filters = usePost ? [post] : null;
  overFx.visible = usePost;
  if (usePost) drawOverFx(now, dt, shake);
  app.renderer.render(app.stage);
  drawOverlay(now, dt, shake, mp, ents, debugOpen, !usePost);
}

// poseOf 推进走路循环，并算出这一帧的模型姿势。
function poseOf(e: ClientEntity, p: Point, now: number): Pose {
  // 走路循环按这一帧实际画出来的移动距离推进
  const moved = hypot(e.rx, e.ry, p.x, p.y);
  e.rx = p.x;
  e.ry = p.y;
  if (moved < 40) e.walk += moved * 0.16 * (16 / (e.r || 14));
  const atk = (now - e.attackAt) / ATTACK_MS;
  const hit = (now - e.hitAt) / HIT_MS;
  return {
    x: p.x,
    y: p.y,
    r: (e.r || 14) * MODEL_SCALE,
    color: e.color,
    facing: e.facing,
    walk: e.walk,
    moving: now < e.moveUntil && !e.dead,
    attack: atk >= 0 && atk < 1 && !e.dead ? atk : -1,
    hit: hit >= 0 && hit < 1 ? hit : -1,
    dead: e.dead ? clamp((now - (e.deadAt < 0 ? now - DEATH_MS : e.deadAt)) / DEATH_MS, 0, 1) : -1,
    time: now + e.id * 397,
    isSelf: e.id === state.myId,
  };
}

// drawMarks 画地面上的标记：AOI 网格（G 键）、地图边界、技能射程预览、目标圈。
function drawMarks(mp: Point | null, now: number): void {
  const g = marks.clear();
  const { w, h } = state.map;
  if (state.showAOI) {
    const c = state.cell;
    for (let x = c; x < w; x += c) g.moveTo(x, 0).lineTo(x, h);
    for (let y = c; y < h; y += c) g.moveTo(0, y).lineTo(w, y);
    g.stroke({ width: 1, color: 0xa0ffc8, alpha: 0.08 });
    if (mp) {
      const gx = Math.floor(mp.x / c);
      const gy = Math.floor(mp.y / c);
      const x0 = clamp((gx - 1) * c, 0, w);
      const y0 = clamp((gy - 1) * c, 0, h);
      const x1 = clamp((gx + 2) * c, 0, w);
      const y1 = clamp((gy + 2) * c, 0, h);
      g.rect(x0, y0, x1 - x0, y1 - y0).fill({ color: 0x78c8ff, alpha: 0.09 });
      dashRect(g, x0, y0, x1, y1, 8, 6);
      g.stroke({ width: 2, color: 0x78c8ff, alpha: 0.6 });
    }
  }
  g.rect(0, 0, w, h).stroke({ width: 3, color: 0xffd54a, alpha: 0.35 });

  // 鼠标悬停技能按钮时，脚下显示射程
  const sk = mp && state.hoverSlot ? state.skillBySlot[state.hoverSlot] : null;
  const R = sk ? (sk.kind === 'aoe' ? (sk.radius || sk.range || 0) : (sk.range || 0)) : 0;
  if (sk && R > 0) {
    g.circle(mp.x, mp.y, R).fill({ color: 0xffffff, alpha: 0.05 });
    dashArc(g, mp.x, mp.y, R, 10, 6);
    g.stroke({ width: 2, color: sk.color || '#ffd166', alpha: 0.85 });
  }

  // 目标脚下：一圈淡色底环加三段旋转的弧
  const tgt = state.ents.get(state.target);
  targetRing.visible = !!tgt;
  if (tgt) {
    const tp = posOf(tgt, now);
    const r = (tgt.r || 14) + 9;
    const color = tgt.kind === 'monster' ? 0xff5a50 : 0x78c8ff;
    targetRing.position.set(tp.x, tp.y);
    const a = targetRingArcs.clear();
    a.rotation = 0;
    a.circle(0, 0, r + 3).stroke({ width: 3 / 1, color, alpha: 0.35 });
    for (let i = 0; i < 3; i++) {
      const s = (i / 3) * Math.PI * 2 + now / 600;
      a.moveTo(Math.cos(s) * r, Math.sin(s) * r).arc(0, 0, r, s, s + 1.3);
    }
    a.stroke({ width: 3, color, alpha: 0.95 });
  }
}

// dashRect / dashArc 画虚线路径（Pixi 的线条没有虚线，按段画）。
function dashRect(g: Graphics, x0: number, y0: number, x1: number, y1: number, on: number, off: number): void {
  const seg = (ax: number, ay: number, bx: number, by: number) => {
    const len = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    for (let d = 0; d < len; d += on + off) {
      const e = Math.min(len, d + on);
      g.moveTo(ax + ux * d, ay + uy * d).lineTo(ax + ux * e, ay + uy * e);
    }
  };
  seg(x0, y0, x1, y0); seg(x1, y0, x1, y1); seg(x1, y1, x0, y1); seg(x0, y1, x0, y0);
}

function dashArc(g: Graphics, x: number, y: number, r: number, on: number, off: number): void {
  const step = (on + off) / r;
  const len = on / r;
  for (let a = 0; a < Math.PI * 2; a += step) {
    g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r).arc(x, y, r, a, Math.min(a + len, Math.PI * 2));
  }
}

// drawUnderFx 把地面特效（旋风斩地裂、治疗法阵、光环……）画到一块只覆盖特效范围的小画布上。
function drawUnderFx(now: number): void {
  let box = state.fx.underBounds(now);
  // 只画镜头里的部分：特效分散在地图两头时画布也不会变大
  if (box) {
    const v = state.cam;
    box = [Math.max(box[0], v.x - 40), Math.max(box[1], v.y - 40), Math.min(box[2], v.x + v.w + 40), Math.min(box[3], v.y + v.h + 40)];
    if (box[2] <= box[0] || box[3] <= box[1]) box = null;
  }
  underFx.visible = !!box;
  if (box) underFx.paint(box, state.dpr, (g) => state.fx.drawUnder(g, now));
}

// drawOverFx 把技能特效和环境粒子画到整屏大小的画布上（世界坐标，覆盖当前镜头）。
function drawOverFx(now: number, dt: number, shake: Point): void {
  const v = state.cam;
  const box = [v.x - shake.x, v.y - shake.y, v.x - shake.x + v.w, v.y - shake.y + v.h];
  overFx.paint(box, state.dpr, (g) => {
    state.fx.drawOver(g, now, dt);
    if (state.scenery) state.scenery.drawAmbient(g, state.cam, now);
  });
}

// updateLights 收集光源：自己身上的光、其他玩家、场景里的火、正在播放的特效。
function updateLights(now: number, mp: Point | null, shake: Point): void {
  const L = lighting;
  L.begin();
  if (state.hq) {
    if (mp) L.add(mp.x, mp.y - 10, 300, '#ffd9a0', 1, 0.18);
    for (const e of state.ents.values()) {
      if (e.id === state.myId || e.dead || e.kind !== 'player') continue;
      const p = posOf(e, now);
      L.add(p.x, p.y - 10, 170, '#ffd9a0', 0.8, 0.1);
    }
    if (state.scenery) state.scenery.lights(L.add, state.cam, now);
    state.fx.lights(L.add, now);
  }
  // 光照跟着世界走，屏幕震动也算进去
  const c = state.cam;
  L.render({ x: c.x - shake.x, y: c.y - shake.y, w: c.w, h: c.h }, state.hq);
}
