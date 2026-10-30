// 客户端表现用的常量：插值、动画时长、配色、字体、属性表。

import type { EntityKind } from '../net/types';

export const LERP_MS = 100;          // 两次 10Hz 同步之间的位置插值时长
export const SNAP_DIST = 400;        // 跳得比这更远就直接瞬移，不做插值
export const ATTACK_MS = 380;        // 攻击挥砍动画
export const ATTACK_IMPACT = 0.45;   // 挥砍动画里打到人的那一刻（占动画时长的比例，见 models.ts 的 phases）
export const ATTACK_HOLD = 0.3;      // 前摇时动作停住的那一帧：武器举到最高
export const HIT_MS = 260;           // 受击动画
export const DEATH_MS = 650;         // 倒地动画

// 每种实体的轮廓光颜色：金色的英雄、血红的怪物、幽蓝的 NPC
export const RIM: Record<EntityKind, string> = { player: '#ffcf6a', monster: '#ff3b2e', npc: '#6fe3ff', pet: '#9fd3a8' };
export const MODEL_SCALE = 1.25;     // 模型画得比碰撞半径略大
// 回血区在地上画成椭圆（和其他地面特效一样压扁），纵向半径 = 横向半径 × ZONE_ASPECT。
// 服务端按同一个椭圆判断站没站在里面（internal/config 的 ZoneAspect），两边要一致。
export const ZONE_ASPECT = 0.6;
// 画角色时的范围（左右、向上、向下各是绘制半径的几倍），要容得下挥舞的武器和倒地的姿势
export const MODEL_BOX: Record<string, [number, number, number]> = {
  default: [3, 3.5, 1.8],
  knight: [3.2, 4.2, 1.8],   // 技能动作里剑会举过头顶、伸得更远
  ranger: [3.4, 4.2, 1.8],   // 拉弓时弓和箭伸到身前，箭雨时弓举过头顶
  guard: [3.6, 3.5, 1.8],
  ogre_chief: [3.6, 4.6, 3.6],
  wolf_king: [3.4, 3.4, 1.8],  // 扑杀时往前窜、颈毛炸开
  hunter: [3.6, 3.6, 1.8],
  skeleton_soldier: [3.2, 4.2, 1.8],   // 劈之前剑举过头顶
  skeleton_knight: [3.2, 4.2, 1.8],
  // 宠物画的时候放大了 1.35 倍（models.ts PET_DRAW_SCALE）
  wolf_pup: [3.8, 3.4, 1.8],
  ember: [3.4, 5.4, 1.8],    // 飘在半空，胀大时更高
  sprout: [3.2, 3.8, 1.8],
};
export function modelBox(model: string, r: number): number[] {
  const [x, up, down] = MODEL_BOX[model] || MODEL_BOX.default;
  return [-r * x, -r * up, r * x, r * down];
}
// 半径 16 时每个模型的绘制高度，用来把名字放在头顶上方
export const MODEL_H: Record<string, number> = {
  knight: 46, ranger: 46, guard: 50, villager: 42, slime: 26, wolf: 30, alpha_wolf: 32, wolf_king: 34, hunter: 44, bramble: 30, skeleton_archer: 46, ogre_chief: 54,
  skeleton_soldier: 46, skeleton_knight: 50, bone_pile: 18, bone_statue: 52, brazier: 30, cracked_wall: 48,
  wolf_pup: 40, ember: 54, sprout: 40,
};
export const ACT_NAMES: Record<string, string> = {
  find_target: '索敌',
  chase_target: '追击',
  cast_skill: '施法',
  wander: '闲逛',
  return_home: '回家',
  flee: '逃跑',
  wait: '待机',
  say: '说话',
  follow_owner: '跟随',
  keep_distance: '拉开距离',
  cast_on_owner: '施法',
  clear_target: '清除目标',
  move: '移动',
  flank: '包抄',
  summon: '召唤',
  find_shot_spot: '找射击位',
  raise_shield: '举盾',
  lower_shield: '放盾',
  flank_shield: '绕到盾侧面',
  reassemble: '重组',
  warn_line: '预警',
  fire_line: '射击',
};
export const KIND_COLOR: Record<string, string> = { player: '#4fc3f7', monster: '#e53935', npc: '#42a5f5' };
export const NAME_COLOR: Record<string, string> = { player: '#f3e9d2', monster: '#ff7a6a', npc: '#8fe6ff' };
export const MOVE_DIR: Record<string, [number, number]> = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};
export const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Segoe UI",sans-serif';
export const DISPLAY = '"Cinzel","Songti SC","Noto Serif CJK SC","Source Han Serif SC","STSong",serif';
export const BASE_ATTRS: [string, string][] = [['str', '力量'], ['agi', '敏捷'], ['int', '智力'], ['vit', '体质']];
export const DERIVED_ATTRS: [string, string][] = [
  ['maxHp', '生命上限'], ['atk', '攻击'], ['matk', '法强'], ['def', '防御'],
  ['mdef', '法抗'], ['crit', '暴击率'], ['critDmg', '暴击伤害'], ['speed', '移速'],
];

// 打击感的全局参数（镜头、死亡溶解、扭曲）。按命中档位区分的顿帧、击退、形变在 feel/profiles.ts。
// ?fxlab 实验页里可以拖滑条实时调整。
export const FEEL = {
  camFollowMs: 110,       // 镜头追上目标点需要的大致时间（越小越紧）
  camLead: 60,            // 镜头朝移动方向多看出去的距离（像素）
  shake: 1,               // 震屏强度倍数，0 关闭
  dissolveDelayMs: 1300,  // 倒地后多久开始溶解（只有怪物和 NPC）
  dissolveMs: 1000,       // 溶解持续时间
  distort: 1.5,           // 冲击波和热浪扭曲强度倍数，0 关闭
};


// 技能键：右手放在 J K L / U I O 上，左手 WASD 走路。第 1 格是普攻（也可以点左键）。
export const SKILL_KEYS = ['KeyJ', 'KeyK', 'KeyL', 'KeyU', 'KeyI', 'KeyO'];
export const SKILL_KEY_LABELS = ['J', 'K', 'L', 'U', 'I', 'O'];

// EntityState.looks 的位：身上 Buff 的外观（和服务端 config.Looks 一致）
export const LOOK_HASTE = 1;   // 疾风步：脚下风痕
export const LOOK_HOLY = 2;    // 圣光庇护：金光罩
export const LOOK_FIRE = 4;    // 烈焰附魔：武器着火
export const LOOK_FROST = 8;   // 冰冻：身体发蓝、动作变慢

// 装备稀有度的颜色：名字、图标边框、掉落光
export const RARITY_COLOR: Record<string, string> = { common: '#d8d0c0', rare: '#5fa8ff', epic: '#c77dff' };
