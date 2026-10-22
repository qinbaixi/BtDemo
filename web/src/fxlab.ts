// 特效实验页（地址后面加 ?fxlab）：不连服务器，摆几个假角色，按按钮播放命中、暴击、格挡、
// 击杀、技能等效果，拖滑条实时调打击感参数（config.ts 的 FEEL）和后期处理。
// 改特效时用它看效果、出预览，不用每次进游戏找怪打。

import { FEEL } from './game/config';
import { onEvent } from './game/events';
import { makeEntity, posOf, state, type ClientEntity } from './game/state';
import { loadMap } from './game/map';
import type { GameEvent } from './net/types';
import { createScenery } from './render/scenery';
import { setPostOptions } from './render/world';
import { setConn } from './ui/hud';

const ME = 1;

// 摆在自己周围的假怪物：模型、名字、相对自己的位置
const DUMMIES: { id: number; model: string; name: string; r: number; dx: number; dy: number }[] = [
  { id: 2, model: 'wolf', name: '冥狼', r: 14, dx: 70, dy: 0 },
  { id: 3, model: 'ogre_chief', name: '食人魔首领', r: 22, dx: 170, dy: -60 },
  { id: 4, model: 'skeleton_archer', name: '骷髅弓手', r: 14, dx: 220, dy: 60 },
  { id: 5, model: 'slime', name: '史莱姆', r: 12, dx: -110, dy: 50 },
];

let center = { x: 1200, y: 800 };
let walking = false;
let auto = false;

export async function startFxLab(): Promise<void> {
  setConn('ok', '特效实验页（离线）');
  let map = null;
  try {
    map = await loadMap();
  } catch {
    // 没有服务端时没有地图，用空地
  }
  state.map = map ? { w: map.w, h: map.h } : { w: 2400, h: 1600 };
  state.scenery = createScenery(state.map.w, state.map.h, map);
  // 默认放在墓地（有幽蓝的魂火，看得出角色受光）；?fxlab=camp 换到营地，?fxlab=village 换到村子
  const zone = new URLSearchParams(location.search).get('fxlab') || 'graveyard';
  const at = map?.zones[zone]?.[0] ?? map?.zones.graveyard?.[0];
  center = at ? { x: at.x - 60, y: at.y + 40 } : { x: state.map.w / 2, y: state.map.h / 2 };

  const now = performance.now();
  state.myId = ME;
  const me = makeEntity({ id: ME, kind: 'player', name: '我', model: 'knight', r: 16, lv: 10, x: center.x, y: center.y, hp: 500, maxHp: 500 }, now);
  state.ents.set(ME, me);
  for (const d of DUMMIES) {
    const e = makeEntity({
      id: d.id, kind: 'monster', name: d.name, model: d.model, r: d.r, lv: 8,
      x: center.x + d.dx, y: center.y + d.dy, hp: 300, maxHp: 300,
    }, now);
    e.facing = Math.PI;
    e.fresh = false;
    state.ents.set(d.id, e);
  }
  me.fresh = false;
  state.target = 2;
  buildPanel();
  // 跟着画面帧走（不用 setInterval），录预览时把时钟换成固定步长也能对上
  let last = 0;
  const loop = () => {
    requestAnimationFrame(loop);
    const t = performance.now();
    if (t - last >= 100) { last = t; tick(); }
  };
  requestAnimationFrame(loop);
}

// tick 模拟服务端 10Hz 同步：绕圈走、自动连打、尸体复活。
let tickN = 0;
function tick(): void {
  const now = performance.now();
  tickN++;
  const me = state.ents.get(ME)!;
  if (walking) {
    const a = tickN / 14;
    moveTo(me, center.x + Math.cos(a) * 160, center.y + Math.sin(a) * 90, now);
    me.facing = -Math.sin(a) < 0 ? Math.PI : 0;
  }
  if (auto && tickN % 5 === 0) hit(Math.random() < 0.25);
  for (const e of state.ents.values()) {
    if (e.dead && e.deadAt >= 0 && now - e.deadAt > 5000) revive(e);
  }
}

function moveTo(e: ClientEntity, x: number, y: number, now: number): void {
  const p = posOf(e, now);
  e.px = p.x;
  e.py = p.y;
  e.x = x;
  e.y = y;
  e.t0 = now;
  e.moveUntil = now + 160;
}

function target(): ClientEntity | undefined {
  let t = state.ents.get(state.target);
  if (!t || t.dead) {
    t = [...state.ents.values()].find((e) => e.id !== ME && !e.dead);
    state.target = t?.id ?? 0;
  }
  return t;
}

function emit(ev: GameEvent): void {
  onEvent(ev, performance.now());
}

function damage(e: ClientEntity, v: number): void {
  e.hp = Math.max(0, e.hp - v);
}

// hit 是自己砍目标一刀（crit 暴击）。
function hit(crit: boolean, heavy = false): void {
  const t = target();
  if (!t) return;
  const v = Math.round((crit ? 90 : 30) * (0.85 + Math.random() * 0.3));
  emit({ k: 'cast', src: ME, dst: t.id, fx: 'melee', skill: heavy ? 'heavy_strike' : 'slash', color: '#ffd166' });
  emit({ k: 'dmg', src: ME, dst: t.id, v, crit });
  damage(t, v);
  if (t.hp <= 0) kill(t);
}

function kill(e: ClientEntity): void {
  e.dead = true;
  emit({ k: 'die', id: e.id });
}

function revive(e: ClientEntity): void {
  e.dead = false;
  e.deadAt = -1;
  e.hp = e.maxHp;
  e.knockAmp = 0;
  emit({ k: 'respawn', id: e.id });
}

const ACTIONS: [string, () => void][] = [
  ['普攻', () => hit(false)],
  ['暴击', () => hit(true)],
  ['重击', () => hit(true, true)],
  ['击杀', () => { const t = target(); if (t) { emit({ k: 'cast', src: ME, dst: t.id, fx: 'melee', skill: 'heavy', color: '#ffd166' }); emit({ k: 'dmg', src: ME, dst: t.id, v: t.hp, crit: true }); damage(t, t.hp); kill(t); } }],
  ['旋风斩', () => {
    const me = posOf(state.ents.get(ME)!, performance.now());
    emit({ k: 'cast', src: ME, fx: 'circle', skill: 'whirlwind', name: '旋风斩', color: '#ff9a3c', radius: 130, x: me.x, y: me.y });
    for (const e of state.ents.values()) if (e.id !== ME && !e.dead) { const v = 45; emit({ k: 'dmg', src: ME, dst: e.id, v, crit: Math.random() < 0.3 }); damage(e, v); if (e.hp <= 0) kill(e); }
  }],
  ['被打', () => { const t = target(); const me = state.ents.get(ME)!; if (!t) return; emit({ k: 'cast', src: t.id, dst: ME, fx: 'melee', skill: 'bite', color: '#ff5a50' }); emit({ k: 'dmg', src: t.id, dst: ME, v: 40, crit: Math.random() < 0.3 }); damage(me, 40); }],
  ['格挡', () => { const t = target(); if (!t) return; emit({ k: 'cast', src: t.id, dst: ME, fx: 'melee', skill: 'smash', color: '#ff5a50' }); emit({ k: 'dmg', src: t.id, dst: ME, v: 8, blocked: 32 }); }],
  ['箭矢', () => { emit({ k: 'cast', src: 4, dst: ME, fx: 'projectile', skill: 'arrow_shot', color: '#cfe8ff' }); emit({ k: 'dmg', src: 4, dst: ME, v: 22 }); damage(state.ents.get(ME)!, 22); }],
  ['治疗', () => { const me = state.ents.get(ME)!; emit({ k: 'cast', src: ME, fx: 'heal', skill: 'heal', name: '治疗', color: '#7cff9b' }); emit({ k: 'heal', dst: ME, v: 120 }); me.hp = Math.min(me.maxHp, me.hp + 120); }],
  ['护盾', () => emit({ k: 'cast', src: ME, fx: 'shield', skill: 'shield', name: '圣盾', color: '#7fd8ff' })],
  ['升级', () => emit({ k: 'lvl', id: ME, lv: 11 })],
];

// 滑条：[标签, FEEL 字段, 最小, 最大, 步长]
const SLIDERS: [string, keyof typeof FEEL, number, number, number][] = [
  ['顿帧 ms', 'hitStopMs', 0, 200, 5],
  ['暴击顿帧 ms', 'hitStopCritMs', 0, 300, 5],
  ['镜头跟随 ms', 'camFollowMs', 0, 400, 10],
  ['镜头前瞻 px', 'camLead', 0, 160, 5],
  ['震屏倍数', 'shake', 0, 3, 0.1],
  ['暴击缩放', 'zoomPunch', 0, 0.1, 0.005],
  ['击退 px', 'knockPx', 0, 20, 1],
  ['受击形变', 'squash', 0, 0.5, 0.02],
  ['溶解延迟 ms', 'dissolveDelayMs', 0, 4000, 100],
  ['溶解时长 ms', 'dissolveMs', 200, 3000, 100],
];

function buildPanel(): void {
  const panel = document.createElement('div');
  panel.id = 'fxlab';
  panel.innerHTML = '<div class="fxlab-title">特效实验页</div>';
  const buttons = document.createElement('div');
  buttons.className = 'fxlab-buttons';
  for (const [label, fn] of ACTIONS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    buttons.appendChild(b);
  }
  const toggles: [string, (on: boolean) => void][] = [
    ['自动连打', (on) => { auto = on; }],
    ['绕圈走', (on) => { walking = on; }],
    ['低血量', (on) => { const me = state.ents.get(ME)!; me.hp = on ? me.maxHp * 0.15 : me.maxHp; }],
  ];
  for (const [label, fn] of toggles) {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = 'toggle';
    b.onclick = () => { b.classList.toggle('on'); fn(b.classList.contains('on')); };
    buttons.appendChild(b);
  }
  panel.appendChild(buttons);
  for (const [label, key, min, max, step] of SLIDERS) {
    panel.appendChild(slider(label, min, max, step, FEEL[key], (v) => { FEEL[key] = v; }));
  }
  panel.appendChild(slider('泛光强度', 0, 2, 0.05, 0.8, (v) => setPostOptions({ bloom: v })));
  panel.appendChild(slider('泛光阈值', 0.3, 1, 0.02, 0.68, (v) => setPostOptions({ threshold: v })));
  document.body.appendChild(panel);

  const style = document.createElement('style');
  style.textContent = `
#fxlab { position: fixed; top: 64px; right: 12px; z-index: 50; width: 250px; padding: 10px 12px; color: #e8dcc0;
  background: rgba(10,6,14,0.86); border: 1px solid rgba(224,178,90,0.5); font: 12px/1.4 "PingFang SC","Microsoft YaHei",sans-serif; }
#panel-self, #skillbar, #help { display: none; }
#fxlab .fxlab-title { color: #e8b65a; font-weight: bold; margin-bottom: 6px; }
#fxlab .fxlab-buttons { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
#fxlab button { background: #1d1424; color: #f3e9d2; border: 1px solid #5a4630; padding: 3px 8px; cursor: pointer; font: inherit; }
#fxlab button:hover { border-color: #e8b65a; }
#fxlab button.toggle.on { background: #5a3d12; border-color: #e8b65a; }
#fxlab label { display: grid; grid-template-columns: 82px 1fr 40px; align-items: center; gap: 4px; }
#fxlab input[type=range] { width: 100%; }
#fxlab .v { text-align: right; color: #c9b88f; font-variant-numeric: tabular-nums; }`;
  document.head.appendChild(style);
}

function slider(label: string, min: number, max: number, step: number, value: number, set: (v: number) => void): HTMLElement {
  const row = document.createElement('label');
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const out = document.createElement('span');
  out.className = 'v';
  out.textContent = String(value);
  input.oninput = () => { const v = Number(input.value); set(v); out.textContent = String(v); };
  row.append(name, input, out);
  return row;
}
