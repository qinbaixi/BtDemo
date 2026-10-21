// 键盘和鼠标输入：移动、选目标、放技能、切换显示。

import { MOVE_DIR } from './game/config';
import { clamp, hypot } from './game/math';
import { headY, posOf, state, type ClientEntity } from './game/state';
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
}

// resendMove 把当前按键状态重新发给服务端（新角色上线时）。
export function resendMove(): void {
  lastMove = '';
  sendMove(true);
}

export function castSlot(slot: number): void {
  if (!state.skillBySlot[slot]) return;
  deps.send({ t: 'cast', slot, target: state.target || 0 });
}

function toWorld(ev: MouseEvent): { x: number; y: number } {
  const r = deps.canvas.getBoundingClientRect();
  return { x: ev.clientX - r.left + state.cam.x, y: ev.clientY - r.top + state.cam.y };
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
    showToast(state.post ? '泛光和调色：开' : '泛光和调色：关');
    return;
  }
  if (e.code === 'Backquote') {
    deps.debug.toggle();
    return;
  }
  const m = /^(?:Digit|Numpad)([1-5])$/.exec(e.code);
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
}

export function initInput(d: InputDeps): void {
  deps = d;
  const { canvas } = d;
  canvas.addEventListener('click', (ev) => {
    const w = toWorld(ev);
    const hit = pickEntity(w.x, w.y, performance.now());
    if (!hit) return;                       // 点空地什么也不做
    state.target = hit.id;
    d.send({ t: 'target', target: hit.id });
  });
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
