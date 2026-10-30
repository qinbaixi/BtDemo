// 副本（关卡）的界面：走进房间时屏幕中间打出房间名和“第 1 / 2 波”，打完打出“清除”；
// 打着的时候场景牌子下面挂一条进度（房间名 · 第几波 · 还剩几只）。
// 门的开关画在 render/gates.ts，门上的奖励图标画在叠加层（drawGateRewards）。
//
// 服务端每次进度变了发整份 LevelState，这里和上一份比，找出“开打了 / 下一波 / 清完了”这些变化来演出。

import { gateSlam, levelClear } from '../feel/director';
import { gameNow } from '../game/clock';
import { posOf, state } from '../game/state';
import type { LevelMsg, RoomInfo, RoomState } from '../net/types';

// 一个副本的进度。rooms 按房间 id；gateAt 是每扇门最近一次开关的时间（演出时钟），给开关门动画用。
export interface ClientLevel {
  rooms: Map<string, RoomState>;
  open: Set<string>;
  gateAt: Map<string, number>;
}

const BANNER_MS = 2600;   // 房间名横幅停留多久

let banner: HTMLElement;
let bannerTitle: HTMLElement;
let bannerSub: HTMLElement;
let bannerTimer = 0;
let progress: HTMLElement;

export function initLevel(): void {
  const hud = document.getElementById('hud')!;
  banner = document.createElement('div');
  banner.className = 'level-banner hidden';
  banner.setAttribute('role', 'status');
  banner.innerHTML = '<div class="level-banner-title"></div><div class="level-banner-sub"></div>';
  bannerTitle = banner.querySelector('.level-banner-title')!;
  bannerSub = banner.querySelector('.level-banner-sub')!;
  progress = document.createElement('div');
  progress.className = 'level-progress hidden';
  hud.append(banner, progress);
}

// resetLevel 在 welcome 时调用：换了场景，进度等服务端重新发。
export function resetLevel(): void {
  state.level = null;
  progress?.classList.add('hidden');
}

// onLevel 收下服务端的整份进度，和上一份比较后放演出。第一份（刚进副本、重连）只记下，不演出。
export function onLevel(m: LevelMsg): void {
  const now = gameNow();
  const prev = state.level;
  const next: ClientLevel = {
    rooms: new Map(m.rooms.map((room) => [room.id, room])),
    open: new Set(m.open),
    gateAt: new Map(prev?.gateAt ?? []),
  };
  for (const gate of state.scene?.gates ?? []) {
    const wasOpen = prev ? prev.open.has(gate.id) : next.open.has(gate.id);
    if (wasOpen !== next.open.has(gate.id)) {
      next.gateAt.set(gate.id, now);
      if (!next.open.has(gate.id)) gateSlam(gate.x + gate.w / 2, gate.y + gate.h / 2, now);
    }
  }
  state.level = next;
  if (!prev) return;
  for (const room of m.rooms) {
    const before = prev.rooms.get(room.id);
    const info = roomInfo(room.id);
    if (!before || !info) continue;
    if (before.phase === 'idle' && room.phase === 'fight') {
      showBanner(info.title, waveText(room.wave, info.waves));
    } else if (room.phase === 'fight' && room.wave > before.wave) {
      showBanner('', waveText(room.wave, info.waves));
    } else if (before.phase === 'fight' && room.phase === 'clear') {
      showBanner('清除', rewardText(info.reward));
      levelClear(now);
    } else if (before.phase === 'idle' && room.phase === 'clear') {
      showBanner(info.title, '安全');
    } else if (before.phase === 'fight' && room.phase === 'idle') {
      showBanner('', '败退……房间已重置');
    }
  }
}

// renderLevelHud 每帧更新打着的房间的进度条（没在打就藏起来）。
export function renderLevelHud(): void {
  const level = state.level;
  const fighting = level ? [...level.rooms.values()].find((room) => room.phase === 'fight') : undefined;
  const info = fighting && roomInfo(fighting.id);
  if (!fighting || !info) {
    progress.classList.add('hidden');
    return;
  }
  const now = gameNow();
  let left = 0;
  for (const e of state.ents.values()) {
    if (e.kind !== 'monster' || e.dead) continue;
    const p = posOf(e, now);
    if (p.x >= info.x && p.x <= info.x + info.w && p.y >= info.y && p.y <= info.y + info.h) left++;
  }
  const text = `${info.title} · ${waveText(fighting.wave, info.waves)} · 还剩 ${left} 只`;
  if (progress.textContent !== text) progress.textContent = text;
  progress.classList.remove('hidden');
}

function roomInfo(id: string): RoomInfo | undefined {
  return state.scene?.rooms.find((room) => room.id === id);
}

function waveText(wave: number, waves: number): string {
  return `第 ${wave} / ${waves} 波`;
}

// REWARD_NAMES 是房间奖励的说法（门上的图标见 render/gates.ts 的 REWARD_LOOKS）
export const REWARD_NAMES: Record<string, string> = { heal: '回满生命', gear: '一件装备', boon: '关内祝福' };

function rewardText(reward: string): string {
  return reward ? `奖励：${REWARD_NAMES[reward] ?? reward}` : '前路已开';
}

function showBanner(title: string, sub: string): void {
  bannerTitle.textContent = title;
  bannerTitle.classList.toggle('hidden', !title);
  bannerSub.textContent = sub;
  banner.classList.remove('hidden', 'out');
  // 重新播入场动画
  banner.style.animation = 'none';
  void banner.offsetWidth;
  banner.style.animation = '';
  window.clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => {
    banner.classList.add('out');
    bannerTimer = window.setTimeout(() => banner.classList.add('hidden'), 500);
  }, BANNER_MS);
}
