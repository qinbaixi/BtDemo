// HUD：自己的面板、目标面板、技能栏、死亡遮罩、提示条、连接状态。都是 DOM，不画在画布上。

import { BASE_ATTRS, DERIVED_ATTRS, SKILL_KEY_LABELS } from '../game/config';
import { clamp, fmt } from '../game/math';
import { cdRemaining, state } from '../game/state';
import type { SkillInfo } from '../net/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface SkillButton {
  btn: HTMLButtonElement;
  cd: HTMLSpanElement;
  num: HTMLSpanElement;
  sk: SkillInfo | null;
  lastH: string;
  lastNum: string;
}

// 页面元素在 initHud() 里取一次。
let ui: {
  selfName: HTMLElement; selfLv: HTMLElement;
  selfHpFill: HTMLElement; selfHpText: HTMLElement;
  selfExpFill: HTMLElement; selfExpText: HTMLElement;
  baseAttrs: HTMLElement; derivedAttrs: HTMLElement; buffs: HTMLElement;
  panelTarget: HTMLElement; tgtName: HTMLElement; tgtLv: HTMLElement;
  tgtHpFill: HTMLElement; tgtHpText: HTMLElement;
  skillbar: HTMLElement; conn: HTMLElement; toast: HTMLElement;
  death: HTMLElement; deathText: HTMLElement; deathPick: HTMLElement;
};
const attrEls: Record<string, HTMLElement> = {};
let skillBtns: Record<number, SkillButton> = {};
let onCast: (slot: number) => void = () => {};
let toastTimer = 0;

function fmtCrit(c: unknown): string {
  if (typeof c !== 'number') return '-';
  return fmt(c <= 1 ? c * 100 : c) + '%';   // 0.15 和 15 都认
}
function fmtMult(v: unknown): string {
  if (typeof v !== 'number') return '-';
  return (Math.round(v * 100) / 100) + '×';
}
function setText(el: HTMLElement | undefined, s: string): void {
  if (el && el.textContent !== s) el.textContent = s;
}
function setBar(fill: HTMLElement, txt: HTMLElement, cur: number, max: number, label?: string): void {
  const frac = max > 0 ? clamp(cur / max, 0, 1) : 0;
  fill.style.width = (frac * 100).toFixed(2) + '%';
  setText(txt, label ?? `${fmt(cur)} / ${fmt(max)}`);
}

// initHud 取页面元素，cast 是点技能按钮时调用的函数。
export function initHud(cast: (slot: number) => void): void {
  onCast = cast;
  ui = {
    selfName: $('self-name'), selfLv: $('self-lv'),
    selfHpFill: $('self-hp-fill'), selfHpText: $('self-hp-text'),
    selfExpFill: $('self-exp-fill'), selfExpText: $('self-exp-text'),
    baseAttrs: $('base-attrs'), derivedAttrs: $('derived-attrs'), buffs: $('buffs'),
    panelTarget: $('panel-target'), tgtName: $('tgt-name'), tgtLv: $('tgt-lv'),
    tgtHpFill: $('tgt-hp-fill'), tgtHpText: $('tgt-hp-text'),
    skillbar: $('skillbar'), conn: $('conn'), toast: $('toast'),
    death: $('death'), deathText: $('death-text'), deathPick: $('death-pick'),
  };
  buildAttrRows();
  buildSkillBar();
}

export function setConn(kind: 'wait' | 'ok' | 'bad', text: string): void {
  setText(ui.conn, text);
  ui.conn.className = `conn ${kind}`;
}

function buildAttrRows(): void {
  const mk = (defs: [string, string][], box: HTMLElement, prefix: string) => {
    box.replaceChildren(...defs.map(([k, label]) => {
      const row = document.createElement('div');
      row.className = 'kv';
      const name = document.createElement('span');
      name.textContent = label;
      const val = document.createElement('b');
      val.textContent = '-';
      row.append(name, val);
      attrEls[prefix + k] = val;
      return row;
    }));
  };
  mk(BASE_ATTRS, ui.baseAttrs, 'base.');
  mk(DERIVED_ATTRS, ui.derivedAttrs, 'der.');
}

// 技能栏按键盘的样子排成两行：上面 U I O（第 4～6 格），下面 J K L（第 1～3 格）
const BAR_ORDER = [4, 5, 6, 1, 2, 3];

export function buildSkillBar(): void {
  ui.skillbar.replaceChildren();
  skillBtns = {};
  for (const slot of BAR_ORDER) {
    const sk = state.skillBySlot[slot] || null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'skill';
    btn.disabled = !sk;
    if (sk) btn.style.setProperty('--skill', sk.color || '#ffd166');

    const key = document.createElement('span');
    key.className = 'key';
    const label = SKILL_KEY_LABELS[slot - 1] ?? String(slot);
    key.textContent = label;   // 1 号技能是普攻，也可以点左键（帮助栏里写了）
    const name = document.createElement('span');
    name.className = 'sname';
    name.textContent = sk ? sk.name : '—';
    const cd = document.createElement('span');
    cd.className = 'cd';
    const num = document.createElement('span');
    num.className = 'cdnum';
    btn.append(key, name, cd, num);

    btn.addEventListener('click', () => onCast(slot));
    btn.addEventListener('pointerenter', () => { state.hoverSlot = slot; });
    btn.addEventListener('pointerleave', () => {
      if (state.hoverSlot === slot) state.hoverSlot = 0;
    });
    ui.skillbar.appendChild(btn);
    skillBtns[slot] = { btn, cd, num, sk, lastH: '', lastNum: '' };
  }
}

export function renderSkillBar(now: number): void {
  for (const b of Object.values(skillBtns)) {
    if (!b || !b.sk) continue;
    const left = cdRemaining(b.sk.id, now);
    const total = b.sk.cooldown || 0;
    const h = (total > 0 ? clamp(left / total, 0, 1) * 100 : 0).toFixed(1) + '%';
    if (b.lastH !== h) { b.cd.style.height = h; b.lastH = h; }
    const txt = left > 0.05 ? left.toFixed(1) : '';
    if (b.lastNum !== txt) { b.num.textContent = txt; b.lastNum = txt; }
  }
}

export function renderSelf(): void {
  const s = state.self;
  if (!s) return;
  const me = state.ents.get(state.myId);
  setText(ui.selfName, me ? me.name : '我');
  setText(ui.selfLv, `Lv ${fmt(s.lv)}`);

  const maxHp = s.attr?.maxHp ?? me?.maxHp ?? 0;
  setBar(ui.selfHpFill, ui.selfHpText, s.hp ?? me?.hp ?? 0, maxHp);

  const exp = s.exp ?? 0;
  const next = s.next ?? 0;
  setBar(ui.selfExpFill, ui.selfExpText, exp, next, next > 0 ? `${fmt(exp)} / ${fmt(next)}` : fmt(exp));

  for (const [k] of BASE_ATTRS) setText(attrEls['base.' + k], fmt((s.base as any)?.[k]));
  for (const [k] of DERIVED_ATTRS) {
    const v = (s.attr as any)?.[k];
    const text = k === 'crit' ? fmtCrit(v) : k === 'critDmg' ? fmtMult(v) : fmt(v);
    setText(attrEls['der.' + k], text);
  }
  renderBuffs(s.buffs || []);
}

function renderBuffs(list: { name: string; left: number }[]): void {
  if (!list.length) {
    ui.buffs.replaceChildren(document.createTextNode('无'));
    return;
  }
  ui.buffs.replaceChildren(...list.map((b) => {
    const el = document.createElement('span');
    el.className = 'buff';
    el.textContent = `${b.name} ${Math.max(0, b.left ?? 0).toFixed(1)}s`;
    return el;
  }));
}

export function renderTarget(): void {
  const e = state.ents.get(state.target);
  ui.panelTarget.classList.toggle('hidden', !e);
  if (!e) return;
  setText(ui.tgtName, e.name);
  setText(ui.tgtLv, `Lv ${fmt(e.lv)}${e.dead ? ' · 已阵亡' : ''}`);
  setBar(ui.tgtHpFill, ui.tgtHpText, e.hp, e.maxHp);
}

export function renderDeath(now: number): void {
  const s = state.self;
  const dead = !!(s && s.dead);
  ui.death.classList.toggle('hidden', !dead);
  if (!dead) return;
  const left = (s.respawnIn ?? 0) - (now - state.selfAt) / 1000;
  // 选技能面板关掉以后，死亡期间还能点这个按钮重新打开（按钮在 picker.ts 里接上）
  ui.deathPick.classList.toggle('hidden', state.pickerOpen || !state.skillPool.length);
  setText(ui.deathText, left > 0
    ? `你已阵亡，${Math.ceil(left)} 秒后复活`
    : '你已阵亡，即将复活…');
}

export function showToast(text: unknown): void {
  setText(ui.toast, String(text ?? ''));
  ui.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.add('hidden'), 1600);
}
