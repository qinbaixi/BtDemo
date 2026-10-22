// 客户端的全部本地状态，以及实体相关的小工具函数。
// 服务端是权威：这里只保存最近一次同步的结果，加上插值和动画需要的数据。

import type { Aura, FX } from '../render/fx';
import type { createScenery } from '../render/scenery';
import type {
  EntityInfo, EntityKind, Obstacle, SelfInfo, SkillInfo,
} from '../net/types';
import { KIND_COLOR, LERP_MS, MODEL_H, MODEL_SCALE } from './config';
import { clamp, lerp } from './math';

export type Scenery = ReturnType<typeof createScenery>;

export interface Point { x: number; y: number }

// 客户端里的一个实体：服务端同步来的字段 + 插值和动画状态。
export interface ClientEntity {
  id: number;
  kind: EntityKind;
  name: string;
  color: string;
  r: number;
  lv: number;
  x: number;          // 最近一次同步的位置
  y: number;
  px: number;         // 本次插值的起点
  py: number;
  t0: number;         // 本次插值开始的时间
  hp: number;
  maxHp: number;
  act: string;        // 行为树当前动作名
  tg: number;         // 当前目标 id
  dead: boolean;
  shield: number;     // 护盾还能吸收的伤害
  shieldMax: number;  // 这层护盾刚加上时的量，用来算剩余比例
  blocking: boolean;  // 正在格挡
  model: string;
  // 动画状态
  facing: number;     // 0 朝右，PI 朝左
  walk: number;       // 走路循环的相位
  moveUntil: number;  // 在此时间之前显示走路姿势
  rx: number;         // 上一帧画出来的位置，用来推进走路循环
  ry: number;
  attackAt: number;
  hitAt: number;
  deadAt: number;
  // 打击感
  freezeUntil: number; // 顿帧：此时间之前动作停住
  knockX: number;     // 最近一次被打的方向（单位向量，从攻击者指向自己）
  knockY: number;
  knockAmp: number;   // 这次受击被推开的距离（像素），暴击更远
  fresh: boolean;     // 还没收到过同步：一进视野就是死的，直接显示倒地
}

export interface FloatText {
  anchor: number;
  x: number; y: number;
  oy: number; jx: number;
  text: string; color: string; size: number; life: number;
  born: number; rise: number; pop: boolean;
  drift: number;      // 横向飘出的距离（伤害数字往攻击方向的反方向抛出去）
  crit: boolean;      // 暴击样式：金色渐变、粗描边、弹出时抖动
}

export interface FloatOpts { rise?: number; pop?: boolean; drift?: number; crit?: boolean }

export interface State {
  myId: number;
  moveDx: number;     // 自己当前按住的左右方向（-1、0、1），朝向以它为准
  blockHeld: boolean; // 自己正按住右键格挡：朝向锁定，不跟着按键转
  map: { w: number; h: number };
  cell: number;
  skills: SkillInfo[];
  skillBySlot: Record<number, SkillInfo>;
  ents: Map<number, ClientEntity>;
  self: SelfInfo | null;          // 最近一次同步里的 self
  selfAt: number;                 // 收到那次同步的 performance.now()
  cds: Record<string, number>;    // 技能 id -> cdsAt 时刻剩余的冷却秒数
  cdsAt: number;
  target: number;
  hoverSlot: number;
  showAOI: boolean;
  fx: FX | null;
  scenery: Scenery | null;        // 地表和物件，收到 welcome 后按 /map.tmj 生成
  sceneKey: string;
  obstacles: Obstacle[];
  aiPath: { id: number; pts: number[]; at: number } | null;
  vignette: { w: number; h: number; g: CanvasGradient } | null;
  lands: Map<number, { at: number; color?: string }>;   // 施法者 id -> 最近一次施法命中的时间和颜色
  pending: { at: number; fn: () => void }[];             // 等弹道飞到再播的受击
  lastFrame: number;
  // 完整画质：描边、轮廓光和动态光照。URL 带 ?low 时一开始就关掉，
  // Q 键切换，机器太慢时也会自动关掉。
  hq: boolean;
  post: boolean;                  // 高画质下是否开后期处理（泛光、调色）；URL 带 ?nopost 时关掉，B 键切换
  slowFrames: number;
  slowGraceUntil: number;         // 手动按 Q 之后，到这个时间前不评判帧率
  floats: FloatText[];
  bubbles: Map<number, { text: string; until: number }>;
  cam: { x: number; y: number; w: number; h: number };
  camShake: Point;                // 这一帧镜头冲击和震动的偏移（camera.ts）
  camZoom: number;                // 这一帧的缩放冲击（1 = 不缩放）
  combo: { n: number; at: number };   // 自己的连击数和最近一次命中的时间
  hurtAt: number;                 // 自己最近一次掉血的时间（屏幕边缘闪红）
  dpr: number;
}

export const state: State = {
  myId: 0,
  moveDx: 0,
  blockHeld: false,
  map: { w: 2400, h: 1600 },
  cell: 320,
  skills: [],
  skillBySlot: {},
  ents: new Map(),
  self: null,
  selfAt: 0,
  cds: {},
  cdsAt: 0,
  target: 0,
  hoverSlot: 0,
  showAOI: false,
  fx: null,
  scenery: null,
  sceneKey: '',
  obstacles: [],
  aiPath: null,
  vignette: null,
  lands: new Map(),
  pending: [],
  lastFrame: 0,
  hq: !new URLSearchParams(location.search).has('low'),
  post: !new URLSearchParams(location.search).has('nopost'),
  slowFrames: 0,
  slowGraceUntil: 0,
  floats: [],
  bubbles: new Map(),
  cam: { x: 0, y: 0, w: 0, h: 0 },
  camShake: { x: 0, y: 0 },
  camZoom: 1,
  combo: { n: 0, at: -1e9 },
  hurtAt: -1e9,
  dpr: 1,
};

export function makeEntity(d: Partial<EntityInfo> & { id: number }, now: number): ClientEntity {
  const kind = d.kind || 'monster';
  return {
    id: d.id,
    kind,
    name: d.name || '?',
    color: d.color || KIND_COLOR[kind] || '#cccccc',
    r: d.r || 14,
    lv: d.lv || 1,
    x: d.x || 0,
    y: d.y || 0,
    px: d.x || 0,
    py: d.y || 0,
    t0: now,
    hp: d.hp || 0,
    maxHp: d.maxHp || 0,
    act: '',
    tg: 0,
    dead: false,
    shield: 0,
    shieldMax: 0,
    blocking: false,
    model: d.model || '',
    facing: kind === 'player' ? 0 : (Math.random() < 0.5 ? 0 : Math.PI),
    walk: Math.random() * 6,
    moveUntil: 0,
    rx: d.x || 0,
    ry: d.y || 0,
    attackAt: -1e9,
    hitAt: -1e9,
    deadAt: -1,
    freezeUntil: 0,
    knockX: 0,
    knockY: 0,
    knockAmp: 0,
    fresh: true,
  };
}

// posOf 是实体的绘制位置：从上一个位置插值到最近一次同步的位置。
export function posOf(e: ClientEntity, now: number): Point {
  const k = clamp((now - e.t0) / LERP_MS, 0, 1);
  return { x: lerp(e.px, e.x, k), y: lerp(e.py, e.y, k) };
}

// headY 是实体头顶上方的 y 坐标。
export function headY(e: ClientEntity, p: Point): number {
  const s = ((e.r || 14) * MODEL_SCALE) / 16;
  return p.y - (MODEL_H[e.model] || 34) * s;
}

// faceToward 让实体左右转向某个点。
export function faceToward(e: ClientEntity, x: number, y: number, now: number): void {
  const p = posOf(e, now);
  if (Math.abs(x - p.x) > 2) e.facing = x < p.x ? Math.PI : 0;
}

// fxResolve 让特效跟着活着的实体走（身体中心）。
export function fxResolve(id: number): { x: number; y: number; r: number; facing: number; h: number } | null {
  const e = state.ents.get(id);
  if (!e) return null;
  const p = posOf(e, performance.now());
  return { x: p.x, y: p.y, r: e.r || 14, facing: e.facing, h: p.y - headY(e, p) };
}

// fxAuras 列出身上带护盾、要画护盾泡泡的实体。
export function fxAuras(): Aura[] {
  const out: Aura[] = [];
  const now = performance.now();
  for (const e of state.ents.values()) {
    if (e.dead || e.shield <= 0) continue;
    const p = posOf(e, now);
    out.push({ id: e.id, x: p.x, y: p.y, r: e.r || 14, h: p.y - headY(e, p), frac: e.shieldMax > 0 ? e.shield / e.shieldMax : 1 });
  }
  return out;
}

export function cdRemaining(skillId: string, now: number): number {
  return Math.max(0, (state.cds[skillId] || 0) - (now - state.cdsAt) / 1000);
}
