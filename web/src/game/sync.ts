// 处理服务端消息：welcome / enter / leave / sync / toast / skills，更新本地状态。

import type { Debug } from '../ui/debug';
import { buildSkillBar, renderSelf, setConn, showToast } from '../ui/hud';
import { closePicker, openPicker } from '../ui/picker';
import { forgetBlock } from '../input';
import { createScenery } from '../render/scenery';
import { loadMap } from './map';
import type { ClientMessage, ServerMessage, SkillInfo, SyncMsg, WelcomeMsg, ZoneInfo } from '../net/types';
import { ACTIONS } from '../render/knightActions';
import { ZONE_FADE_MS } from '../render/zones';
import { DEATH_MS, LERP_MS, SNAP_DIST } from './config';
import { onEvent } from './events';
import { hypot } from './math';
import { makeEntity, posOf, state, type ClientZone } from './state';

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
        const old = state.ents.get(d.id);
        if (!old) {
          state.ents.set(d.id, makeEntity(d, now));
        } else {
          // 已存在的实体再收到 Enter：对方换了职业，更新模型、名字、颜色和半径
          if (d.model !== undefined) old.model = d.model;
          if (d.name) old.name = d.name;
          if (d.color) old.color = d.color;
          if (d.r) old.r = d.r;
        }
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
      if (m.playerClass) setPlayerClass(m.playerClass);
      if (!state.canBlock) forgetBlock();
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

// setPlayerClass 记下当前职业，并把技能池、要挑的个数、能否格挡换成该职业的。
function setPlayerClass(id: string): void {
  state.playerClass = id;
  const cls = state.classes.find((c) => c.id === id);
  if (!cls) return;
  state.skillPool = cls.pool;
  state.skillPick = cls.pick;
  state.canBlock = cls.canBlock;
}

// setZones 换上服务端发来的整份回血区列表。新出现的技能法阵从施法动作按地的那一刻开始铺开；
// 刚连上时收到的（已经在那儿的）直接显示；服务端去掉的留一会儿淡出。
function setZones(zones: ZoneInfo[], serverTime: number, now: number): void {
  const first = !zonesSeen;
  zonesSeen = true;
  const old = new Map(state.zones.map((zone) => [zone.id, zone]));
  const next: ClientZone[] = [];
  for (const info of zones) {
    const prev = old.get(info.id);
    old.delete(info.id);
    const endsAt = info.until ? now + (info.until - serverTime) * 1000 : 0;
    let born = prev ? prev.born : now;
    if (!prev && first) born = now - 10000;
    else if (!prev) {
      // 施法者在放“治愈之泉”的动作：等手按到地上
      const caster = info.owner ? state.ents.get(info.owner) : undefined;
      if (caster && caster.action === 'zone') born = Math.max(now, caster.attackAt + (ACTIONS.zone?.lead ?? 0));
    }
    next.push({
      ...info, born, endsAt, goneAt: 0,
      pulseFrom: prev ? prev.pulseFrom : now,
      seed: prev ? prev.seed : Math.random() * 100,
    });
  }
  // 被替换或到时间的：淡出（已经在淡出的继续）
  for (const zone of old.values()) {
    if (!zone.goneAt) zone.goneAt = now;
    if (now - zone.goneAt < ZONE_FADE_MS) next.push(zone);
  }
  state.zones = next;
}

// 是否已经收到过回血区列表（第一次收到的直接显示，不播铺开动画）
let zonesSeen = false;

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
  state.classes = m.classes || [];
  state.canBlock = true;
  setPlayerClass(m.playerClass || '');
  // welcome 里的 pool / pick 就是当前职业的，以它们为准
  state.skillPool = m.pool || [];
  state.skillPick = m.pick || 0;

  // welcome 表示一个全新的角色：旧角色的东西全部丢掉。
  state.ents.clear();
  state.fx!.clear();
  state.lands.clear();
  state.zones = [];
  zonesSeen = false;
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
  if (m.zones) setZones(m.zones, m.time, now);
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
