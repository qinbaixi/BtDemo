// BtDemo 浏览器客户端入口：把各模块接起来，跑每帧的主循环。
//
//   net/      协议编解码（protobuf 生成代码）和 WebSocket 连接
//   game/     本地状态、服务端消息处理、事件
//   render/   画世界：Pixi（WebGL）画地表、物件、角色、光照，叠加的 2D 画布画特效和文字
//   ui/       HUD 和调试面板（DOM）
//   input.ts  键盘鼠标

import './styles/style.css';
import './styles/debug.css';
import './styles/debug-proto.css';

import { ATTACK_MS } from './game/config';
import { faceToward, fxAuras, fxResolve, posOf, state } from './game/state';
import { handleMessage, resetOnClose } from './game/sync';
import { castSlot, initInput, resendMove } from './input';
import { createConnection } from './net/connection';
import { createProtocol } from './net/protocol';
import { loadArt } from './render/art';
import { FX } from './render/fx';
import { updateCamera } from './render/camera';
import { drawWorld, initWorld, resize } from './render/world';
import { createDebug } from './ui/debug';
import {
  initHud, renderDeath, renderSkillBar, renderTarget, setConn, showToast,
} from './ui/hud';

declare global {
  interface Window { btdemo: { state: typeof state; bake?: () => Promise<unknown> } }
}

const canvas = document.getElementById('game') as HTMLCanvasElement;
const protocol = createProtocol();
const conn = createConnection(protocol, {
  onMessage: (m) => handleMessage(m, { send: conn.send, debug, resendMove }),
  onStatus: setConn,
  onClose: resetOnClose,
});
const debug = createDebug({ send: conn.send, entity: (id: number) => state.ents.get(id) });
protocol.tap = (dir, type, bytes, obj) => debug.frame(dir, type, bytes, obj);

// faceInput 让自己的角色朝向按住的左右键，不等服务端位置回来；攻击动作期间先朝着目标，
// 动作结束后再转回按键方向（被墙挡住走不动时也一样）。
function faceInput(now: number): void {
  const me = state.ents.get(state.myId);
  if (me && state.blockHeld) {
    // 格挡时盾牌一直朝着目标（没有目标就保持按下右键时的朝向），往后退也不转身
    const t = state.ents.get(state.target);
    if (t && !t.dead && t.kind === 'monster') faceToward(me, posOf(t, now).x, posOf(t, now).y, now);
    return;
  }
  if (me && state.moveDx !== 0 && now - me.attackAt > ATTACK_MS) me.facing = state.moveDx < 0 ? Math.PI : 0;
}

function frame(): void {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = state.lastFrame ? now - state.lastFrame : 16;
  state.lastFrame = now;
  watchFrameRate(dt);
  runPending(now);
  faceInput(now);
  debug.setTarget(state.target);
  debug.update(now);
  updateCamera(now, dt);
  drawWorld(now, dt, debug.open);
  renderTarget();
  renderSkillBar(now);
  renderDeath(now);
}

// watchFrameRate 在约 3 秒低于约 30fps 后切到简化画质。
function watchFrameRate(dt: number): void {
  if (!state.hq || document.hidden || performance.now() < state.slowGraceUntil) return;
  state.slowFrames = dt > 34 && dt < 500 ? state.slowFrames + 1 : Math.max(0, state.slowFrames - 2);
  if (state.slowFrames > 90) {
    state.hq = false;
    showToast('帧率偏低，已切换为简化画质（按 Q 切回）');
  }
}

// runPending 播放到时间的受击（等弹道飞到目标）。
function runPending(now: number): void {
  if (!state.pending.length) return;
  const due = state.pending.filter((p) => p.at <= now);
  if (!due.length) return;
  state.pending = state.pending.filter((p) => p.at > now);
  for (const p of due) p.fn();
}

async function init(): Promise<void> {
  initHud(castSlot);
  await loadArt();   // 美术资源要在建场景、建角色之前就绪
  await initWorld(canvas, document.getElementById('overlay') as HTMLCanvasElement);
  state.fx = new FX(fxResolve, fxAuras);
  window.btdemo = { state };   // 方便在浏览器控制台里查看
  // ?bake：挂上美术模板导出工具（见 render/bake.ts），按需加载，不进正常游戏的主包
  if (new URLSearchParams(location.search).has('bake')) {
    window.btdemo.bake = async () => (await import('./render/bake')).bakeAll();
  }
  window.addEventListener('resize', resize);
  initInput({ canvas, send: conn.send, debug });
  requestAnimationFrame(frame);
  // ?fxlab：特效实验页，不连服务器，用假角色播放各种打击和技能效果（见 fxlab.ts）
  if (new URLSearchParams(location.search).has('fxlab')) {
    (await import('./fxlab')).startFxLab();
    return;
  }
  conn.connect();
}

init().catch((err) => {
  console.error(err);
  setConn('bad', '画面初始化失败（需要 WebGL）');
});
