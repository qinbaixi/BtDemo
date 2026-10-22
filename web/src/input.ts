// 键盘和鼠标输入：移动、选目标、放技能、切换显示。

import { MOVE_DIR } from './game/config';
import { clamp, hypot } from './game/math';
import { cdRemaining, headY, posOf, state, type ClientEntity } from './game/state';
import type { ClientMessage } from './net/types';
import type { Debug } from './ui/debug';
import { showToast } from './ui/hud';

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
  if (!state.skillBySlot[slot]) return;
  if (blocking) { showToast('格挡中不能出招'); return; }   // 服务端也会拒绝，这里省一次来回
  deps.send({ t: 'cast', slot, target: state.target || 0 });
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
  if (!sk || blocking || cdRemaining(sk.id, now) > 0.03) return;
  const t = attackTarget(now);
  if (!t) return;
  if (t.id !== state.target) state.target = t.id;
  deps.send({ t: 'cast', slot: ATTACK_SLOT, target: t.id });
  // 先在本地记上冷却，不等下一次同步，否则按住左键时这段时间里会一直发、一直被拒
  state.cds[sk.id] = (sk.cooldown || 0) + (now - state.cdsAt) / 1000;
}

function setBlock(on: boolean): void {
  if (blocking === on) return;
  blocking = on;
  state.blockHeld = on;
  deps.send({ t: 'block', on });
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

function pickEntity(wx: number, wy: number, now: number): ClientEntity | null {
  let best: ClientEntity | null = null;
  let bestD = Infinity;
  for (const e of state.ents.values()) {
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
  if (e.code === 'KeyG') {
    state.showAOI = !state.showAOI;
    return;
  }
  if (e.code === 'KeyQ') {
    state.hq = !state.hq;
    state.slowFrames = 0;
    state.slowGraceUntil = performance.now() + 10000;   // 给完整画质 10 秒，再重新评判帧率
    showToast(state.hq ? '画质：完整（描边 + 光照 + 泛光调色）' : '画质：简化');
    return;
  }
  if (e.code === 'KeyB') {
    state.post = !state.post;
    showToast((state.post ? '泛光和调色：开' : '泛光和调色：关') + (state.hq ? '' : '（简化画质下不生效，按 Q 切回完整画质）'));
    return;
  }
  if (e.code === 'Backquote') {
    deps.debug.toggle();
    return;
  }
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (m) castSlot(Number(m[1]));
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
