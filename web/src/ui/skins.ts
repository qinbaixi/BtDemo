// 外观（皮肤）的小工具：选技能面板和装备面板共用。
// - skinCards：一排外观卡（名字 + 色块，当前的高亮）；
// - 每个职业上次选的外观记在 localStorage 的 btdemo.loadout 里（{ ..., skins: { 职业: 外观 id } }），
//   和选技能面板存的职业、技能放在同一个对象里，读写时保留其余字段。

import type { SkinInfo } from '../net/types';
import { state } from '../game/state';

const STORE_KEY = 'btdemo.loadout';

function readStore(): Record<string, any> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) return saved;
  } catch {
    // 浏览器不让存，或者存的东西坏了
  }
  return {};
}

// skinsOf 是某个职业的外观列表（第一个是默认）。
export function skinsOf(classId: string): SkinInfo[] {
  return state.classes.find((c) => c.id === classId)?.skins ?? [];
}

// skinKey 把空串（默认外观）换成默认外观的 id，方便比较“是不是同一套”。
export function skinKey(classId: string, skinId: string): string {
  return skinId || skinsOf(classId)[0]?.id || '';
}

// rememberedSkin 是这个职业上次选的外观；没存过或已经不存在时返回空串（默认）。
export function rememberedSkin(classId: string): string {
  const saved = readStore().skins?.[classId];
  return typeof saved === 'string' && skinsOf(classId).some((skin) => skin.id === saved) ? saved : '';
}

// 选择面板里换职业时选的外观：服务端真的换了职业（回 SkillBar）才发出去并记住，见 sync.ts
let pendingSkin: { classId: string; skinId: string } | null = null;

// setPendingSkin 记下换职业后要用的外观，等服务端确认换了职业再用。
export function setPendingSkin(classId: string, skinId: string): void {
  pendingSkin = { classId, skinId };
}

// takePendingSkin 取出换到 classId 后要用的外观并清掉；没有就返回空串。
export function takePendingSkin(classId: string): string {
  const pending = pendingSkin;
  pendingSkin = null;
  return pending && pending.classId === classId ? pending.skinId : '';
}

// rememberSkin 记下这个职业选的外观。
export function rememberSkin(classId: string, skinId: string): void {
  if (!classId) return;
  const saved = readStore();
  const skins = saved.skins && typeof saved.skins === 'object' ? saved.skins : {};
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...saved, skins: { ...skins, [classId]: skinId } }));
  } catch {
    // 存不了就算了
  }
}

// skinCards 画一排外观卡：selected 是高亮的那张（外观 id），点卡调用 onPick。
export function skinCards(skins: SkinInfo[], selected: string, onPick: (skin: SkinInfo) => void): HTMLElement[] {
  return skins.map((skin, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'skin-card' + (skin.id === selected ? ' selected' : '');
    card.style.setProperty('--swatch', skin.color || '#e8b65a');
    card.title = skin.desc || skin.name;
    card.innerHTML = '<span class="skin-swatch"></span><span class="skin-text"><b class="skin-name"></b><span class="skin-desc"></span></span>';
    card.querySelector('.skin-name')!.textContent = skin.name;
    card.querySelector('.skin-desc')!.textContent = i === 0 ? '默认' : (skin.desc || '');
    card.addEventListener('click', () => onPick(skin));
    return card;
  });
}
