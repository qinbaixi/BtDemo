// 行为树查看器和调试面板共用的数据和文字：录像格式、节点中文名、“这一帧决定做什么”的算法。
// 这个文件会被打进独立的查看器（导出的 HTML 和实时窗口），所以只能依赖类型，不能引游戏代码。

import type { AiNode, AiScore, AiTreeNode } from '../net/types';

export const STATUS_TEXT: Record<string, string> = { success: '成功', failure: '失败', running: '运行中' };

// 子类型的中文名；没列出的直接显示代码名
export const SUB_TEXT: Record<string, string> = {
  selector: '选择', sequence: '序列', parallel: '并行', random_selector: '随机选择', utility_selector: '效用选择',
  utility: '固定分数', consideration: '打分',
  find_target: '索敌', clear_target: '清除目标', chase_target: '追击目标', cast_skill: '施放技能',
  wander: '闲逛', return_home: '回家', flee: '逃跑', wait: '等待', say: '说话',
  has_target: '有目标', target_in_range: '目标在范围内', hp_below: '生命低于', far_from_home: '离家太远',
  was_attacked: '刚被攻击', update_target: '刷新目标', cooldown: '冷却', invert: '结果取反', force_success: '强制成功',
  // 宠物节点
  guard_owner: '守护主人', follow_owner: '跟随主人', keep_distance: '保持距离', cast_on_owner: '对主人施法',
  owner_far: '离主人太远', owner_hp_below: '主人生命低于', owner_in_combat: '主人在战斗',
};

export const COMPOSITE_HINT: Record<string, string> = {
  selector: '按顺序尝试子节点，第一个不失败的就是结果',
  sequence: '按顺序执行子节点，有一个不成功就停',
  parallel: '同时执行所有子节点',
  random_selector: '打乱顺序后像选择节点一样尝试',
  utility_selector: '进入时给每个子节点打分，按分数从高到低尝试；选中的做完之前不重新打分',
};

// 内置的打分装饰器（游戏注册的打分装饰器靠追踪里有没有分数来认）
export const SCORE_DECORATORS = new Set(['utility', 'consideration']);

// scoresOf 收集一帧里所有效用选择节点打的分：键是子节点或打分装饰器的 id（同一棵树里 id 不重复）。
// 旧录像没有 scores 字段，按没有分数处理。
export function scoresOf(nodes: AiNode[]): Map<number, AiScore> {
  const map = new Map<number, AiScore>();
  for (const node of nodes) for (const score of node.scores || []) if (!map.has(score.node)) map.set(score.node, score);
  return map;
}

// scoreText 把分数保留三位小数，和编辑器一致。
export const scoreText = (score: number) => String(Math.round(score * 1000) / 1000);

export const subText = (subType: string) => SUB_TEXT[subType] || subType;

// nodeTitle 是节点在树里的名字：有编辑器起的名字就用它，否则用子类型。
export function nodeTitle(node: AiTreeNode): string {
  return node.label || subText(node.subType);
}

export const propsText = (node: AiTreeNode) => node.props.map((prop) => `${prop.key}=${prop.value}`).join(' ');

// decision 挑出一帧“决定做什么”：最后一个没失败的任务，以及它上面的组合节点链。
export function decision(nodes: AiNode[]): { leaf: AiNode; path: AiNode[] } | null {
  let leaf = -1;
  for (let index = nodes.length - 1; index >= 0; index--) {
    if (nodes[index].kind === 'task' && nodes[index].status !== 'failure') {
      leaf = index;
      break;
    }
  }
  if (leaf < 0) return null;
  const path = [nodes[leaf]];
  let depth = nodes[leaf].depth;
  for (let index = leaf - 1; index >= 0 && depth > 0; index--) {
    if (nodes[index].depth === depth - 1) {
      path.unshift(nodes[index]);
      depth--;
    }
  }
  return { leaf: nodes[leaf], path };
}

// noteText 把服务端的备注翻成一句话。
export function noteText(note: string): string {
  if (note.startsWith('blocked:')) return `被条件 ${note.slice(8)} 拦下`;
  if (note.startsWith('service:')) return `服务 ${note.slice(8)}`;
  return `装饰器 ${note} 改变了结果`;
}

// ---------- 录像格式 ----------
// 导出的 HTML 里嵌的就是一份 BtRecording（JSON），实时窗口收到的也是同样的数据，
// 所以查看器只认这一种格式。

export type KeyValue = { key: string; value: string };

// RecTreeDef 是可以直接转 JSON 的树结构（节点用数组而不是 Map）。
export interface RecTreeDef {
  root: number;
  nodes: AiTreeNode[];
}

// RecTick 是录下的一帧。bb 只在和上一帧不同时才带，省体积；查看器读入时往后补齐。
export interface RecTick {
  time: number;        // 服务端时间，秒
  tree: string;        // 这一帧跑的是哪棵树
  nodes: AiNode[];     // 按访问顺序
  bb?: KeyValue[];
}

export interface BtRecording {
  version: 1;
  title: string;        // 被观察的实体，例如“骷髅弓手 #12 · Lv3”
  exportedAt: string;   // 导出时间（本地时间文字）；实时窗口里为空
  trees: Record<string, RecTreeDef>;
  ticks: RecTick[];
}

// 实时窗口和游戏页之间走的 BroadcastChannel 消息
export const LIVE_CHANNEL = 'btdemo-bt-live';

export type LiveMsg =
  | { t: 'hello' }                                              // 查看器 -> 游戏：刚打开，要一份全量
  | { t: 'snapshot'; recording: BtRecording }                   // 游戏 -> 查看器：全量（打开时、换观察对象时）
  | { t: 'ticks'; title: string; trees: Record<string, RecTreeDef>; ticks: RecTick[] }; // 游戏 -> 查看器：新帧
