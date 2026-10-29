// Plain shapes the rest of the client uses for server and client messages.
// protocol.ts turns the generated protobuf classes (pb.js) into these, so
// game and render code never touch protobuf directly.

export type EntityKind = 'player' | 'monster' | 'npc' | 'pet';

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
  skins: SkinInfo[];     // 这个职业的外观，第一个是默认
}

// SkinInfo 是职业的一套外观：骨骼和动作不变，只换配色和部件画法。
export interface SkinInfo {
  id: string;
  name: string;
  desc: string;
  color: string;   // 选择面板上的色块
}

// PetInfo 是一种宠物（config/pets.yaml，welcome 里一次发全）；第一个是默认。
export interface PetInfo {
  id: string;
  name: string;
  desc: string;    // 装备面板上的一句话说明
  color: string;   // 卡片色块
  model: string;   // 前端模型名
}

// 装备槽位
export type ItemSlot = 'weapon' | 'armor' | 'trinket' | string;

// ItemStat 是装备上的一条属性加成；crit、crit_dmg、cdr 是小数（0.05 = 5%）。
export interface ItemStat {
  stat: string;    // str | agi | int | vit | max_hp | atk | matk | def | mdef | crit | crit_dmg | speed | cdr
  value: number;
}

// ItemInfo 是一种装备（config/items.yaml，welcome 里一次发全）。
export interface ItemInfo {
  id: string;
  name: string;
  slot: ItemSlot;
  cls: string;      // 限定职业 id，空 = 通用（协议里的 class）
  rarity: 'common' | 'rare' | 'epic' | string;
  desc: string;     // 特效的一句话说明
  stats: ItemStat[];
  effect: string;   // 特效种类，如 lifesteal；空 = 没有
  look: string;     // 装备武器时画的外观；空 = 职业默认武器
}

// ItemSlotted 是玩家拥有的一件装备：在背包里，或穿在某个槽位上。
export interface ItemSlotted {
  uid: number;      // 每个玩家内唯一
  id: string;       // ItemInfo.id
  slot: string;     // 穿在这个槽位；空 = 在背包里
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
  state: EntityState;   // 进入视野时所有字段都有
  model?: string;
  skin?: string;   // 玩家外观 id（空 = 默认）
  gear?: string;   // 当前武器的 ItemInfo.look（空 = 职业默认武器）
  owner?: number;  // 宠物的主人实体 id（非宠物为 0）
}

// EntityState 是增量：除 id 外只有变化了的字段有值（值可能是 0 / false / 空串，也算变了）。
export interface EntityState {
  id: number;
  x?: number;
  y?: number;
  hp?: number;
  maxHp?: number;
  lv?: number;
  act?: string;
  tg?: number;
  dead?: boolean;
  shield?: number;     // 护盾还能吸收的伤害
  blocking?: boolean;  // 正在格挡
  looks?: number;      // Buff 外观的位：LOOK_HASTE 等（见 game/config.ts）
  guard?: number;      // 玩家：格挡架势剩余比例 0..1
}

export type EventKind = 'cast' | 'dmg' | 'heal' | 'buff' | 'die' | 'respawn' | 'say' | 'lvl' | 'loot' | 'interrupt';

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
  item?: string;     // loot：掉落的 ItemInfo.id（src = 死掉的怪，dst = 拿到的玩家）
  proc?: string;     // dmg / heal：由装备特效触发时是特效种类（lifesteal、thorns、ignite……）
  weight?: string;   // cast / dmg：命中分量 light | medium | heavy
  kx?: number;       // dmg：目标被击退到 (kx, ky)，用 knockTime 秒
  ky?: number;
  knockTime?: number;
  stun?: number;     // dmg：目标硬直秒数
  wall?: boolean;    // dmg：被打到撞墙
  hitAt?: number;    // cast：有前摇时命中的服务端时间（秒）
  // dmg：怎么挨的这一下，没有就是正常命中。parry（完美格挡）时 kx / ky / knockTime / stun 说的是被弹开的攻击者（src）
  result?: 'hit' | 'block' | 'parry' | 'guard_break' | 'immune';
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
  until?: number;      // 服务端时间（Frame.time），到这时消失；0 表示常驻
  dur?: number;        // 一共持续多少秒（画倒计时）
  interval?: number;   // 隔几秒回一次血
  heal?: number;       // 每次回复最大生命的比例
}

export interface Attrs { str?: number; agi?: number; int?: number; vit?: number }

export interface Derived {
  maxHp?: number; atk?: number; matk?: number; def?: number;
  mdef?: number; crit?: number; critDmg?: number; speed?: number;
}

// SelfUpdate 是服务端发来的自己的信息，增量：只有变了的字段有值。
// 时间点（readyAt、until、respawnAt）是服务端时间，game/sync.ts 合并时换算成本地时间。
export interface SelfUpdate {
  lv?: number;
  exp?: number;
  next?: number;
  hp?: number;
  base?: Attrs;       // 出现就整体替换
  attr?: Derived;     // 出现就整体替换
  cds?: { skill: string; readyAt: number }[];   // 只在整份冷却列表有变化时出现（cds_set）
  buffs?: { name: string; until: number }[];    // 只在整份 Buff 列表有变化时出现（buffs_set）
  dead?: boolean;
  respawnAt?: number; // 复活的服务端时间；0 = 没死
}

// SelfInfo 是合并后的完整自己信息（state.self）。时间点是本地 performance.now() 毫秒。
export interface SelfInfo {
  lv: number;
  exp: number;
  next: number;
  hp: number;
  base?: Attrs;
  attr?: Derived;
  buffs: { name: string; endsAt: number }[];
  dead: boolean;
  respawnAt: number;   // 本地复活时刻；0 = 没死
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
  items: ItemInfo[];      // 全部装备种类（装备图鉴）
  pets: PetInfo[];        // 可以带的宠物，第一个是默认
  token: string;          // 断线重连时交回服务端，接着用这个角色
  resumed: boolean;       // true：还是原来的角色（重连或跟不上后的全量），清掉实体等 Enter 重发，保留玩家自己的选择
  scene: SceneInfo | null;   // 所在的场景和线（单场景的服务端不发）
}

// PortalInfo 是一扇通往别的场景的传送门：站进去一会儿就出发。
export interface PortalInfo { x: number; y: number; r: number; to: string; toName: string }

// SceneInfo 是玩家所在的场景：哪个场景、第几线、地图文件地址、传送门。
export interface SceneInfo { id: string; name: string; line: number; map: string; portals: PortalInfo[] }

// LineInfo 是场景的一条线：人数，以及“拥挤”（soft）和“满”（hard）的人数。
export interface LineInfo { line: number; players: number; soft: number; hard: number }
export interface LinesMsg { t: 'lines'; scene: string; current: number; lines: LineInfo[] }
// TravelMsg：玩家正在前往 scene（显示名），显示过场，等下一个 welcome。
export interface TravelMsg { t: 'travel'; scene: string }
export interface EnterMsg { t: 'enter'; ents: EntityInfo[] }
export interface LeaveMsg { t: 'leave'; ids: number[] }
export interface StateMsg { t: 'state'; state: EntityState }
export interface EventMsg { t: 'event'; ev: GameEvent }
export interface SelfMsg { t: 'self'; self: SelfUpdate }
export interface ZonesMsg { t: 'zones'; zones: ZoneInfo[] }   // 整份新列表
export interface AiMsg { t: 'ai'; trace: AiTrace }

// ServerFrame 是一个 WebSocket 帧：服务端时间（秒）和按顺序要处理的消息。
export interface ServerFrame { time: number; msgs: ServerMessage[] }
export interface ToastMsg { t: 'msg'; text: string }
export interface SkillBarMsg { t: 'skills'; skills: SkillInfo[]; playerClass: string }   // playerClass 空 = 职业没变

// InventoryMsg 是整份背包和身上的装备：进游戏后和每次变化时发。
export interface InventoryMsg { t: 'inventory'; items: ItemSlotted[]; capacity: number }   // capacity 是背包格数（穿着的不算）

// PetStatusMsg 是自己宠物的状态：召唤、收回、死亡、复活、换宠物时发。
// pet 是选中的宠物 id（空 = 不带）；entity 是宠物实体 id（不在视野或没召唤为 0）；
// respawnIn 是死后还有几秒复活（0 = 不在复活中）；cooldown 是换宠物的冷却还剩几秒（0 = 没有冷却）。
export interface PetStatusMsg { t: 'petStatus'; pet: string; entity: number; respawnIn: number; cooldown: number }

export type ServerMessage = WelcomeMsg | EnterMsg | LeaveMsg | StateMsg | EventMsg | SelfMsg | ZonesMsg | AiMsg | ToastMsg | SkillBarMsg | InventoryMsg | PetStatusMsg | LinesMsg | TravelMsg;

export type ClientMessage =
  | { t: 'move'; dx: number; dy: number }
  | { t: 'target'; target: number }
  | { t: 'cast'; slot: number; target: number; dx?: number; dy?: number }
  | { t: 'loadout'; skills: string[]; cls?: string }   // cls 空 = 不换职业
  | { t: 'watch'; id: number }
  | { t: 'block'; on: boolean; face?: number }   // face：举盾时朝哪边，-1 左 1 右
  | { t: 'equip'; uid: number }      // 穿上背包里的一件（ItemSlotted.uid）
  | { t: 'unequip'; slot: string }   // 把这个槽位的卸回背包
  | { t: 'skin'; skin: string }     // 换当前职业的外观（空 = 默认）
  | { t: 'pet'; pet: string }       // 换宠物（空 = 收回）
  | { t: 'lines' }                  // 要这个场景的线路列表（回 lines）
  | { t: 'switchLine'; line: number };   // 换到第 line 线（不在战斗中才行）
