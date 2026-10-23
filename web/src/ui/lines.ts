// 场景和分线：顶部中间的场景牌子（“晨曦村 · 1 线”），点它或按 N 打开线路面板，
// 面板列出这个场景的每条线和人数档位（空闲 / 正常 / 拥挤 / 满），点“前往”发 switchLine。
// 换场景、换线时服务端先发 travel：盖一层过场（“正在前往 亡者墓园”），收到新的 welcome 后撤掉。

import { state } from '../game/state';
import type { ClientMessage, LineInfo, LinesMsg } from '../net/types';

let send: (msg: ClientMessage) => void = () => {};
let badge: HTMLButtonElement;
let panel: HTMLElement;
let list: HTMLElement;
let travel: HTMLElement;
let travelText: HTMLElement;
let travelTimer = 0;

export function initLines(sendMsg: (msg: ClientMessage) => void): void {
  send = sendMsg;
  const hud = document.getElementById('hud')!;
  badge = document.createElement('button');
  badge.type = 'button';
  badge.id = 'scene-badge';
  badge.className = 'scene-badge hidden';
  badge.title = '线路（N 键）';
  badge.addEventListener('pointerdown', (event) => event.stopPropagation());
  badge.addEventListener('click', () => toggleLines());

  panel = document.createElement('div');
  panel.id = 'lines';
  panel.className = 'lines-panel panel hidden';
  panel.innerHTML = `
    <div class="lines-head"><span class="lines-title">线路</span><button type="button" class="bag-close" title="关闭（N 或 Esc）">×</button></div>
    <div class="lines-list"></div>
    <div class="lines-note">战斗中（5 秒内挨过打或出过手）不能换线，换线后站在同一个位置。</div>`;
  list = panel.querySelector('.lines-list')!;
  panel.addEventListener('pointerdown', (event) => event.stopPropagation());
  panel.querySelector('.bag-close')!.addEventListener('click', () => closeLines());
  list.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-line]');
    if (!button) return;
    send({ t: 'switchLine', line: Number(button.dataset.line) });
    closeLines();
  });

  travel = document.createElement('div');
  travel.id = 'travel';
  travel.className = 'travel hidden';
  travel.innerHTML = '<div class="travel-text"></div>';
  travelText = travel.querySelector('.travel-text')!;

  hud.append(badge, panel, travel);
}

// renderSceneBadge 按 state.scene 更新场景牌子；单场景的服务端不发场景信息，牌子藏起来。
export function renderSceneBadge(): void {
  const scene = state.scene;
  badge.classList.toggle('hidden', !scene);
  if (!scene) {
    closeLines();
    return;
  }
  badge.textContent = `${scene.name} · ${scene.line} 线`;
  if (state.linesOpen) send({ t: 'lines' });   // 换了线，面板里的“当前”跟着变
}

export function openLines(): void {
  if (!state.scene) return;
  state.linesOpen = true;
  panel.classList.remove('hidden');
  list.innerHTML = '<div class="lines-empty">读取中…</div>';
  send({ t: 'lines' });
}

export function closeLines(): void {
  state.linesOpen = false;
  panel?.classList.add('hidden');
}

export function toggleLines(): void {
  if (state.linesOpen) closeLines();
  else openLines();
}

// linesKey 处理面板开着时的按键，返回 true 表示用掉了这个键。
export function linesKey(code: string): boolean {
  if (code === 'Escape' || code === 'KeyN') {
    closeLines();
    return true;
  }
  return false;
}

// busyOf 是一条线的人数档位：[文字, 样式名]
function busyOf(line: LineInfo): [string, string] {
  if (line.players >= line.hard) return ['满', 'full'];
  if (line.players > line.soft) return ['拥挤', 'busy'];
  if (line.players >= line.soft / 2) return ['正常', 'normal'];
  return ['空闲', 'idle'];
}

// renderLines 画服务端回的线路列表。
export function renderLines(m: LinesMsg): void {
  if (!state.linesOpen || m.scene !== state.scene?.id) return;
  list.innerHTML = '';
  for (const line of m.lines) {
    const [busy, cls] = busyOf(line);
    const row = document.createElement('div');
    row.className = `lines-row ${cls}${line.line === m.current ? ' current' : ''}`;
    const action = line.line === m.current
      ? '<span class="lines-here">当前</span>'
      : line.players >= line.hard
        ? '<span class="lines-here">已满</span>'
        : `<button type="button" class="lines-go" data-line="${line.line}">前往</button>`;
    row.innerHTML = `
      <span class="lines-no">${line.line} 线</span>
      <span class="lines-busy">${busy}</span>
      <span class="lines-count">${line.players} 人</span>
      ${action}`;
    list.append(row);
  }
}

// showTravel 盖上过场：正在前往 name。等 welcome 撤掉；万一一直没来（断线），8 秒后自己撤掉。
export function showTravel(name: string): void {
  closeLines();
  travelText.textContent = `正在前往 ${name}`;
  travel.classList.remove('hidden', 'out');
  window.clearTimeout(travelTimer);
  travelTimer = window.setTimeout(hideTravel, 8000);
}

// hideTravel 淡出过场（没有显示时什么都不做）。
export function hideTravel(): void {
  if (!travel || travel.classList.contains('hidden')) return;
  window.clearTimeout(travelTimer);
  travel.classList.add('out');
  travelTimer = window.setTimeout(() => travel.classList.add('hidden'), 450);
}
