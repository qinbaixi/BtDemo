// BtDemo 浏览器客户端入口：把各模块接起来，跑每帧的主循环。
//
//   net/      协议编解码（protobuf 生成代码）和 WebSocket 连接
//   game/     本地状态、服务端消息处理、事件
//   render/   画世界：Pixi（WebGL）画地表、物件、角色、光照，叠加的 2D 画布画特效和文字
//   ui/       HUD 和调试面板（DOM）
//   feel/     打击感：命中分档、顿帧、镜头、命中声的调度
//   audio/    音效：引擎（总线、声像、并发限制）和程序化合成配方
//   input.ts  键盘鼠标

import { updateAmbience } from './audio/ambience';
import { gameNow, tickClock } from './game/clock';
import './styles/style.css';
import './styles/debug.css';
import './styles/debug-proto.css';

import { faceToward, fxAuras, fxResolve, posOf, QUALITY_NAMES, setQuality, state } from './game/state';
import { handleFrame } from './game/sync';
import { initAudio } from './audio/engine';
import { castSlot, initInput, resendMove } from './input';
import { createConnection } from './net/connection';
import { createProtocol } from './net/protocol';
import { loadArt } from './render/art';
import { FX } from './render/fx';
import { updateCamera } from './render/camera';
import { drawWorld, initWorld, resize } from './render/world';
import { createDebug } from './ui/debug';
import {
  initHud, renderBuffTimes, renderDeath, renderSkillBar, renderTarget, setConn, showToast,
} from './ui/hud';
import { initBag } from './ui/bag';
import { initSettingsPanel } from './ui/settings';
import { initPicker } from './ui/picker';
import { initLines } from './ui/lines';
import { initBossBar, renderBossBar } from './ui/boss';
import { initLevel, renderLevelHud } from './ui/level';

declare global {
  interface Window {
    btdemo: {
      state: typeof state;
      debug?: typeof debug;
      bake?: () => Promise<unknown>;
      sfxbake?: (overrides?: Record<string, string[]>) => Promise<unknown>;
    };
  }
}

const canvas = document.getElementById('game') as HTMLCanvasElement;
const protocol = createProtocol();
const conn = createConnection(protocol, {
  onFrame: (frame) => handleFrame(frame, { send: conn.send, debug, resendMove }),
  onStatus: setConn,   // 断线时画面停在原处，重连后服务端接着发（或发全量）
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
  if (me && state.moveDx !== 0 && now - me.attackAt > me.attackMs) me.facing = state.moveDx < 0 ? Math.PI : 0;
}

function frame(): void {
  requestAnimationFrame(frame);
  tickClock();
  const now = gameNow();
  const dt = state.lastFrame ? now - state.lastFrame : 16;
  state.lastFrame = now;
  watchFrameRate(realFrameMs());
  runPending(now);
  faceInput(now);
  debug.setTarget(state.target);
  debug.update(now);
  updateCamera(now, dt);
  drawWorld(now, dt, debug.open);
  updateAmbience(now, dt);
  renderTarget();
  renderSkillBar(now);
  renderDeath(now);
  renderBuffTimes(now);
  renderLevelHud();
  renderBossBar(dt);
}

// realFrameMs 是这一帧的真实时长（帧率监测要真实时间：慢放、暂停时演出时钟的 dt 不准）。
let lastRealFrame = 0;
function realFrameMs(): number {
  const real = performance.now();
  const ms = lastRealFrame ? real - lastRealFrame : 16;
  lastRealFrame = real;
  return ms;
}

// watchFrameRate 在约 3 秒低于约 30fps 后降一档画质（高 → 中 → 低），降完给 5 秒再评判。
function watchFrameRate(dt: number): void {
  if (state.quality === 'low' || document.hidden || performance.now() < state.slowGraceUntil) return;
  state.slowFrames = dt > 34 && dt < 500 ? state.slowFrames + 1 : Math.max(0, state.slowFrames - 2);
  if (state.slowFrames > 90) {
    const lower = state.quality === 'high' ? 'medium' : 'low';
    setQuality(lower);
    state.slowFrames = 0;
    state.slowGraceUntil = performance.now() + 5000;
    showToast(`帧率偏低，已降到${QUALITY_NAMES[lower]}画质（按 Q 切换）`);
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
  const params = new URLSearchParams(location.search);
  // ?sfxbake：音效烘焙（tools/sfxbake 用无头浏览器调用，见 audio/bake.ts），不建游戏画面
  if (params.has('sfxbake')) {
    window.btdemo = { state, sfxbake: async (overrides) => (await import('./audio/bake')).sfxBake(overrides) };
    return;
  }
  // ?sfxlab：调音页，试听全部声音、对比烘焙版和实时版、调音量音高（见 sfxlab.ts），不建游戏画面
  if (params.has('sfxlab')) {
    (await import('./sfxlab')).startSfxLab();
    return;
  }
  initHud(castSlot);
  initPicker(conn.send);
  initBag(conn.send);
  initSettingsPanel();
  initLines(conn.send);
  initLevel();
  initBossBar();
  await loadArt();   // 美术资源要在建场景、建角色之前就绪
  await initWorld(canvas, document.getElementById('overlay') as HTMLCanvasElement);
  state.fx = new FX(fxResolve, fxAuras);
  window.btdemo = { state, debug };   // 方便在浏览器控制台里查看
  // ?bake：挂上美术模板导出工具（见 render/bake.ts），按需加载，不进正常游戏的主包
  if (new URLSearchParams(location.search).has('bake')) {
    window.btdemo.bake = async () => (await import('./render/bake')).bakeAll();
  }
  window.addEventListener('resize', resize);
  initInput({ canvas, send: conn.send, debug });
  initAudio();   // 第一次按键或点击时才真正打开声音（浏览器的自动播放限制）
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
