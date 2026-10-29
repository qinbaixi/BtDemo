// 客户端的全部本地状态，以及实体相关的小工具函数。
// 服务端是权威：这里只保存最近一次同步的结果，加上插值和动画需要的数据。

import type { Aura, FX } from '../render/fx';
import type { createScenery } from '../render/scenery';
import type {
  ClassInfo,
  EntityInfo, EntityKind, EntityState, ItemInfo, ItemSlotted, Obstacle, PetInfo, SceneInfo, SelfInfo, SkillInfo, SkinInfo, ZoneInfo,
} from '../net/types';
import { ATTACK_MS, KIND_COLOR, LERP_MS, MODEL_H, MODEL_SCALE } from './config';
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
  guard: number;      // 格挡架势剩余比例 0..1（只有玩家有，1 = 满）
  guardAt: number;    // 架势最近一次变化的时间（架势条满了以后过一会儿淡出）
  parryAt: number;    // 最近一次完美格挡的时间（盾往前一顶的动作）
  breakAt: number;    // 最近一次被破防的时间（盾被打开的动作）
  looks: number;      // 身上 Buff 的外观（LOOK_* 位）
  blinkFrom: { x: number; y: number; at: number } | null;   // 最近一次闪现的起点（画残影）
  // 翻滚和被击退：从起点滑到终点（knock 为 true 是击退，途中服务端发来的位置先不管，终点就是服务端的落点）
  slide: { x0: number; y0: number; x1: number; y1: number; at: number; ms: number; knock?: boolean } | null;
  model: string;
  skin: string;       // 玩家外观 id（空 = 职业默认外观）
  gear: string;       // 当前武器的外观（ItemInfo.look，空 = 职业默认武器）
  owner: number;      // 宠物的主人实体 id（非宠物为 0）
  petName: string;    // 宠物自己的名字（名牌上是「主人 的 宠物」，name 是拼好的）
  // 动画状态
  facing: number;     // 0 朝右，PI 朝左
  walk: number;       // 走路循环的相位
  moveUntil: number;  // 在此时间之前显示走路姿势
  rx: number;         // 上一帧画出来的位置，用来推进走路循环
  ry: number;
  attackAt: number;
  action: string;      // 正在做的动作（玩家技能的 fx 名），空串是普通攻击
  attackMs: number;    // 这个动作的时长
  windupFrom: number;  // 怪物前摇开始的时间（0 = 没在前摇）：动作停在举起的那一帧，等命中前一刻再砸下去
  stunUntil: number;   // 硬直到什么时候（受击姿势停住）
  hitAt: number;
  deadAt: number;
  // 打击感
  freezeUntil: number; // 顿帧：此时间之前动作停住
  knockX: number;     // 最近一次被打的方向（单位向量，从攻击者指向自己）
  knockY: number;
  knockAmp: number;   // 这次受击被推开的距离（像素），暴击更远
  squashAmp: number;  // 这次受击压扁的幅度（按命中档位，见 feel/profiles.ts）
  shownFacing: number; // 上一帧画出来的朝向，用来发现转身
  turnAt: number;     // 最近一次转身的时间（转身时身体收窄一下）
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
  skillPool: SkillInfo[];         // 可以挑的技能（welcome 里带的）
  skillPick: number;              // 要挑几个
  classes: ClassInfo[];           // 可选职业（welcome 里带的，第一个是默认）
  playerClass: string;            // 当前职业 id
  canBlock: boolean;              // 当前职业能不能格挡（右键）
  pickerOpen: boolean;            // 选技能面板开着（这时不放技能）
  bagOpen: boolean;               // 装备面板开着（这时也不放技能）
  linesOpen: boolean;             // 线路面板开着
  items: Map<string, ItemInfo>;   // 全部装备种类（welcome 里带的），id -> ItemInfo
  inventory: { items: ItemSlotted[]; capacity: number };   // 自己的背包和身上的装备（服务端 Inventory 整份）
  skins: SkinInfo[];              // 当前职业的外观（从 classes 里取，第一个是默认）
  mySkin: string;                 // 自己现在的外观 id（空 = 默认），以服务端发来的自己的 Enter 为准
  pets: PetInfo[];                // 可以带的宠物（welcome 里带的，第一个是默认）
  scene: SceneInfo | null;        // 所在的场景和线（welcome 里带的），传送门也在里面
  myPet: string;                  // 自己选的宠物 id（空 = 不带），以服务端 PetStatus 为准
  petEntity: number;              // 自己宠物的实体 id（没在视野或没召唤为 0）
  petRespawnAt: number;           // 宠物复活的时间（performance.now()），0 = 没在复活中
  petCooldownUntil: number;       // 换宠物冷却结束的时间（performance.now()），0 = 没有冷却
  ents: Map<number, ClientEntity>;
  self: SelfInfo | null;          // 服务端增量合并后的完整自己信息
  cds: Record<string, number>;    // 技能 id -> 冷却结束的本地时间（performance.now() 毫秒）
  clockSynced: boolean;           // 已经收到过服务端的帧（clockOffset 有效）
  clockOffset: number;            // performance.now() - 服务端时间 × 1000：每收到一帧更新，把服务端时间点换成本地时间
  target: number;
  hoverSlot: number;
  showAOI: boolean;
  fx: FX | null;
  scenery: Scenery | null;        // 地表和物件，收到 welcome 后按所在场景的地图生成
  sceneKey: string;
  obstacles: Obstacle[];
  aiPath: { id: number; pts: number[]; at: number } | null;
  vignette: { w: number; h: number; g: CanvasGradient } | null;
  lands: Map<number, { at: number; color?: string }>;   // 施法者 id -> 最近一次施法命中的时间和颜色
  zones: ClientZone[];            // 地上的回血区（见 render/zones.ts）
  pending: { at: number; fn: () => void }[];             // 等弹道飞到再播的受击
  lastFrame: number;
  // 画质三档（见 setQuality）：高 = 全部效果；中 = 保留描边、光照和泛光调色，
  // 泛光少两级、不做热浪和冲击波扭曲、粒子减半；低 = 不用着色器和动态光照。
  // URL 带 ?mid / ?low 时从中档 / 低档开始，Q 键循环切换，帧率太低时自动往下降一档。
  quality: Quality;
  hq: boolean;                    // 不是低档（描边、轮廓光和动态光照都开着），由 setQuality 维护
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

// ClientZone 是客户端记着的一块回血区：服务端的 ZoneInfo 加上本地时间。
export interface ClientZone extends ZoneInfo {
  born: number;     // 出现的时间（performance.now()）：技能放的从施法动作按地的那一刻开始铺开
  pulseFrom: number; // 回血节奏的起点：服务端放下区域的时间（收到列表的时刻），画回血脉冲用
  endsAt: number;   // 消失的时间（performance.now()），0 表示常驻
  goneAt: number;   // 服务端已经去掉、正在淡出时是去掉的时间，否则为 0
  seed: number;
}

export type Quality = 'high' | 'medium' | 'low';

export const QUALITY_NAMES: Record<Quality, string> = { high: '高', medium: '中', low: '低' };

function initialQuality(): Quality {
  const query = new URLSearchParams(location.search);
  if (query.has('low')) return 'low';
  if (query.has('mid')) return 'medium';
  return 'high';
}

export const state: State = {
  myId: 0,
  moveDx: 0,
  blockHeld: false,
  map: { w: 2400, h: 1600 },
  cell: 320,
  skills: [],
  skillBySlot: {},
  skillPool: [],
  skillPick: 0,
  classes: [],
  playerClass: '',
  canBlock: true,
  pickerOpen: false,
  bagOpen: false,
  linesOpen: false,
  items: new Map(),
  inventory: { items: [], capacity: 0 },
  skins: [],
  mySkin: '',
  pets: [],
  scene: null,
  myPet: '',
  petEntity: 0,
  petRespawnAt: 0,
  petCooldownUntil: 0,
  ents: new Map(),
  self: null,
  cds: {},
  clockSynced: false,
  clockOffset: 0,
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
  zones: [],
  pending: [],
  lastFrame: 0,
  quality: initialQuality(),
  hq: initialQuality() !== 'low',
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

// 初始值可以直接给坐标、血量等（fxlab 用）；收到 Enter 时把 info.state 展开进来
export function makeEntity(d: Partial<Omit<EntityInfo, 'state'>> & Partial<EntityState> & { id: number }, now: number): ClientEntity {
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
    guard: 1,
    guardAt: -1e9,
    parryAt: -1e9,
    breakAt: -1e9,
    looks: 0,
    blinkFrom: null,
    slide: null,
    model: d.model || '',
    skin: d.skin || '',
    gear: d.gear || '',
    owner: d.owner || 0,
    petName: d.kind === 'pet' ? (d.name || '?') : '',
    facing: kind === 'player' ? 0 : (Math.random() < 0.5 ? 0 : Math.PI),
    walk: Math.random() * 6,
    moveUntil: 0,
    rx: d.x || 0,
    ry: d.y || 0,
    attackAt: -1e9,
    action: '',
    attackMs: ATTACK_MS,
    windupFrom: 0,
    stunUntil: 0,
    hitAt: -1e9,
    deadAt: -1,
    freezeUntil: 0,
    knockX: 0,
    knockY: 0,
    knockAmp: 0,
    squashAmp: 0.2,
    shownFacing: NaN,   // 还没画过：第一帧不算转身
    turnAt: -1e9,
    fresh: true,
  };
}

// refreshPetNames 把宠物的名牌拼成「主人名 的 宠物名」；主人还没进视野时先只显示宠物名，主人来了再拼。
export function refreshPetNames(): void {
  for (const e of state.ents.values()) {
    if (e.kind !== 'pet') continue;
    const owner = state.ents.get(e.owner);
    e.name = owner ? `${owner.name} 的 ${e.petName}` : e.petName;
  }
}

// posOf 是实体的绘制位置：从上一个位置插值到最近一次同步的位置。
export function posOf(e: ClientEntity, now: number): Point {
  const slide = e.slide;
  if (slide) {
    const k = (now - slide.at) / slide.ms;
    // 滑动途中服务端又发来别的位置（被推开、继续走）时，以服务端为准
    if (k >= 1 || e.x !== slide.x1 || e.y !== slide.y1) e.slide = null;
    else {
      const eased = 1 - (1 - Math.max(0, k)) * (1 - Math.max(0, k));
      return { x: lerp(slide.x0, slide.x1, eased), y: lerp(slide.y0, slide.y1, eased) };
    }
  }
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
  return Math.max(0, ((state.cds[skillId] || 0) - now) / 1000);
}

// localTime 把服务端时间（秒，Frame.time 同一个时钟）换成本地 performance.now() 毫秒；0 保持 0（没有这个时间点）。
export function localTime(serverTime: number): number {
  return serverTime ? serverTime * 1000 + state.clockOffset : 0;
}

// setQuality 切换画质档位，同时维护 hq（不是低档）。
export function setQuality(quality: Quality): void {
  state.quality = quality;
  state.hq = quality !== 'low';
}
