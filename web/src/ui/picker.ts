// 选技能面板：刚进游戏和死亡时弹出来，从技能池里挑几个技能放到 K L U I O（J 普攻固定）。
// 点技能卡选上 / 取消，点上面的格子也能取消；回车确认，Esc 关掉（不换技能）。
// 确认后发 Loadout 给服务端，服务端回 SkillBar 才真正换上（见 game/sync.ts）。
// 上次选的技能记在浏览器里，下次进游戏默认选好。

import { SKILL_KEY_LABELS } from '../game/config';
import { state } from '../game/state';
import type { ClientMessage, SkillInfo } from '../net/types';
import { showToast } from './hud';

const STORE_KEY = 'btdemo.loadout';

// 技能类型在卡片上的叫法
const KIND_NAMES: Record<string, string> = {
  target: '单体', aoe: '范围', self: '自身', dash: '位移', line: '投掷',
};

let send: (msg: ClientMessage) => void = () => {};
let root: HTMLElement;
let title: HTMLElement;
let count: HTMLElement;
let slotsBox: HTMLElement;
let grid: HTMLElement;
let confirmBtn: HTMLButtonElement;
let chosen: string[] = [];
let reason: 'join' | 'death' = 'join';

// initPicker 建好面板（隐藏着）。send 用来发 Loadout。
export function initPicker(sendMsg: (msg: ClientMessage) => void): void {
  send = sendMsg;
  root = document.getElementById('picker')!;
  root.innerHTML = `
    <div class="picker-panel panel">
      <div class="picker-head"><span class="picker-title"></span><span class="picker-count"></span></div>
      <div class="picker-slots"></div>
      <div class="picker-grid"></div>
      <div class="picker-foot">
        <span class="picker-tip">点技能卡选上或取消 · 回车确认 · Esc 关闭</span>
        <button type="button" class="picker-ok"></button>
      </div>
    </div>`;
  title = root.querySelector('.picker-title')!;
  count = root.querySelector('.picker-count')!;
  slotsBox = root.querySelector('.picker-slots')!;
  grid = root.querySelector('.picker-grid')!;
  confirmBtn = root.querySelector('.picker-ok')!;
  confirmBtn.addEventListener('click', confirm);
  // 面板上的点击不要传到画布（不然会选目标、普攻）
  root.addEventListener('pointerdown', (event) => event.stopPropagation());
  const reopen = document.getElementById('death-pick');
  reopen?.addEventListener('pointerdown', (event) => event.stopPropagation());
  reopen?.addEventListener('click', () => openPicker('death'));
}

// openPicker 打开面板。why 为 'join' 时是刚进游戏，'death' 时是死亡期间。
export function openPicker(why: 'join' | 'death'): void {
  if (!root || !state.skillPool.length || state.skillPick <= 0) return;
  reason = why;
  chosen = initialChoice();
  state.pickerOpen = true;
  root.classList.remove('hidden');
  render();
}

export function closePicker(): void {
  if (!root) return;
  state.pickerOpen = false;
  root.classList.add('hidden');
}

// pickerKey 处理面板开着时的按键，返回 true 表示用掉了这个键。
export function pickerKey(code: string): boolean {
  if (code === 'Enter' || code === 'NumpadEnter') {
    confirm();
    return true;
  }
  if (code === 'Escape') {
    closePicker();
    return true;
  }
  // 技能键在面板开着时不放技能，也不往下传；提示一下为什么没反应
  if (SKILL_KEY_LABELS.some((label) => code === 'Key' + label)) {
    showToast('先选好技能：回车确认，Esc 关闭');
    return true;
  }
  return false;
}

// initialChoice 是打开面板时默认选好的技能：上次确认过的，没有就用现在技能栏上的。
function initialChoice(): string[] {
  const valid = new Set(state.skillPool.map((skill) => skill.id));
  const usable = (ids: unknown): string[] | null => {
    if (!Array.isArray(ids)) return null;
    const list = ids.filter((id) => typeof id === 'string' && valid.has(id));
    const unique = [...new Set(list)];
    return unique.length === state.skillPick ? unique : null;
  };
  let saved: unknown = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    // 浏览器不让存，或者存的东西坏了：用技能栏上的
  }
  const current = state.skills.filter((skill) => skill.slot > 1).map((skill) => skill.id);
  return usable(saved) ?? usable(current) ?? current.filter((id) => valid.has(id)).slice(0, state.skillPick);
}

function confirm(): void {
  if (chosen.length !== state.skillPick) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(chosen));
  } catch {
    // 存不了就算了，下次用默认的
  }
  const same = chosen.every((id, i) => state.skillBySlot[i + 2]?.id === id);
  if (!same) send({ t: 'loadout', skills: chosen.slice() });
  closePicker();
}

function toggle(id: string): void {
  const at = chosen.indexOf(id);
  if (at >= 0) chosen.splice(at, 1);
  else if (chosen.length < state.skillPick) chosen.push(id);
  render();
}

function render(): void {
  title.textContent = reason === 'join' ? '选择技能' : '重新选择技能（复活后生效）';
  count.textContent = `已选 ${chosen.length} / ${state.skillPick}`;
  confirmBtn.textContent = reason === 'join' ? '出发' : '确定';
  confirmBtn.disabled = chosen.length !== state.skillPick;

  // 上面一排格子：J 是固定的普攻，后面按选的顺序放
  const basic = state.skillBySlot[1];
  const slotEls: HTMLElement[] = [slotEl(SKILL_KEY_LABELS[0], basic ?? null, true)];
  for (let i = 0; i < state.skillPick; i++) {
    const skill = state.skillPool.find((pooled) => pooled.id === chosen[i]) ?? null;
    const el = slotEl(SKILL_KEY_LABELS[i + 1] ?? String(i + 2), skill, false);
    if (skill) el.addEventListener('click', () => toggle(skill.id));
    slotEls.push(el);
  }
  slotsBox.replaceChildren(...slotEls);

  grid.replaceChildren(...state.skillPool.map((skill) => {
    const at = chosen.indexOf(skill.id);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'pick-card' + (at >= 0 ? ' chosen' : '');
    card.disabled = at < 0 && chosen.length >= state.skillPick;
    card.style.setProperty('--skill', skill.color || '#e8b65a');
    const key = at >= 0 ? `<span class="pick-key">${SKILL_KEY_LABELS[at + 1] ?? ''}</span>` : '';
    card.innerHTML = `${key}<b class="pick-name"></b><span class="pick-meta"></span><span class="pick-desc"></span>`;
    card.querySelector('.pick-name')!.textContent = skill.name;
    card.querySelector('.pick-meta')!.textContent = meta(skill);
    card.querySelector('.pick-desc')!.textContent = skill.desc || '';
    card.addEventListener('click', () => toggle(skill.id));
    return card;
  }));
}

function slotEl(key: string, skill: SkillInfo | null, fixed: boolean): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pick-slot' + (skill ? ' filled' : '') + (fixed ? ' fixed' : '');
  if (skill) el.style.setProperty('--skill', skill.color || '#e8b65a');
  const keyEl = document.createElement('span');
  keyEl.className = 'pick-key';
  keyEl.textContent = key;
  const name = document.createElement('span');
  name.textContent = skill ? skill.name : '空';
  el.append(keyEl, name);
  return el;
}

function meta(skill: SkillInfo): string {
  const parts = [KIND_NAMES[skill.kind] ?? skill.kind];
  if (skill.cooldown) parts.push(`冷却 ${skill.cooldown} 秒`);
  return parts.join(' · ');
}
