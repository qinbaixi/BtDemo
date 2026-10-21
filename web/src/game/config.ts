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
