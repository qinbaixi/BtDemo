// Plain shapes the rest of the client uses for server and client messages.
// protocol.ts turns the generated protobuf classes (pb.js) into these, so
// game and render code never touch protobuf directly.

export type EntityKind = 'player' | 'monster' | 'npc';

export interface SkillInfo {
  slot: number;
  id: string;
  name: string;
  kind: 'target' | 'aoe' | 'self' | string;
  range?: number;
  radius?: number;
  cooldown?: number;
  color?: string;
  fx?: string;
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
}

export interface AiTrace {
  id: number;
  tree: string;
  ticks: { time: number; nodes: AiNode[] }[];
  bb: { key: string; value: string }[];
  path: number[];   // x, y pairs from the entity's position along its route
}

export interface WelcomeMsg {
  t: 'welcome';
  id: number;
  map: { w: number; h: number };
  aoi: { cell: number };
  skills: SkillInfo[];
  obstacles: Obstacle[];
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
}
export interface ToastMsg { t: 'msg'; text: string }

export type ServerMessage = WelcomeMsg | EnterMsg | LeaveMsg | SyncMsg | ToastMsg;

export type ClientMessage =
  | { t: 'move'; dx: number; dy: number }
  | { t: 'target'; target: number }
  | { t: 'cast'; slot: number; target: number }
  | { t: 'watch'; id: number };
