// Plain shapes the rest of the client uses for server and client messages.
// protocol.ts turns the generated protobuf classes (pb.js) into these, so
// game and render code never touch protobuf directly.

export type EntityKind = 'player' | 'monster' | 'npc';

export interface SkillInfo {
  slot: number;
  id: string;
  name: string;
  kind: 'target' | 'aoe' | 'self' | 'dash' | 'line' | 'zone' | 'rain' | string;
  range?: number;
  radius?: number;
  distance?: number;   // dash 的距离；rain 没有目标时落点在前方多远
  cooldown?: number;
  color?: string;
  fx?: string;
  desc?: string;   // 选技能面板上的一句话说明
}

// ClassInfo 是选技能面板里可以选的一个职业。
export interface ClassInfo {
  id: string;
  name: string;
  desc: string;
  model: string;
  color: string;
  skills: SkillInfo[];   // 默认技能栏（1 号位是固定的普攻）
  pool: SkillInfo[];     // 可以挑的技能
  pick: number;          // 要挑几个（放在第 2 格起）
  canBlock: boolean;     // 右键格挡是否有效
}

export interface Obstacle {
  shape: 'circle' | 'rect' | 'capsule';
  ax: number;
  ay: number;
  bx?: number;
  by?: number;
  r?: number;
}

export interface EntityInfo {
  id: number;
  kind: EntityKind;
  name: string;
  color?: string;
  r?: number;
  lv?: number;
  x: number;
  y: number;
  hp?: number;
  maxHp?: number;
  model?: string;
}

export interface EntityState {
  id: number;
  x: number;
  y: number;
  hp?: number;
  maxHp?: number;
  lv?: number;
  act?: string;
  tg?: number;
  dead?: boolean;
  shield?: number;     // 护盾还能吸收的伤害
  blocking?: boolean;  // 正在格挡
  looks?: number;      // Buff 外观的位：LOOK_HASTE 等（见 game/config.ts）
}

export type EventKind = 'cast' | 'dmg' | 'heal' | 'buff' | 'die' | 'respawn' | 'say' | 'lvl';

export interface GameEvent {
  k: EventKind;
  src?: number;
  dst?: number;
  id?: number;
  skill?: string;
  name?: string;
  fx?: string;
  color?: string;
  radius?: number;
  x?: number;
  y?: number;
  v?: number;      // damage or heal amount
  crit?: boolean;
  text?: string;
  lv?: number;
  dur?: number;
  absorbed?: number; // dmg：被护盾吸收的部分（不含在 v 里）
  blocked?: number;  // dmg：被格挡挡掉的部分（不含在 v 里）
  immune?: boolean;  // dmg：目标无敌，没受伤
  tx?: number;       // cast（闪现、飞斧）：终点；起点是 x、y
  ty?: number;
  zone?: number;     // heal：站在这个回血区里回的血（Zone.id）
}

// ZoneInfo 是地上的一块回血区：出生点的常驻泉水，或技能放下的法阵。
export interface ZoneInfo {
  id: number;
  x: number;
  y: number;
  radius: number;      // 横向半径；地面上画成椭圆，纵向是 radius × ZONE_ASPECT
  name?: string;
  color?: string;
  look?: string;       // spring 泉水 | rune 法阵
  owner?: number;      // 放下它的实体，0 表示地图自带
  until?: number;      // 服务端时间（Sync.time），到这时消失；0 表示常驻
  dur?: number;        // 一共持续多少秒（画倒计时）
  interval?: number;   // 隔几秒回一次血
  heal?: number;       // 每次回复最大生命的比例
}

export interface Attrs { str?: number; agi?: number; int?: number; vit?: number }

export interface Derived {
  maxHp?: number; atk?: number; matk?: number; def?: number;
  mdef?: number; crit?: number; critDmg?: number; speed?: number;
}

export interface SelfInfo {
  lv: number;
  exp: number;
  next: number;
  hp: number;
  base?: Attrs;
  attr?: Derived;
  cds: Record<string, number>;   // skill id -> seconds left
  buffs: { name: string; left: number }[];
  dead?: boolean;
  respawnIn?: number;
}

export type AiStatus = 'success' | 'failure' | 'running';

export interface AiNode {
  node: number;
  depth: number;
  kind: string;
  name: string;
  status: AiStatus;
  notes: string[];
  checks: AiCheck[];   // 本帧检查过的条件装饰器（含冷却）
  fresh: boolean;      // 本帧新进入；false 表示接着上一帧继续运行
  why: string[];       // 任务给出的说明
}

export interface AiCheck {
  node: number;        // 装饰器节点 id
  pass: boolean;       // 已算上取反
  why: string;
}

export interface AiTick { time: number; nodes: AiNode[] }

// AiTreeNode 是整棵树里的一个节点（调试面板画树用）。
export interface AiTreeNode {
  id: number;
  kind: string;        // composite | task | decorator | service
  subType: string;
  label: string;       // 编辑器里起的名字，可能为空
  props: { key: string; value: string }[];
  children: number[];
  decorators: number[];
  services: number[];
  inverse: boolean;
  periodic: boolean;
  interval: number;
}

export interface AiTreeDef { root: number; nodes: Map<number, AiTreeNode> }

export interface AiTrace {
  id: number;
  tree: string;
  ticks: AiTick[];
  bb: { key: string; value: string }[];
  path: number[];   // x, y pairs from the entity's position along its route
  def: AiTreeDef | null;   // 开始观察后第一次（或换树时）才带
}

export interface WelcomeMsg {
  t: 'welcome';
  id: number;
  map: { w: number; h: number };
  aoi: { cell: number };
  skills: SkillInfo[];
  obstacles: Obstacle[];
  pool: SkillInfo[];   // 可以挑的技能
  pick: number;        // 要挑几个（放在第 2 格起）
  classes: ClassInfo[];   // 可选职业，第一个是默认
  playerClass: string;    // 当前职业 id
}
export interface EnterMsg { t: 'enter'; ents: EntityInfo[] }
export interface LeaveMsg { t: 'leave'; ids: number[] }
export interface SyncMsg {
  t: 'sync';
  time: number;
  ents: EntityState[];
  ev: GameEvent[];
  self: SelfInfo | null;
  ai: AiTrace | null;
  zones: ZoneInfo[] | null;   // 回血区有变化时是整份新列表，没变化时是 null
}
export interface ToastMsg { t: 'msg'; text: string }
export interface SkillBarMsg { t: 'skills'; skills: SkillInfo[]; playerClass: string }   // playerClass 空 = 职业没变

export type ServerMessage = WelcomeMsg | EnterMsg | LeaveMsg | SyncMsg | ToastMsg | SkillBarMsg;

export type ClientMessage =
  | { t: 'move'; dx: number; dy: number }
  | { t: 'target'; target: number }
  | { t: 'cast'; slot: number; target: number; dx?: number; dy?: number }
  | { t: 'loadout'; skills: string[]; cls?: string }   // cls 空 = 不换职业
  | { t: 'watch'; id: number }
  | { t: 'block'; on: boolean };
