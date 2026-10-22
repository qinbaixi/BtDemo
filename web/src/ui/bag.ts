// 装备面板：E 键或 HUD 上的“装备 (E)”按钮开关，Esc 关闭。
// 上面是三个装备槽（武器 / 护甲 / 饰品），然后是自己的派生属性、当前职业的外观，最下面是背包格子（空格也画出来）。
// 悬停（手机上点一下）显示说明：名字（稀有度颜色）、槽位、职业限制、属性、特效。
// 鼠标点背包里的装备就穿上（发 equip），点身上的就卸下（发 unequip）；手机上先点一下看说明，再点一次才执行。
// 别的职业的装备变暗，点了只提示，不发请求。点外观卡发 skin。
// 外观下面是宠物一栏：一排宠物卡加一张「不带」，点了发 pet；换宠物有冷却，冷却中的卡变暗、显示剩余秒数。
// 面板只显示服务端发来的 Inventory，换装后等服务端回新的 Inventory 再刷新（见 game/sync.ts）。

import { DERIVED_ATTRS, RARITY_COLOR, SKILL_KEY_LABELS } from '../game/config';
import { state } from '../game/state';
import type { ClientMessage, ItemInfo, ItemSlotted, PetInfo } from '../net/types';
import { drawItemIcon } from '../render/itemIcons';
import { formatDerived, showToast } from './hud';
import { rememberSkin, skinCards, skinKey } from './skins';

// 宠物记在 localStorage 的 btdemo.pet 里：存的是宠物 id，空串 = 收回（不带）；没存过是 null。
const PET_STORE_KEY = 'btdemo.pet';
const NO_PET_COLOR = '#6b6f73';   // “不带”卡的色块

const RARITY_NAMES: Record<string, string> = { common: '普通', rare: '稀有', epic: '史诗' };

// 装备槽，按面板上的顺序
const SLOTS: [string, string][] = [['weapon', '武器'], ['armor', '护甲'], ['trinket', '饰品']];
const SLOT_NAMES: Record<string, string> = Object.fromEntries(SLOTS);

// 装备属性的叫法；PERCENT_STATS 里的是小数，显示成百分比
const STAT_NAMES: Record<string, string> = {
  str: '力量', agi: '敏捷', int: '智力', vit: '体质', max_hp: '生命上限', atk: '攻击', matk: '法强',
  def: '防御', mdef: '法抗', crit: '暴击率', crit_dmg: '暴击伤害', speed: '移速', cdr: '冷却缩减',
};
const PERCENT_STATS = new Set(['crit', 'crit_dmg', 'cdr']);
const CDR_CAP = 0.4;   // 冷却缩减上限，和服务端一样

const ICON_SIZE = 40;   // 图标边长（CSS 像素）

let send: (msg: ClientMessage) => void = () => {};
let root: HTMLElement;
let equipBox: HTMLElement;
let statsBox: HTMLElement;
let skinRow: HTMLElement;
let skinBox: HTMLElement;
let petRow: HTMLElement;
let petBox: HTMLElement;
let petKey = '';              // 上次画的宠物卡（含冷却秒数），没变就不动 DOM
let gridBox: HTMLElement;
let bagCount: HTMLElement;
let tip: HTMLElement;
let statsKey = '';            // 上次画的属性文本，没变就不动 DOM
let lastPointer = 'mouse';    // 最近一次按下的指针类型：touch 时第一次点只显示说明
let tipFor = '';              // 说明正显示的是哪一格（bag:uid / slot:weapon）

// initBag 建好面板（隐藏着）。send 用来发 equip / unequip / skin。
export function initBag(sendMsg: (msg: ClientMessage) => void): void {
  send = sendMsg;
  root = document.getElementById('bag')!;
  root.innerHTML = `
    <div class="bag-panel panel">
      <div class="picker-head"><span class="picker-title">装备</span><button type="button" class="bag-close" title="关闭（E / Esc）">×</button></div>
      <div class="bag-equip"></div>
      <div class="bag-stats kvs"></div>
      <div class="bag-skins"><span class="skin-label">外观</span><div class="bag-skin-cards"></div></div>
      <div class="bag-skins bag-pets"><span class="skin-label">宠物</span><div class="bag-skin-cards bag-pet-cards"></div></div>
      <div class="bag-sub"><span>背包</span><span class="bag-count"></span></div>
      <div class="bag-grid"></div>
      <div class="picker-tip bag-tip-line">点背包里的装备穿上 · 点身上的卸下 · E / Esc 关闭</div>
    </div>
    <div class="item-tip hidden"></div>`;
  equipBox = root.querySelector('.bag-equip')!;
  statsBox = root.querySelector('.bag-stats')!;
  skinRow = root.querySelector('.bag-skins')!;
  skinBox = root.querySelector('.bag-skin-cards')!;
  petRow = root.querySelector('.bag-pets')!;
  petBox = root.querySelector('.bag-pet-cards')!;
  gridBox = root.querySelector('.bag-grid')!;
  bagCount = root.querySelector('.bag-count')!;
  tip = root.querySelector('.item-tip')!;
  root.querySelector('.bag-close')!.addEventListener('click', closeBag);
  // 面板上的点击不要传到画布；记下是不是触屏
  root.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    lastPointer = event.pointerType || 'mouse';
    // 手机上点到格子以外的地方就收起说明
    if (!(event.target as HTMLElement).closest('.bag-item')) hideTip();
  });
  const btn = document.getElementById('bag-btn');
  btn?.addEventListener('pointerdown', (event) => event.stopPropagation());
  btn?.addEventListener('click', () => toggleBag());
  // 换宠物的冷却要看着秒数往下走：面板开着时每 250 毫秒刷新一次宠物一栏（没变就不动 DOM）
  window.setInterval(() => {
    if (state.bagOpen) renderPets();
  }, 250);
}

// rememberedPet 是上次选的宠物 id（空串 = 上次选的是不带）；没存过或存不了时返回 null。
export function rememberedPet(): string | null {
  try {
    return localStorage.getItem(PET_STORE_KEY);
  } catch {
    return null;   // 浏览器不让存
  }
}

// rememberPet 记下选的宠物（空串 = 不带）。
export function rememberPet(petId: string): void {
  try {
    localStorage.setItem(PET_STORE_KEY, petId);
  } catch {
    // 存不了就算了
  }
}

export function openBag(): void {
  if (!root) return;
  state.bagOpen = true;
  root.classList.remove('hidden');
  refreshBag();
}

export function closeBag(): void {
  if (!root) return;
  state.bagOpen = false;
  root.classList.add('hidden');
  hideTip();
}

export function toggleBag(): void {
  if (state.bagOpen) closeBag();
  else openBag();
}

// bagKey 处理面板开着时的按键，返回 true 表示用掉了这个键。
export function bagKey(code: string): boolean {
  if (code === 'Escape' || code === 'KeyE') {
    closeBag();
    return true;
  }
  if (SKILL_KEY_LABELS.some((label) => code === 'Key' + label)) {
    showToast('先关闭装备面板（E / Esc）');
    return true;
  }
  return false;
}

// refreshBag 按 state 重画整个面板（Inventory、换职业、换外观之后）。面板关着时什么也不做。
export function refreshBag(): void {
  if (!root || !state.bagOpen) return;
  hideTip();
  renderEquip();
  statsKey = '';
  renderBagStats();
  renderSkins();
  renderPets();
  renderGrid();
}

// itemOf 查装备种类；图鉴里没有的（服务端新加的）给个占位，免得面板出错。
function itemOf(id: string): ItemInfo {
  return state.items.get(id) ?? {
    id, name: id, slot: '', cls: '', rarity: 'common', desc: '', stats: [], effect: '', look: '',
  };
}

function className(id: string): string {
  return state.classes.find((c) => c.id === id)?.name ?? id;
}

// usable 表示当前职业能不能穿（通用的或本职业的）
function usable(item: ItemInfo): boolean {
  return !item.cls || item.cls === state.playerClass;
}

function iconCanvas(item: ItemInfo): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(ICON_SIZE * dpr);
  canvas.height = Math.round(ICON_SIZE * dpr);
  canvas.className = 'item-icon';
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.scale(dpr, dpr);
    drawItemIcon(ctx, item, ICON_SIZE);
  }
  return canvas;
}

function renderEquip(): void {
  const worn = new Map(state.inventory.items.filter((it) => it.slot).map((it) => [it.slot, it]));
  equipBox.replaceChildren(...SLOTS.map(([slot, label]) => {
    const owned = worn.get(slot);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'equip-slot';
    const name = document.createElement('span');
    name.className = 'equip-name';
    const slotLabel = document.createElement('span');
    slotLabel.className = 'equip-label';
    slotLabel.textContent = label;
    if (owned) {
      const item = itemOf(owned.id);
      el.classList.add('bag-item');
      el.style.setProperty('--rarity', RARITY_COLOR[item.rarity] ?? RARITY_COLOR.common);
      name.textContent = item.name;
      el.append(iconCanvas(item));
      wireItem(el, `slot:${slot}`, item, owned, () => send({ t: 'unequip', slot }));
    } else {
      el.classList.add('empty');
      el.disabled = true;
      name.textContent = '空';
      const blank = document.createElement('span');
      blank.className = 'item-icon blank';
      el.append(blank);
    }
    const text = document.createElement('span');
    text.className = 'equip-text';
    text.append(slotLabel, name);
    el.append(text);
    return el;
  }));
}

// renderBagStats 刷新派生属性一栏（每次收到自己的属性时调用；面板关着时什么也不做）。
export function renderBagStats(): void {
  if (!root || !state.bagOpen) return;
  const attr = state.self?.attr as Record<string, unknown> | undefined;
  const rows: [string, string][] = DERIVED_ATTRS.map(([key, label]) => [label, formatDerived(key, attr?.[key])]);
  // 冷却缩减不在派生属性里：按身上装备加起来（上限 40%）
  let cdr = 0;
  for (const owned of state.inventory.items) {
    if (!owned.slot) continue;
    for (const stat of itemOf(owned.id).stats) if (stat.stat === 'cdr') cdr += stat.value;
  }
  if (cdr > 0) rows.push(['冷却缩减', percent(Math.min(cdr, CDR_CAP))]);
  const key = rows.map((row) => row.join('=')).join('|');
  if (key === statsKey) return;
  statsKey = key;
  statsBox.replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'kv';
    const name = document.createElement('span');
    name.textContent = label;
    const val = document.createElement('b');
    val.textContent = value;
    row.append(name, val);
    return row;
  }));
}

function renderSkins(): void {
  skinRow.hidden = state.skins.length < 2;
  skinBox.replaceChildren(...skinCards(state.skins, skinKey(state.playerClass, state.mySkin), (skin) => {
    rememberSkin(state.playerClass, skin.id);
    if (skin.id !== skinKey(state.playerClass, state.mySkin)) send({ t: 'skin', skin: skin.id });
  }));
}

// renderPets 画宠物一栏：每只宠物一张卡，最后是「不带」。当前带着的高亮；换宠物冷却中的卡变暗，写剩余秒数。
function renderPets(): void {
  petRow.hidden = state.pets.length === 0;
  if (!state.pets.length) return;
  const cooling = Math.max(0, Math.ceil((state.petCooldownUntil - performance.now()) / 1000));
  const choices: PetInfo[] = [...state.pets, { id: '', name: '不带', desc: '收回宠物', color: NO_PET_COLOR, model: '' }];
  const key = `${state.myPet}|${cooling}|${choices.map((pet) => pet.id).join(',')}`;
  if (key === petKey) return;
  petKey = key;
  petBox.replaceChildren(...choices.map((pet) => {
    const selected = pet.id === state.myPet;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'skin-card pet-card' + (selected ? ' selected' : '') + (!selected && cooling > 0 ? ' cooling' : '');
    card.style.setProperty('--swatch', pet.color || '#e8b65a');
    card.title = pet.desc || pet.name;
    card.innerHTML = '<span class="skin-swatch"></span><span class="skin-text"><b class="skin-name"></b><span class="skin-desc"></span></span>';
    card.querySelector('.skin-name')!.textContent = pet.name;
    const desc = !selected && cooling > 0 ? `冷却 ${cooling} 秒` : pet.desc;
    card.querySelector('.skin-desc')!.textContent = desc;
    card.addEventListener('click', () => pickPet(pet.id));
    return card;
  }));
}

// pickPet 点了一张宠物卡：冷却中只提示；否则发 pet 并记住。
function pickPet(petId: string): void {
  if (petId === state.myPet) return;
  const remaining = Math.ceil((state.petCooldownUntil - performance.now()) / 1000);
  if (remaining > 0) {
    showToast(`换宠物冷却中，还有 ${remaining} 秒`);
    return;
  }
  rememberPet(petId);
  send({ t: 'pet', pet: petId });
}

function renderGrid(): void {
  const inBag = state.inventory.items.filter((it) => !it.slot);
  const capacity = Math.max(state.inventory.capacity, inBag.length);
  bagCount.textContent = `${inBag.length} / ${state.inventory.capacity}`;
  const cells: HTMLElement[] = [];
  for (let i = 0; i < capacity; i++) {
    const owned = inBag[i];
    if (!owned) {
      const empty = document.createElement('div');
      empty.className = 'bag-cell empty';
      cells.push(empty);
      continue;
    }
    const item = itemOf(owned.id);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'bag-cell bag-item' + (usable(item) ? '' : ' locked');
    cell.style.setProperty('--rarity', RARITY_COLOR[item.rarity] ?? RARITY_COLOR.common);
    cell.append(iconCanvas(item));
    wireItem(cell, `bag:${owned.uid}`, item, owned, () => {
      if (!usable(item)) {
        showToast(`${className(item.cls)}专用，当前职业不能装备`);
        return;
      }
      send({ t: 'equip', uid: owned.uid });
    });
    cells.push(cell);
  }
  gridBox.replaceChildren(...cells);
}

// wireItem 给一格装上说明和点击：鼠标悬停显示说明、点一下执行；触屏第一次点显示说明，再点同一格才执行。
function wireItem(el: HTMLElement, key: string, item: ItemInfo, owned: ItemSlotted, act: () => void): void {
  el.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'mouse') showTip(el, key, item, owned, false);
  });
  el.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse' && tipFor === key) hideTip();
  });
  el.addEventListener('click', () => {
    if (lastPointer !== 'mouse' && tipFor !== key) {
      showTip(el, key, item, owned, true);
      return;
    }
    hideTip();
    act();
  });
}

function showTip(anchor: HTMLElement, key: string, item: ItemInfo, owned: ItemSlotted, touch: boolean): void {
  tipFor = key;
  const color = RARITY_COLOR[item.rarity] ?? RARITY_COLOR.common;
  const lines: HTMLElement[] = [];
  const line = (cls: string, text: string): HTMLElement => {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    lines.push(el);
    return el;
  };
  line('tip-name', item.name).style.color = color;
  const restrict = item.cls ? `${className(item.cls)}专用` : '通用';
  line('tip-meta', [RARITY_NAMES[item.rarity] ?? item.rarity, SLOT_NAMES[item.slot] ?? item.slot, restrict].filter(Boolean).join(' · '));
  for (const stat of item.stats) line('tip-stat', statLine(stat.stat, stat.value));
  if (item.desc) line('tip-desc', item.desc);
  const verb = touch ? '再点一次' : '点击';
  if (owned.slot) line('tip-hint', `${verb}卸下`);
  else if (!usable(item)) line('tip-hint locked', `${restrict}：换成${className(item.cls)}后才能装备`);
  else line('tip-hint', `${verb}装备`);
  tip.replaceChildren(...lines);
  tip.style.setProperty('--rarity', color);
  tip.classList.remove('hidden');

  // 放在格子上方，放不下就放下方；左右不出屏幕
  const rect = anchor.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
  let top = rect.top - height - 8;
  if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - height - 8);
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function hideTip(): void {
  tipFor = '';
  tip?.classList.add('hidden');
}

function percent(v: number): string {
  return `${Math.round(v * 1000) / 10}%`;
}

// statLine 把一条属性加成写成“攻击 +6”“暴击率 +6%”。
function statLine(stat: string, value: number): string {
  const sign = value < 0 ? '-' : '+';
  const abs = Math.abs(value);
  const text = PERCENT_STATS.has(stat) ? percent(abs) : String(Math.round(abs * 100) / 100);
  return `${STAT_NAMES[stat] ?? stat} ${sign}${text}`;
}
