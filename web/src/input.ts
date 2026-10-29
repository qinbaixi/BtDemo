// 键盘和鼠标输入：移动、选目标、放技能、切换显示。

import { play, toggleMute } from './audio/engine';
import { MOVE_DIR, SKILL_KEYS } from './game/config';
import { clamp, hypot } from './game/math';
import {
  cdRemaining, headY, posOf, QUALITY_NAMES, setQuality, state, type ClientEntity, type Point, type Quality,
} from './game/state';
import type { ClientMessage, SkillInfo } from './net/types';
import type { Debug } from './ui/debug';
import { showToast } from './ui/hud';
import { bagKey, toggleBag } from './ui/bag';
import { linesKey, toggleLines } from './ui/lines';
import { pickerKey } from './ui/picker';

// 切换画质时提示每一档有什么
const QUALITY_DETAIL: Record<Quality, string> = {
  high: '描边 + 光照 + 完整泛光调色 + 热浪扭曲',
  medium: '描边 + 光照 + 简化泛光调色，粒子减半',
  low: '无着色器和动态光照',
};

export interface InputDeps {
  canvas: HTMLCanvasElement;
  send(msg: ClientMessage): void;
  debug: Debug;
}

const keys = new Set<string>();   // 按住的 KeyboardEvent.code
let lastMove = '';
let deps: InputDeps;

function currentMove(): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  for (const c of keys) {
    const d = MOVE_DIR[c];
    if (d) { dx += d[0]; dy += d[1]; }
  }
  return { dx: clamp(dx, -1, 1), dy: clamp(dy, -1, 1) };
}

function sendMove(force = false): void {
  const { dx, dy } = currentMove();
  const key = `${dx},${dy}`;
  if (!force && key === lastMove) return;
  lastMove = key;
  deps.send({ t: 'move', dx, dy });
  state.moveDx = dx;   // 自己的朝向跟着按键转，见 main.ts 的 faceInput
}

// resendMove 把当前按键状态重新发给服务端（新角色上线时）。
export function resendMove(): void {
  lastMove = '';
  sendMove(true);
  if (blocking) deps.send({ t: 'block', on: true });
}

export function castSlot(slot: number): void {
  const skill = state.skillBySlot[slot];
  if (!skill || state.pickerOpen || state.bagOpen) return;   // 挑技能时不放技能（放了就不能再换了），开着装备面板时也不放
  if (blocking) { showToast('格挡中不能出招'); play('ui.deny', { bus: 'ui' }); return; }   // 服务端也会拒绝，这里省一次来回
  const aim = skill.kind === 'dash' || skill.kind === 'line' || skill.kind === 'rain' ? aimFor(skill.kind) : { dx: 0, dy: 0 };
  deps.send({ t: 'cast', slot, target: state.target || 0, ...aim });
}

// aimFor 给闪现、飞斧和箭雨定方向：飞斧优先扔向当前目标；箭雨有目标时落在目标上
// （目标太远时服务端退回按方向落点，所以方向也朝目标发）；闪现和没有目标时朝按住的方向键，什么都没按就朝角色面向。
function aimFor(kind: string): { dx: number; dy: number } {
  const now = performance.now();
  const me = state.ents.get(state.myId);
  if (!me) return { dx: 0, dy: 0 };
  const target = state.ents.get(state.target);
  if ((kind === 'line' || kind === 'rain') && hostile(target)) {
    const from = posOf(me, now);
    const to = posOf(target, now);
    if (hypot(from.x, from.y, to.x, to.y) > 1) return { dx: to.x - from.x, dy: to.y - from.y };
  }
  const move = currentMove();
  if (move.dx !== 0 || move.dy !== 0) return move;
  return { dx: Math.cos(me.facing) < 0 ? -1 : 1, dy: 0 };
}

// rainCenter 预测箭雨会落在哪儿（和服务端一样：目标在射程内落在目标身上，否则沿瞄准方向落在 distance 处）。
export function rainCenter(skill: SkillInfo, now: number): Point | null {
  const me = state.ents.get(state.myId);
  if (!me) return null;
  const from = posOf(me, now);
  const target = state.ents.get(state.target);
  if (hostile(target)) {
    const to = posOf(target, now);
    if (hypot(from.x, from.y, to.x, to.y) <= (skill.range || 0) + (me.r || 14) + (target.r || 14)) return to;
  }
  const aim = aimFor('rain');
  const len = Math.hypot(aim.dx, aim.dy) || 1;
  const distance = skill.distance || 0;
  // 和服务端一样，落点不出地图
  return {
    x: clamp(from.x + (aim.dx / len) * distance, 0, state.map.w),
    y: clamp(from.y + (aim.dy / len) * distance, 0, state.map.h),
  };
}

// 普攻：左键点怪就打它，点空地打当前目标或身边最近的怪；按住左键会一直打。
// 冷却中、格挡中、身边没怪时什么也不发，免得服务端一直弹“冷却中”“没有有效目标”。
const ATTACK_SLOT = 1;
const ATTACK_REPEAT_MS = 100;
let attackHeld = 0;      // 按住左键时的重试定时器
let blocking = false;

function hostile(e: ClientEntity | undefined): e is ClientEntity {
  return !!e && !e.dead && e.kind === 'monster';
}

// attackTarget 选普攻的对象：当前目标够得着就打它，否则找射程内最近的怪（和服务端自动选目标的范围一样）。
function attackTarget(now: number): ClientEntity | null {
  const me = state.ents.get(state.myId);
  const sk = state.skillBySlot[ATTACK_SLOT];
  if (!me || me.dead || !sk) return null;
  const mp = posOf(me, now);
  const reach = (e: ClientEntity) => hypot(mp.x, mp.y, posOf(e, now).x, posOf(e, now).y) - (me.r || 14) - (e.r || 14);
  const range = sk.range || 0;
  const cur = state.ents.get(state.target);
  // 和服务端一样按边缘距离判断；客户端位置是插值过的，稍微收紧一点，免得发过去被判“目标太远”
  const limit = range - 2;
  if (hostile(cur) && reach(cur) <= limit) return cur;
  let best: ClientEntity | null = null;
  let bestD = Infinity;
  for (const e of state.ents.values()) {
    if (!hostile(e)) continue;
    const d = reach(e);
    if (d <= limit && d < bestD) { best = e; bestD = d; }
  }
  return best;
}

function tryAttack(): void {
  const now = performance.now();
  const sk = state.skillBySlot[ATTACK_SLOT];
  if (!sk || state.pickerOpen || state.bagOpen || blocking || cdRemaining(sk.id, now) > 0.03) return;
  const t = attackTarget(now);
  if (!t) return;
  if (t.id !== state.target) state.target = t.id;
  deps.send({ t: 'cast', slot: ATTACK_SLOT, target: t.id });
  // 先在本地记上冷却，不等下一次同步，否则按住左键时这段时间里会一直发、一直被拒
  state.cds[sk.id] = now + (sk.cooldown || 0) * 1000;
}

// forgetBlock 在换成不能格挡的职业时丢掉本地的格挡状态（服务端那边已经取消了，不用再发）。
export function forgetBlock(): void {
  blocking = false;
  state.blockHeld = false;
}

function setBlock(on: boolean): void {
  if (on && !state.canBlock) return;   // 这个职业没有盾，右键不格挡
  if (blocking === on) return;
  blocking = on;
  state.blockHeld = on;
  deps.send({ t: 'block', on });
  if (on) play('block.raise', { gain: 0.8 });
}

function stopMouse(): void {
  clearInterval(attackHeld);
  attackHeld = 0;
  setBlock(false);
}

function toWorld(ev: MouseEvent): { x: number; y: number } {
  const r = deps.canvas.getBoundingClientRect();
  // 反推 world.ts 的画面变换：以屏幕中心缩放（暴击冲击）+ 镜头冲击偏移
  const zoom = state.camZoom;
  const screenX = ev.clientX - r.left;
  const screenY = ev.clientY - r.top;
  return {
    x: (screenX - (state.cam.w / 2) * (1 - zoom)) / zoom + state.cam.x - state.camShake.x,
    y: (screenY - (state.cam.h / 2) * (1 - zoom)) / zoom + state.cam.y - state.camShake.y,
  };
}

// pickEntity 找出点中的实体。宠物不能被点选为目标，只有调试模式下能点中（用来看它的行为树）。
function pickEntity(wx: number, wy: number, now: number): ClientEntity | null {
  let best: ClientEntity | null = null;
  let bestD = Infinity;
  for (const e of state.ents.values()) {
    if (e.kind === 'pet' && !deps.debug.open) continue;
    const p = posOf(e, now);
    // 点中画出来的身体，身体在脚底位置的上方
    const half = (p.y - headY(e, p)) / 2;
    const d = hypot(p.x, p.y - half, wx, wy);
    if (d <= Math.max((e.r || 14) + 4, half) && d < bestD) { best = e; bestD = d; }
  }
  return best;
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // 在文本框里打字（协议过滤框）时不能移动或放技能
  const t = e.target;
  if (t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !['checkbox', 'button'].includes(t.type))) return;
  if (MOVE_DIR[e.code]) {
    e.preventDefault();
    if (!keys.has(e.code)) {
      keys.add(e.code);
      sendMove();
    }
    return;
  }
  if (e.repeat) return;
  if (state.pickerOpen && pickerKey(e.code)) {
    e.preventDefault();
    return;
  }
  if (state.bagOpen && bagKey(e.code)) {
    e.preventDefault();
    return;
  }
  if (state.linesOpen && linesKey(e.code)) {
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyN') {
    if (!state.pickerOpen) toggleLines();
    return;
  }
  if (e.code === 'KeyE') {
    if (!state.pickerOpen) toggleBag();   // 选技能面板开着时先选完技能
    return;
  }
  if (e.code === 'KeyM') {
    const muted = toggleMute();
    if (!muted) play('ui.toggle', { bus: 'ui' });
    showToast(muted ? '音效已关闭（按 M 打开）' : '音效已打开');
    return;
  }
  if (e.code === 'KeyG') {
    state.showAOI = !state.showAOI;
    return;
  }
  if (e.code === 'KeyQ') {
    // 高 → 中 → 低 → 高
    const next: Quality = state.quality === 'high' ? 'medium' : state.quality === 'medium' ? 'low' : 'high';
    setQuality(next);
    state.slowFrames = 0;
    state.slowGraceUntil = performance.now() + 10000;   // 给新画质 10 秒，再重新评判帧率
    showToast(`画质：${QUALITY_NAMES[next]}（${QUALITY_DETAIL[next]}）`);
    return;
  }
  if (e.code === 'KeyB') {
    state.post = !state.post;
    showToast((state.post ? '泛光和调色：开' : '泛光和调色：关') + (state.hq ? '' : '（低画质下不生效，按 Q 切到中或高画质）'));
    return;
  }
  if (e.code === 'Backquote') {
    deps.debug.toggle();
    return;
  }
  const slot = SKILL_KEYS.indexOf(e.code);
  if (slot >= 0) {
    castSlot(slot + 1);
    return;
  }
  // 数字键 1～9 也还能用
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (digit) castSlot(Number(digit[1]));
}

function onKeyUp(e: KeyboardEvent): void {
  if (MOVE_DIR[e.code]) {
    keys.delete(e.code);
    sendMove();
  }
}

function releaseKeys(): void {
  keys.clear();
  sendMove(true);
  stopMouse();
}

export function initInput(d: InputDeps): void {
  deps = d;
  const { canvas } = d;
  canvas.addEventListener('mousedown', (ev) => {
    if (ev.button === 2) {                  // 右键按住格挡
      ev.preventDefault();
      setBlock(true);
      return;
    }
    if (ev.button !== 0) return;
    // 左键：点到实体先选中它；点到的是怪就顺手打一下，按住不放会一直打
    const w = toWorld(ev);
    const hit = pickEntity(w.x, w.y, performance.now());
    if (hit && hit.kind === 'pet') {        // 调试模式下点宠物：只给 BT 面板看，不选目标、不打
      d.debug.pickPet(hit.id);
      return;
    }
    if (hit && hit.id !== state.target) {
      state.target = hit.id;
      d.send({ t: 'target', target: hit.id });
    }
    if (hit && !hostile(hit)) return;       // 点队友、NPC 只选中
    tryAttack();
    clearInterval(attackHeld);
    attackHeld = window.setInterval(tryAttack, ATTACK_REPEAT_MS);
  });
  // 松开可能发生在画布外面，所以挂在 window 上
  window.addEventListener('mouseup', (ev) => {
    if (ev.button === 0) { clearInterval(attackHeld); attackHeld = 0; }
    if (ev.button === 2) setBlock(false);
  });
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  canvas.addEventListener('mousemove', (ev) => {
    const w = toWorld(ev);
    canvas.style.cursor = pickEntity(w.x, w.y, performance.now()) ? 'pointer' : 'default';
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseKeys);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseKeys();
  });
}
