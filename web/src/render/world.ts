// 画世界：Pixi（WebGL）负责地表、物件、角色、光照、特效，叠加层（overlay.ts）负责文字和调试线条。
//
// 显示层次（从下到上）：
//   scene        整个画面，高画质时加后期处理（扭曲 + 泛光 + 区域调色，见 pixi/postFilter.ts）
//     world      跟随镜头：地表 → 地面标记（AOI、射程、目标圈）→ 地面特效 → 角色和物件（按脚底 y 排序）
//     darkness   光照的暗色层（屏幕空间）
//     glow       光源的彩色叠加（跟随镜头）
//     fx         技能特效和环境粒子：刀光和尾迹是 GPU 丝带（pixi/trail.ts），粒子和光晕是 GPU 精灵
//                （pixi/spriteCtx.ts），护盾泡泡等有形状的特效画在只覆盖特效范围的小画布上
//   overlay      另一块 2D 画布：头顶文字、调试线条、暗角（不参与泛光和调色，保持清晰）

import { Application, Container, Graphics, RenderLayer, type TextureSource } from 'pixi.js';
import { ATTACK_MS, DEATH_MS, FEEL, HIT_MS, LOOK_FROST, LOOK_HOLY, MODEL_SCALE, RIM } from '../game/config';
import { clamp, hypot } from '../game/math';
import { headY, posOf, state, type ClientEntity, type Point, type Quality, type Scenery } from '../game/state';
import { art } from './art';
import type { LookEnt } from './fx';
import { makeGrade, makeLut, ZONE_GRADES } from './grade';
import { createLighting, type Lighting } from './lighting';
import { drawOverlay, initOverlay, resizeOverlay } from './overlay';
import { ActorView, type Pose } from './pixi/actorView';
import { CanvasSprite } from './pixi/canvasSprite';
import { PostFilter, type Distort } from './pixi/postFilter';
import { SceneView, type Mover } from './pixi/sceneView';
import { SpriteCtx } from './pixi/spriteCtx';
import { RibbonPool } from './pixi/trail';

let app: Application;
let scene: Container;          // 整个画面（后期处理加在这一层）
let zoomer: Container;         // 缩放冲击（暴击时画面放大一下）加在这一层，后期处理不跟着缩放
let post: PostFilter;
let world: Container;          // 跟随镜头的世界层
let glowWorld: Container;      // 光照彩色层，和 world 用同一个镜头变换
let fxWorld: Container;        // 技能特效和环境粒子，同样跟随镜头
let shapeFx: CanvasSprite;      // 有形状的技能特效（刀光、弹道……），只画在特效所在的小范围里
let sparkFx: SpriteCtx;        // 粒子、光晕、环境粒子：GPU 精灵
let trails: RibbonPool;        // 刀光、风刃、弹道尾迹：GPU 丝带
let groundLayer: Container;
let marks: Graphics;           // 地面标记
let targetRing: Container;     // 目标脚下的旋转圈
let targetRingArcs: Graphics;
let underFx: CanvasSprite;     // 地面特效（暂时用 Canvas 2D 画）
let depth: Container;          // 角色和物件，按 zIndex（脚底 y）排序
let xrayLayer: RenderLayer;    // 角色剪影：被高物件挡住时画在所有物件上面
let lighting: Lighting;
let sceneView: SceneView | null = null;
let sceneFor: Scenery | null = null;
let sceneRes = 0;               // 场景按这个像素密度画的，变了要重建
const actors = new Map<number, ActorView>();
let baseLut: TextureSource;
const zoneLuts = new Map<string, TextureSource>();     // 区域种类 -> LUT，第一次用到时生成
const zoneWeights = new Map<string, number>();         // 平滑过的各区域权重

// 后期处理参数：泛光强度、发光阈值（亮度 0..1）、调色强度
const POST = { bloom: 0.8, threshold: 0.68, grade: 1 };

// initWorld 创建 Pixi 应用（异步：要等 WebGL 初始化完）。
export async function initWorld(canvas: HTMLCanvasElement, overlay: HTMLCanvasElement): Promise<void> {
  state.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR[state.quality]);
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
  xrayLayer = new RenderLayer();
  world.addChild(groundLayer, marks, targetRing, underFx, depth);

  const darkness = new Container();
  glowWorld = new Container();
  fxWorld = new Container();
  shapeFx = new CanvasSprite();
  const sparkLayer = new Container();
  sparkFx = new SpriteCtx(sparkLayer);
  // 墨色衬底和发光丝带分两层：墨色总在下面，不会压暗别的特效的光
  const inkLayer = new Container();
  const trailLayer = new Container();
  trails = new RibbonPool(inkLayer, trailLayer);
  fxWorld.addChild(inkLayer, trailLayer, shapeFx, sparkLayer);
  scene = new Container();
  zoomer = new Container();
  // 剪影层放在暗部遮罩上面：夜里没光的地方剪影也要看得清（挂上去的精灵仍然用世界坐标）
  zoomer.addChild(world, darkness, xrayLayer, glowWorld, fxWorld);
  scene.addChild(zoomer);
  scene.filterArea = app.screen;   // 后期处理整屏做，不用每帧算整个世界的包围盒
  app.stage.addChild(scene);
  lighting = createLighting(app.renderer, darkness, glowWorld);
  baseLut = art.lut?.source ?? makeLut();   // 美术给了 LUT 就用美术的，各区域都用它
  post = new PostFilter(baseLut, POST);

  initOverlay(overlay);
  resize();
}

// setPostOptions 调整后期处理参数（?fxlab 实验页用）。
export function setPostOptions(opts: Partial<typeof POST>): void {
  Object.assign(POST, opts);
  post?.set(opts);
}

// 各档画质的像素密度上限：高清屏上中、低档少画一些像素，后期处理的开销跟着降
const MAX_DPR: Record<Quality, number> = { high: 2, medium: 1.5, low: 1.5 };
let appliedQuality: Quality | null = null;

// applyQuality 把画质档位落实到渲染上：像素密度、泛光级数、粒子密度。画质变了才调用。
function applyQuality(): void {
  appliedQuality = state.quality;
  const medium = state.quality === 'medium';
  post.setLevels(medium ? 2 : 4);
  state.fx.density = medium ? 0.5 : 1;
  resize();
}

// resize 让画布跟窗口和设备像素比一致。
export function resize(): void {
  state.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR[state.quality]);
  if (!app) return;
  app.renderer.resolution = state.dpr;
  app.renderer.resize(window.innerWidth, window.innerHeight);
  resizeOverlay(state.dpr);
}

// drawWorld 画一帧。debugOpen 时额外画被观察实体的 AI 路径。
export function drawWorld(now: number, dt: number, debugOpen: boolean): void {
  if (state.quality !== appliedQuality) applyQuality();
  const view = state.cam;
  const shake = state.camShake;
  for (const c of [world, glowWorld, fxWorld]) c.position.set(-view.x + shake.x, -view.y + shake.y);
  // 缩放冲击以屏幕中心为原点
  const zoom = state.camZoom;
  zoomer.scale.set(zoom);
  zoomer.position.set((view.w / 2) * (1 - zoom), (view.h / 2) * (1 - zoom));

  const me = state.ents.get(state.myId);
  const mp = me ? posOf(me, now) : null;

  // 地图换了（新的 welcome）或像素密度变了（换显示器、缩放）就重建场景
  if (state.scenery !== sceneFor || state.dpr !== sceneRes) {
    sceneView?.destroy();
    sceneView = state.scenery ? new SceneView(state.scenery, groundLayer, depth, state.dpr) : null;
    sceneFor = state.scenery;
    // 换了地图：区域调色从新地图的位置重新算，并先把各区域的 LUT 生成好，免得第一次走进去时卡一下
    zoneWeights.clear();
    if (state.scenery && !art.lut) for (const kind of Object.keys(ZONE_GRADES)) zoneLut(kind);
    sceneRes = state.dpr;
  }
  // 正在走动的角色：会碰得灌木和树晃一下
  const movers: Mover[] = [];
  for (const e of state.ents.values()) {
    if (now < e.moveUntil && !e.dead) movers.push(posOf(e, now));
  }
  const occluded = sceneView?.update(view, now, dt, mp, movers) ?? false;

  drawMarks(mp, now);
  drawUnderFx(now);
  // 先收集光源：角色要知道附近最亮的光在哪
  updateLights(now, mp, shake);

  // 角色：每个实体一个 ActorView，实体被移除（离开 AOI）后销毁
  const ents: { e: ClientEntity; p: Point }[] = [];
  const lookEnts: LookEnt[] = [];
  for (const e of state.ents.values()) {
    const p = posOf(e, now);
    ents.push({ e, p });
    let v = actors.get(e.id);
    if (!v) {
      v = new ActorView(e.model, RIM[e.kind], depth, xrayLayer);
      actors.set(e.id, v);
    }
    const pose = poseOf(e, p, now, dt);
    if (e.looks && !e.dead) {
      lookEnts.push({
        id: e.id, x: p.x, y: p.y, r: e.r || 14, h: p.y - headY(e, p), looks: e.looks,
        moving: now < e.moveUntil, dir: Math.cos(e.facing) < 0 ? -1 : 1,
      });
    }
    pose.onScreen = p.x > view.x - 150 && p.x < view.x + view.w + 150 && p.y > view.y - 200 && p.y < view.y + view.h + 150;
    pose.xray = occluded && e.id === state.myId;
    if (state.hq && !e.dead) pose.light = lighting.dominant(p.x, p.y - 20);
    // 开始溶解时冒出一阵灰烬
    if ((pose.dissolve ?? -1) >= 0 && !v.dissolving) state.fx.ashes(e.id, pose.burn!, now);
    v.dissolving = (pose.dissolve ?? -1) >= 0;
    // 尸体是躺平的，排在站在它上面的东西后面
    v.update(pose, p.y - (e.dead ? 30 : 0), state.dpr, state.hq, now);
  }
  for (const [id, v] of actors) {
    if (!state.ents.has(id)) { v.destroy(); actors.delete(id); }
  }
  state.fx.looks(lookEnts, now);

  // 开后期处理时特效画进 Pixi 才能发光；不开时直接画在叠加层上，省掉每帧整屏上传纹理
  const usePost = state.hq && state.post;
  if (usePost !== (scene.filters?.[0] === post)) scene.filters = usePost ? [post] : null;
  if (usePost) updatePost(now, dt, mp, shake, zoom);
  drawOverFx(now, dt);
  app.renderer.render(app.stage);
  drawOverlay(now, shake, zoom, mp, ents, debugOpen);
}

// 溶解边缘的火光：怪物是暗红的余烬，NPC 是幽蓝的魂火
const BURN: Record<string, string> = { monster: '#ff5a1e', npc: '#5fd8ff', player: '#ffcf6a' };

// poseOf 推进走路循环、顿帧和受击形变，并算出这一帧的模型姿势。
function poseOf(e: ClientEntity, p: Point, now: number, dt: number): Pose {
  // 顿帧：动作进度停住（把动作开始的时间往后推），走路也不迈步；位置照常插值
  const frozen = now < e.freezeUntil;
  if (frozen) {
    if (now - e.attackAt < ATTACK_MS) e.attackAt += dt;
    if (now - e.hitAt < HIT_MS) e.hitAt += dt;
    if (e.deadAt >= 0 && now - e.deadAt < DEATH_MS) e.deadAt += dt;
  }
  // 走路循环按这一帧实际画出来的移动距离推进
  const moved = hypot(e.rx, e.ry, p.x, p.y);
  // 往背对的方向走（举盾倒退）时腿反着迈，不然看起来像在原地滑步
  const stepX = p.x - e.rx;
  const back = stepX * Math.cos(e.facing) < -0.05;
  e.rx = p.x;
  e.ry = p.y;
  const stepBefore = Math.floor(e.walk / Math.PI);
  if (moved < 40 && !frozen) e.walk += (back ? -1 : 1) * moved * 0.16 * (16 / (e.r || 14));
  // 每迈一步（走路相位过半圈）脚下扬一小团土
  if (Math.floor(e.walk / Math.PI) !== stepBefore && now < e.moveUntil && !e.dead && e.kind !== 'npc') {
    // 土往移动的反方向扬（倒退时也对）
    state.fx.footDust(p.x, p.y, stepX < 0 ? -1 : 1, now);
  }
  // 转身：朝向一变，身体横向收窄一下再展开
  if (Math.cos(e.facing) * Math.cos(e.shownFacing) < 0) e.turnAt = now;
  e.shownFacing = e.facing;
  const turnT = (now - e.turnAt) / 140;
  const turn = turnT >= 0 && turnT < 1 ? Math.sin(turnT * Math.PI) : 0;
  const atk = (now - e.attackAt) / ATTACK_MS;
  const hit = (now - e.hitAt) / HIT_MS;
  const hitting = hit >= 0 && hit < 1;
  const dead = e.dead ? clamp((now - (e.deadAt < 0 ? now - DEATH_MS : e.deadAt)) / DEATH_MS, 0, 1) : -1;

  // 受击：先被推开再慢慢回来；倒地时被打飞的那段距离保留到复活
  let knock = 0;
  if (dead >= 0) knock = e.knockAmp * (1 - (1 - dead) * (1 - dead));
  else if (hitting) knock = e.knockAmp * (hit < 0.18 ? 1 - Math.pow(1 - hit / 0.18, 2) : 1 - smooth((hit - 0.18) / 0.82));
  // 形变：一下压扁再弹两下回原样
  const squash = hitting && dead < 0 ? FEEL.squash * Math.exp(-hit * 5) * Math.cos(hit * Math.PI * 3) : 0;

  // 溶解：怪物和 NPC 倒地一会儿后烧掉（玩家的尸体留着等复活）
  let dissolve = -1;
  if (dead >= 1 && e.kind !== 'player' && e.deadAt >= 0) {
    const t = (now - e.deadAt - DEATH_MS - FEEL.dissolveDelayMs) / Math.max(1, FEEL.dissolveMs);
    if (t >= 0) dissolve = Math.min(1, t);
  }

  return {
    x: p.x,
    y: p.y,
    r: (e.r || 14) * MODEL_SCALE,
    color: e.color,
    facing: e.facing,
    walk: e.walk,
    moving: now < e.moveUntil && !e.dead,
    attack: atk >= 0 && atk < 1 && !e.dead ? atk : -1,
    hit: hitting ? hit : -1,
    dead,
    time: now + e.id * 397,
    isSelf: e.id === state.myId,
    blocking: e.blocking && !e.dead,
    tint: e.dead ? 0xffffff : e.looks & LOOK_FROST ? 0xa8dcff : e.looks & LOOK_HOLY ? 0xfff0c4 : 0xffffff,
    ghost: blinkGhost(e, p, now),
    knockX: e.knockX * knock,
    knockY: e.knockY * knock * 0.6,
    squash,
    dissolve,
    turn,
    // 待机时轻微呼吸（每个角色相位不同）
    breath: dead < 0 && !(now < e.moveUntil) && !(atk >= 0 && atk < 1) ? 0.012 * Math.sin((now + e.id * 397) / 520) : 0,
    burn: BURN[e.kind],
  };
}

const smooth = (x: number) => x * x * (3 - 2 * x);

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

// drawOverFx 画角色上方的特效：刀光和尾迹用 GPU 丝带，粒子、光晕和环境粒子（雾、火星、光点）用 GPU 精灵，
// 其余有形状的特效（护盾泡泡、格挡弧光……）画进一块只覆盖特效范围的画布。
function drawOverFx(now: number, dt: number): void {
  const fx = state.fx;
  fx.step(now);
  let box = fx.shapeBounds(now);
  if (box) {
    const v = state.cam;
    box = [Math.max(box[0], v.x - 40), Math.max(box[1], v.y - 40), Math.min(box[2], v.x + v.w + 40), Math.min(box[3], v.y + v.h + 40)];
    if (box[2] <= box[0] || box[3] <= box[1]) box = null;
  }
  shapeFx.visible = !!box;
  if (box) shapeFx.paint(box, state.dpr, (g) => fx.drawShapes(g, now));
  sparkFx.begin();
  trails.begin();
  fx.drawTrails(trails, sparkFx, now);
  trails.end();
  fx.particles(sparkFx, now, dt);
  if (state.scenery) state.scenery.drawAmbient(sparkFx, state.cam, now);
  sparkFx.end();
}

// updatePost 每帧更新后期处理：区域调色的混合比例，冲击波和热浪的屏幕位置。
function updatePost(now: number, dt: number, mp: Point | null, shake: Point, zoom: number): void {
  const view = state.cam;
  // 世界坐标 → 屏幕坐标（和 zoomer 的变换一致）
  const toScreen = (x: number, y: number) => ({
    x: (view.w / 2) * (1 - zoom) + (x - view.x + shake.x) * zoom,
    y: (view.h / 2) * (1 - zoom) + (y - view.y + shake.y) * zoom,
  });
  // 中画质不做扭曲：热浪和冲击波都要整屏多采样，省下来
  const distort = state.quality === 'high';
  const waves: Distort[] = [];
  if (distort) state.fx.waves((x: number, y: number, radius: number, strength: number) => {
    const p = toScreen(x, y);
    waves.push({ x: p.x, y: p.y, radius: radius * zoom, strength: strength * FEEL.distort });
  }, now);
  const heat: Distort[] = [];
  if (distort) state.scenery?.heat((x: number, y: number, radius: number, strength: number) => {
    const p = toScreen(x, y);
    heat.push({ x: p.x, y: p.y, radius: radius * zoom, strength: strength * FEEL.distort });
  }, view);
  post.setDistortion(waves, heat, now / 1000);

  // 区域调色：离各区域中心越近权重越大，权重慢慢跟过去；取最大的两个混合
  const zones = state.scenery?.zones;
  if (!zones || !mp || art.lut) {
    post.setLuts(baseLut, baseLut, 0);
    return;
  }
  const ease = 1 - Math.exp(-Math.min(dt, 100) / 700);
  for (const kind of Object.keys(ZONE_GRADES)) {
    let target = 0;
    for (const c of zones[kind] || []) {
      const d = Math.hypot(c.x - mp.x, c.y - mp.y);
      target += Math.exp(-(d * d) / (2 * 420 * 420));
    }
    const old = zoneWeights.get(kind) ?? target;
    zoneWeights.set(kind, old + (target - old) * ease);
  }
  // 默认调色也算一个“区域”：离所有区域都远时用它，走进某个区域时它的权重降到 0（区域调色能到 100%）。
  // 取权重最大的两个混合
  let strongest = 0;
  for (const weight of zoneWeights.values()) strongest = Math.max(strongest, weight);
  const ranked: [string, number][] = [['', Math.max(0, 0.25 - strongest)], ...zoneWeights.entries()];
  ranked.sort((a, b) => b[1] - a[1]);
  const [firstKind, firstWeight] = ranked[0];
  const [secondKind, secondWeight] = ranked[1];
  post.setLuts(zoneLut(firstKind), zoneLut(secondKind), secondWeight / Math.max(1e-6, firstWeight + secondWeight));
}

// zoneLut 返回区域的 LUT（空字符串是默认调色）。
function zoneLut(kind: string): TextureSource {
  if (!kind) return baseLut;
  let lut = zoneLuts.get(kind);
  if (!lut) {
    lut = makeLut(makeGrade(ZONE_GRADES[kind]));
    zoneLuts.set(kind, lut);
  }
  return lut;
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

const BLINK_GHOST_MS = 380;

// blinkGhost 是闪现残影：起点相对现在位置的偏移和淡出进度，残影放完了就是 undefined。
function blinkGhost(e: ClientEntity, p: Point, now: number): Pose['ghost'] {
  const from = e.blinkFrom;
  if (!from) return undefined;
  const progress = (now - from.at) / BLINK_GHOST_MS;
  if (progress >= 1 || progress < 0) {
    if (progress >= 1) e.blinkFrom = null;
    return undefined;
  }
  return { dx: from.x - p.x, dy: from.y - p.y, k: progress };
}
