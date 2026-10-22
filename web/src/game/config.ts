// 客户端表现用的常量：插值、动画时长、配色、字体、属性表。

import type { EntityKind } from '../net/types';

export const LERP_MS = 100;          // 两次 10Hz 同步之间的位置插值时长
export const SNAP_DIST = 400;        // 跳得比这更远就直接瞬移，不做插值
export const ATTACK_MS = 380;        // 攻击挥砍动画
export const HIT_MS = 260;           // 受击动画
export const DEATH_MS = 650;         // 倒地动画

// 每种实体的轮廓光颜色：金色的英雄、血红的怪物、幽蓝的 NPC
export const RIM: Record<EntityKind, string> = { player: '#ffcf6a', monster: '#ff3b2e', npc: '#6fe3ff' };
export const MODEL_SCALE = 1.25;     // 模型画得比碰撞半径略大
// 画角色时的范围（左右、向上、向下各是绘制半径的几倍），要容得下挥舞的武器和倒地的姿势
export const MODEL_BOX: Record<string, [number, number, number]> = {
  default: [3, 3.5, 1.8],
  knight: [3.2, 4.2, 1.8],   // 技能动作里剑会举过头顶、伸得更远
  guard: [3.6, 3.5, 1.8],
  ogre_chief: [3.6, 4.6, 3.6],
};
export function modelBox(model: string, r: number): number[] {
  const [x, up, down] = MODEL_BOX[model] || MODEL_BOX.default;
  return [-r * x, -r * up, r * x, r * down];
}
// 半径 16 时每个模型的绘制高度，用来把名字放在头顶上方
export const MODEL_H: Record<string, number> = {
  knight: 46, guard: 50, villager: 42, slime: 26, wolf: 30, skeleton_archer: 46, ogre_chief: 54,
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
  clear_target: '清除目标',
  move: '移动',
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

// 打击感参数（顿帧、镜头、受击形变、死亡溶解）。?fxlab 实验页里可以拖滑条实时调整。
export const FEEL = {
  hitStopMs: 70,          // 普通命中时攻击者和受击者的动作停顿
  hitStopCritMs: 120,     // 暴击停顿
  hitStopBlockMs: 90,     // 被格挡时的停顿
  camFollowMs: 110,       // 镜头追上目标点需要的大致时间（越小越紧）
  camLead: 60,            // 镜头朝移动方向多看出去的距离（像素）
  shake: 1,               // 震屏强度倍数，0 关闭
  zoomPunch: 0.035,       // 暴击时画面放大的比例
  knockPx: 6,             // 受击时显示上被推开的距离
  squash: 0.2,            // 受击时身体压扁的幅度
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
