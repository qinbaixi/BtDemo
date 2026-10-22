// 选技能面板：刚进游戏和死亡时弹出来，先选职业（顶部两张职业卡，按 1 / 2 也能切），
// 再从该职业的技能池里挑几个技能放到 K L U I O（J 普攻固定）。切换职业会换掉技能池、个数和默认选择。
// 点技能卡选上 / 取消，点上面的格子也能取消；回车确认，Esc 关掉（不换技能）。
// 确认后发 Loadout（带职业和技能）给服务端，服务端回 SkillBar 才真正换上（见 game/sync.ts）。
// 上次选的职业和每个职业的技能记在浏览器里，下次进游戏默认选好。
// 职业卡下面是该职业的外观卡，确认时外观和现在的不一样就再发 SetSkin（换了职业的话，等服务端确认换职业后由 sync.ts 发）。

import { SKILL_KEY_LABELS } from '../game/config';
import { state } from '../game/state';
import type { ClassInfo, ClientMessage, SkillInfo } from '../net/types';
import { showToast } from './hud';
import { rememberedSkin, rememberSkin, setPendingSkin, skinCards, skinKey, skinsOf } from './skins';

const STORE_KEY = 'btdemo.loadout';

// 浏览器里存的东西：上次的职业，和每个职业各自选的技能
// （skins 是每个职业的外观，由 ui/skins.ts 读写）
interface SavedLoadout { cls?: string; skills?: Record<string, string[]>; skins?: Record<string, string> }

// 技能类型在卡片上的叫法
const KIND_NAMES: Record<string, string> = {
  target: '单体', aoe: '范围', self: '自身', dash: '位移', line: '投掷', zone: '法阵',
};

let send: (msg: ClientMessage) => void = () => {};
let root: HTMLElement;
let title: HTMLElement;
let count: HTMLElement;
let slotsBox: HTMLElement;
let grid: HTMLElement;
let confirmBtn: HTMLButtonElement;
let classBox: HTMLElement;
let skinBox: HTMLElement;
let chosen: string[] = [];
let chosenSkin = '';      // 面板上选中的外观 id（空 = 默认）
let selectedClass = '';   // 面板上选中的职业 id（没有职业列表时是空）
let reason: 'join' | 'death' = 'join';

// initPicker 建好面板（隐藏着）。send 用来发 Loadout。
export function initPicker(sendMsg: (msg: ClientMessage) => void): void {
  send = sendMsg;
  root = document.getElementById('picker')!;
  root.innerHTML = `
    <div class="picker-panel panel">
      <div class="picker-head"><span class="picker-title"></span><span class="picker-count"></span></div>
      <div class="picker-classes"></div>
      <div class="picker-skins"></div>
      <div class="picker-slots"></div>
      <div class="picker-grid"></div>
      <div class="picker-foot">
        <span class="picker-tip">点技能卡选上或取消 · 数字键 1 2 换职业 · 回车确认 · Esc 关闭</span>
        <button type="button" class="picker-ok"></button>
      </div>
    </div>`;
  title = root.querySelector('.picker-title')!;
  count = root.querySelector('.picker-count')!;
  classBox = root.querySelector('.picker-classes')!;
  skinBox = root.querySelector('.picker-skins')!;
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
  if (!root || !state.skillPool.length) return;
  // 刚进游戏默认上次选的职业，死亡后默认现在的职业
  const saved = loadSaved();
  const last = state.classes.find((c) => c.id === saved.cls);
  selectedClass = (why === 'join' && last ? last.id : state.playerClass) || state.classes[0]?.id || '';
  if (pickOf() <= 0) return;
  reason = why;
  chosen = initialChoice();
  chosenSkin = initialSkin();
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
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  if (digit) {
    const cls = state.classes[Number(digit[1]) - 1];
    if (cls) selectClass(cls.id);
    return true;
  }
  // 技能键在面板开着时不放技能，也不往下传；提示一下为什么没反应
  if (SKILL_KEY_LABELS.some((label) => code === 'Key' + label)) {
    showToast('先选好技能：回车确认，Esc 关闭');
    return true;
  }
  return false;
}

function loadSaved(): SavedLoadout {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) return saved;
  } catch {
    // 浏览器不让存，或者存的东西坏了：用默认的
  }
  return {};
}

// 面板上选中的职业；服务端没发职业列表时是 undefined，技能池和个数用 state 里的
function currentClass(): ClassInfo | undefined {
  return state.classes.find((c) => c.id === selectedClass);
}

function poolOf(): SkillInfo[] {
  return currentClass()?.pool ?? state.skillPool;
}

function pickOf(): number {
  return currentClass()?.pick ?? state.skillPick;
}

// 固定的 1 号位普攻：选的是当前职业就用技能栏上的，换了职业用该职业默认栏上的
function basicOf(): SkillInfo | null {
  const cls = currentClass();
  if (!cls || cls.id === state.playerClass) return state.skillBySlot[1] ?? null;
  return cls.skills.find((skill) => skill.slot === 1) ?? null;
}

// initialChoice 是选中职业默认选好的技能：上次确认过的，没有就用现在技能栏上的（当前职业），
// 再没有就用该职业的默认技能栏。
function initialChoice(): string[] {
  const cls = currentClass();
  const pick = pickOf();
  const valid = new Set(poolOf().map((skill) => skill.id));
  const usable = (ids: unknown): string[] | null => {
    if (!Array.isArray(ids)) return null;
    const list = ids.filter((id) => typeof id === 'string' && valid.has(id));
    const unique = [...new Set(list)];
    return unique.length === pick ? unique : null;
  };
  const saved = loadSaved().skills?.[selectedClass];
  const current = (!cls || cls.id === state.playerClass ? state.skills : cls.skills)
    .filter((skill) => skill.slot > 1).map((skill) => skill.id);
  return usable(saved) ?? usable(current) ?? current.filter((id) => valid.has(id)).slice(0, pick);
}

// initialSkin 是选中职业默认选好的外观：上次选的；没有的话当前职业用现在穿的，别的职业用默认。
function initialSkin(): string {
  const remembered = rememberedSkin(selectedClass);
  if (remembered) return remembered;
  if (selectedClass === state.playerClass) return state.mySkin;
  return '';
}

// selectClass 切换面板上的职业：技能池、个数、固定普攻和默认选择都换成该职业的。
function selectClass(id: string): void {
  if (id === selectedClass || !state.classes.some((c) => c.id === id)) return;
  selectedClass = id;
  chosen = initialChoice();
  chosenSkin = initialSkin();
  render();
}

function confirm(): void {
  if (chosen.length !== pickOf()) return;
  const changedClass = !!selectedClass && selectedClass !== state.playerClass;
  const saved = loadSaved();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      ...saved, cls: selectedClass || undefined, skills: { ...saved.skills, [selectedClass]: chosen },
    }));
  } catch {
    // 存不了就算了，下次用默认的
  }
  const same = chosen.every((id, i) => state.skillBySlot[i + 2]?.id === id);
  if (changedClass || !same) {
    send({ t: 'loadout', skills: chosen.slice(), cls: changedClass ? selectedClass : undefined });
  }
  // 外观：职业没换时记下来，和现在的不一样就直接发；
  // 换了职业的先挂着，等服务端回 SkillBar 确认换了职业后由 sync.ts 发出去并记住（服务端拒绝换职业时就不记）
  if (skinsOf(selectedClass).length) {
    if (changedClass) {
      setPendingSkin(selectedClass, chosenSkin);
    } else {
      rememberSkin(selectedClass, chosenSkin);
      if (skinKey(selectedClass, chosenSkin) !== skinKey(selectedClass, state.mySkin)) {
        send({ t: 'skin', skin: chosenSkin });
      }
    }
  }
  closePicker();
}

function toggle(id: string): void {
  const at = chosen.indexOf(id);
  if (at >= 0) chosen.splice(at, 1);
  else if (chosen.length < pickOf()) chosen.push(id);
  render();
}

function render(): void {
  renderClasses();
  renderSkins();
  title.textContent = reason === 'join' ? '选择技能' : '重新选择技能（复活后生效）';
  count.textContent = `已选 ${chosen.length} / ${pickOf()}`;
  confirmBtn.textContent = reason === 'join' ? '出发' : '确定';
  confirmBtn.disabled = chosen.length !== pickOf();

  // 上面一排格子：J 是固定的普攻，后面按选的顺序放
  const basic = basicOf();
  const slotEls: HTMLElement[] = [slotEl(SKILL_KEY_LABELS[0], basic ?? null, true)];
  for (let i = 0; i < pickOf(); i++) {
    const skill = poolOf().find((pooled) => pooled.id === chosen[i]) ?? null;
    const el = slotEl(SKILL_KEY_LABELS[i + 1] ?? String(i + 2), skill, false);
    if (skill) el.addEventListener('click', () => toggle(skill.id));
    slotEls.push(el);
  }
  slotsBox.replaceChildren(...slotEls);

  grid.replaceChildren(...poolOf().map((skill) => {
    const at = chosen.indexOf(skill.id);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'pick-card' + (at >= 0 ? ' chosen' : '');
    card.disabled = at < 0 && chosen.length >= pickOf();
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

// renderClasses 画顶部的职业卡；只有一个职业（或服务端没发职业）时整排不显示。
function renderClasses(): void {
  classBox.hidden = state.classes.length < 2;
  classBox.replaceChildren(...state.classes.map((cls, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'class-card' + (cls.id === selectedClass ? ' selected' : '');
    card.style.setProperty('--cls', cls.color || '#e8b65a');
    card.innerHTML = '<span class="pick-key"></span><b class="class-name"></b><span class="class-desc"></span>';
    card.querySelector('.pick-key')!.textContent = String(i + 1);
    card.querySelector('.class-name')!.textContent = cls.name;
    card.querySelector('.class-desc')!.textContent = cls.desc;
    card.addEventListener('click', () => selectClass(cls.id));
    return card;
  }));
}

// renderSkins 画选中职业的外观卡；只有一套外观（或服务端没发）时整排不显示。
function renderSkins(): void {
  const skins = skinsOf(selectedClass);
  skinBox.hidden = skins.length < 2;
  const label = document.createElement('span');
  label.className = 'skin-label';
  label.textContent = '外观';
  skinBox.replaceChildren(label, ...skinCards(skins, skinKey(selectedClass, chosenSkin), (skin) => {
    chosenSkin = skin.id;
    render();
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
