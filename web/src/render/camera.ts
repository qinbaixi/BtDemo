// 镜头：平滑跟随自己、朝移动方向多看一点，加上三种冲击：
//   1. 方向冲击（kick）：被打或打中别人时，画面沿受击方向弹一下再回来（阻尼弹簧），
//   2. 震动（trauma）：大范围技能时的晃动，用平滑噪声而不是每帧随机跳，看起来不发抖，
//   3. 缩放冲击（punch）：暴击时画面放大一点再弹回。
// 所有强度都乘 FEEL 里的参数（?fxlab 可调）和玩家设置里的震屏强度（game/settings.ts）。

import { FEEL, LERP_MS } from '../game/config';
import { clamp } from '../game/math';
import { SETTINGS } from '../game/settings';
import { posOf, state, type Point } from '../game/state';

const SNAP = 500;            // 目标点一下跳得比这远（复活、传送）就直接切过去

const cam = {
  x: 0, y: 0,                // 平滑后的镜头中心（世界坐标）
  leadX: 0, leadY: 0,        // 当前的前瞻偏移
  ready: false,
  kickX: 0, kickY: 0,        // 方向冲击：弹簧位移和速度
  kickVx: 0, kickVy: 0,
  zoom: 0,                   // 缩放冲击：当前多放大的比例
  zoomV: 0,
  seed: Math.random() * 100,
};

// kick 让镜头沿 (dx, dy) 方向被推一下，strength 是像素。
export function cameraKick(dx: number, dy: number, strength: number): void {
  const len = Math.hypot(dx, dy) || 1;
  const s = strength * FEEL.shake * SETTINGS.shake;
  // 给速度而不是直接给位移：画面先被推出去再弹回来，更像被撞了一下
  cam.kickVx += (dx / len) * s * 0.06;
  cam.kickVy += (dy / len) * s * 0.06;
}

// cameraPunch 让画面瞬间放大 amount（比例），然后弹回。
export function cameraPunch(amount: number): void {
  cam.zoomV += amount * 0.1 * SETTINGS.shake;
}

// updateCamera 每帧调用：算出这一帧的镜头矩形 state.cam（已对齐到设备像素）、
// 冲击偏移 state.camShake 和缩放 state.camZoom。
export function updateCamera(now: number, dt: number): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { w, h } = state.map;
  const me = state.ents.get(state.myId);
  const step = Math.min(dt, 50);

  // 跟随目标：自己的位置 + 朝移动方向的前瞻
  let tx = w / 2;
  let ty = h / 2;
  if (me) {
    const p = posOf(me, now);
    tx = p.x;
    ty = p.y - 20;
    // 速度用本次插值的位移估算（服务端 10Hz 同步，一次插值 LERP_MS）
    const moving = now < me.moveUntil && !me.dead;
    const vx = moving ? (me.x - me.px) / LERP_MS : 0;
    const vy = moving ? (me.y - me.py) / LERP_MS : 0;
    const sp = Math.hypot(vx, vy);
    const wantX = sp > 0.01 ? (vx / sp) * FEEL.camLead : 0;
    const wantY = sp > 0.01 ? (vy / sp) * FEEL.camLead * 0.6 : 0;
    const kl = 1 - Math.exp(-step / 450);   // 前瞻慢慢移过去，急转身时镜头不会猛甩
    cam.leadX += (wantX - cam.leadX) * kl;
    cam.leadY += (wantY - cam.leadY) * kl;
    tx += cam.leadX;
    ty += cam.leadY;
  }
  if (!cam.ready || Math.hypot(tx - cam.x, ty - cam.y) > SNAP) {
    cam.x = tx;
    cam.y = ty;
    cam.ready = true;
  } else {
    const k = 1 - Math.exp(-step / Math.max(1, FEEL.camFollowMs));
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
  }

  // 地图比屏幕小就居中，否则夹在地图范围内
  let x = w <= vw ? (w - vw) / 2 : clamp(cam.x - vw / 2, 0, w - vw);
  let y = h <= vh ? (h - vh) / 2 : clamp(cam.y - vh / 2, 0, h - vh);
  const dpr = state.dpr;
  x = Math.round(x * dpr) / dpr;
  y = Math.round(y * dpr) / dpr;
  state.cam = { x, y, w: vw, h: vh };

  state.camShake = shakeOffset(now, step);
  state.camZoom = 1 + zoomStep(step);
}

// shakeOffset 推进方向冲击的弹簧，叠加大招的平滑震动，返回这一帧的画面偏移。
function shakeOffset(now: number, step: number): Point {
  // 阻尼弹簧：一次来回约 120ms，阻尼比约 0.4，弹一两下就停
  const stiff = 0.0028;
  const damp = 0.04;
  for (let t = 0; t < step; t += 4) {
    const d = Math.min(4, step - t);
    cam.kickVx += (-stiff * cam.kickX - damp * cam.kickVx) * d;
    cam.kickVy += (-stiff * cam.kickY - damp * cam.kickVy) * d;
    cam.kickX += cam.kickVx * d;
    cam.kickY += cam.kickVy * d;
  }
  let x = cam.kickX;
  let y = cam.kickY;

  // 大范围技能的震动：fx.shake 是强度（像素），这里按时间衰减并用几个正弦叠出平滑的噪声
  const fx = state.fx;
  if (fx && fx.shake > 0.2) {
    const s = fx.shake * FEEL.shake * SETTINGS.shake;
    const t = now / 1000;
    x += s * (Math.sin(t * 47 + cam.seed) * 0.6 + Math.sin(t * 83 + cam.seed * 2) * 0.4);
    y += s * (Math.sin(t * 53 + cam.seed * 3) * 0.6 + Math.sin(t * 71 + cam.seed * 5) * 0.4);
    fx.shake *= Math.pow(0.0025, step / 1000);
  } else if (fx) {
    fx.shake = 0;
  }
  return { x, y };
}

// zoomStep 推进缩放冲击的弹簧，返回当前多放大的比例。
function zoomStep(step: number): number {
  for (let t = 0; t < step; t += 4) {
    const d = Math.min(4, step - t);
    cam.zoomV += (-0.004 * cam.zoom - 0.06 * cam.zoomV) * d;
    cam.zoom += cam.zoomV * d;
  }
  // 不缩小：缩小会在屏幕边缘露出画面外的背景
  return Math.max(0, Math.min(0.08, cam.zoom));
}
