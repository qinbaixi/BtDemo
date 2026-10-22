// 处理服务端消息：welcome / enter / leave / sync / toast / skills，更新本地状态。

import type { Debug } from '../ui/debug';
import { buildSkillBar, renderSelf, setConn, showToast } from '../ui/hud';
import { closePicker, openPicker } from '../ui/picker';
import { createScenery } from '../render/scenery';
import { loadMap } from './map';
import type { ClientMessage, ServerMessage, SkillInfo, SyncMsg, WelcomeMsg } from '../net/types';
import { DEATH_MS, LERP_MS, SNAP_DIST } from './config';
import { onEvent } from './events';
import { hypot } from './math';
import { makeEntity, posOf, state } from './state';

export interface SyncDeps {
  send(msg: ClientMessage): void;
  debug: Debug;
  resendMove(): void;   // 把当前按键状态告诉服务端
}

export function handleMessage(m: ServerMessage, deps: SyncDeps): void {
  const now = performance.now();
  switch (m.t) {
    case 'welcome': onWelcome(m, deps); break;
    case 'enter':
      for (const d of m.ents || []) {
        if (!state.ents.has(d.id)) state.ents.set(d.id, makeEntity(d, now));
      }
      break;
    case 'leave':
      for (const id of m.ids || []) {
        state.ents.delete(id);
        state.bubbles.delete(id);
        state.lands.delete(id);
        if (id === state.target) {
          state.target = 0;
          deps.send({ t: 'target', target: 0 });
        }
      }
      break;
    case 'sync': onSync(m, now, deps); break;
    case 'msg': showToast(m.text); break;
    case 'skills':
      setSkills(m.skills);
      buildSkillBar();
      showToast('技能已更换');
      break;
  }
}

// setSkills 换上一套技能栏。
function setSkills(skills: SkillInfo[]): void {
  state.skills = (skills || []).slice().sort((a, b) => a.slot - b.slot);
  state.skillBySlot = {};
  for (const sk of state.skills) state.skillBySlot[sk.slot] = sk;
}

// resetOnClose 在连接断开时清掉旧角色的状态。
export function resetOnClose(): void {
  closePicker();
  state.ents.clear();
  state.self = null;
  state.target = 0;
}

function onWelcome(m: WelcomeMsg, deps: SyncDeps): void {
  state.myId = m.id;
  state.map = m.map || state.map;
  state.cell = (m.aoi && m.aoi.cell) || state.cell;
  setSkills(m.skills);
  state.skillPool = m.pool || [];
  state.skillPick = m.pick || 0;

  // welcome 表示一个全新的角色：旧角色的东西全部丢掉。
  state.ents.clear();
  state.fx!.clear();
  state.lands.clear();
  state.pending = [];
  state.floats = [];
  state.bubbles.clear();
  state.self = null;
  state.cds = {};
  state.target = 0;
  state.hoverSlot = 0;

  loadScene().catch((err) => console.error('场景创建失败', err));
  state.obstacles = m.obstacles || [];
  state.aiPath = null;

  buildSkillBar();
  closePicker();
  openPicker('join');   // 新角色：先挑技能
  deps.debug.setTarget(0);
  deps.debug.reset();
  setConn('ok', '已连接');
  deps.resendMove();
}

function onSync(m: SyncMsg, now: number, deps: SyncDeps): void {
  for (const s of m.ents || []) {
    let e = state.ents.get(s.id);
    if (!e && s.id === state.myId) {
      e = makeEntity({ id: s.id, kind: 'player', name: '我', r: 16, x: s.x, y: s.y }, now);
      state.ents.set(s.id, e);
    }
    if (!e) continue;
    const cur = posOf(e, now);
    const jump = hypot(cur.x, cur.y, s.x, s.y) > SNAP_DIST;
    const mdx = s.x - e.x;
    if (!jump && hypot(e.x, e.y, s.x, s.y) > 0.5) {
      e.moveUntil = now + LERP_MS * 1.6;
      // 自己按着左右键时朝向由按键决定（main.ts 的 faceInput），这里只管别人和被推动的情况
      // 格挡中的人举着盾倒退，朝向不跟着移动方向转
      const steered = (s.id === state.myId && (state.moveDx !== 0 || state.blockHeld)) || e.blocking;
      if (!steered && Math.abs(mdx) > 0.3 && now - e.attackAt > e.attackMs) e.facing = mdx < 0 ? Math.PI : 0;
    }
    if (jump) { e.rx = s.x; e.ry = s.y; }
    if (s.dead && !e.dead) e.deadAt = e.fresh ? now - DEATH_MS : now;
    if (!s.dead) e.deadAt = -1;
    e.px = jump ? s.x : cur.x;
    e.py = jump ? s.y : cur.y;
    e.x = s.x;
    e.y = s.y;
    e.t0 = now;
    e.hp = s.hp;
    e.maxHp = s.maxHp;
    e.lv = s.lv;
    e.act = s.act || '';
    e.tg = s.tg || 0;
    e.dead = !!s.dead;
    const shield = s.shield || 0;
    if (shield > e.shield) e.shieldMax = shield;          // 新加了一层护盾
    else if (shield <= 0 && e.shield > 0 && !e.dead) state.fx?.shieldBreak(e.id, performance.now());
    e.shield = shield;
    e.blocking = !!s.blocking && !e.dead;
    e.looks = e.dead ? 0 : s.looks || 0;
    e.fresh = false;
  }
  if (m.self) {
    // 刚死：弹出选技能面板，复活后用新技能
    if (m.self.dead && !state.self?.dead) openPicker('death');
    state.self = m.self;
    state.selfAt = now;
    state.cds = m.self.cds || {};
    state.cdsAt = now;
    renderSelf();
  }
  for (const ev of m.ev || []) onEvent(ev, now);
  if (m.ai) {
    deps.debug.trace(m.ai);
    state.aiPath = m.ai.path.length >= 4 ? { id: m.ai.id, pts: m.ai.path, at: now } : null;
  }
}

// loadScene 下载地图并建场景。每次 welcome 都重新下载（服务端可能换了地图），
// 内容没变就不重画。第一次下载完成前画面只有角色，没有地表；下载失败时保留原来的场景。
let sceneLoad = 0;
async function loadScene(): Promise<void> {
  const seq = ++sceneLoad;
  const { w, h } = state.map;
  let map = null;
  try {
    map = await loadMap();
  } catch (err) {
    console.error('地图加载失败', err);
    showToast('地图加载失败，刷新页面重试');
    if (state.scenery) return;
  }
  if (seq !== sceneLoad) return;   // 期间又收到了新的 welcome
  const key = `${w}x${h}:${map?.key ?? ''}`;
  if (state.scenery && state.sceneKey === key) return;
  state.scenery = createScenery(w, h, map);
  state.sceneKey = key;
}
