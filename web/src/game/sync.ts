// 处理服务端的帧和消息：welcome / enter / leave / state / event / self / zones / ai / toast / skills / inventory / petStatus / level，更新本地状态。

import { gameNow } from './clock';
import { forgetEntity, sfxAt } from '../feel/director';
import type { Debug } from '../ui/debug';
import { buildSkillBar, renderPetHud, renderSelf, setConn, showToast } from '../ui/hud';
import { refreshBag, renderBagStats } from '../ui/bag';
import { closePicker, openPicker } from '../ui/picker';
import { hideTravel, renderLines, renderSceneBadge, showTravel } from '../ui/lines';
import { onLevel, resetLevel } from '../ui/level';
import { rememberedSkin, rememberSkin, takePendingSkin } from '../ui/skins';
import { rememberedPet } from '../ui/bag';
import { forgetBlock } from '../input';
import { createScenery } from '../render/scenery';
import { loadMap } from './map';
import type {
  ClientMessage, EntityState, PetStatusMsg, SelfUpdate, ServerFrame, ServerMessage, SkillInfo, WelcomeMsg, ZoneInfo,
} from '../net/types';
import { ACTIONS } from '../render/knightActions';
import { ZONE_FADE_MS } from '../render/zones';
import { DEATH_MS, LERP_MS, SNAP_DIST } from './config';
import { onEvent } from './events';
import { hypot } from './math';
import { localTime, makeEntity, posOf, refreshPetNames, state, type ClientZone } from './state';

export interface SyncDeps {
  send(msg: ClientMessage): void;
  debug: Debug;
  resendMove(): void;   // 把当前按键状态告诉服务端
}

// handleFrame 处理一个 WebSocket 帧：先用帧里的服务端时间校准时钟，再按顺序处理每条消息。
export function handleFrame(frame: ServerFrame, deps: SyncDeps): void {
  const now = gameNow();
  // 偏移里含这一帧的网络延迟：取最小的那个（延迟最小的帧最接近真实偏移），每帧允许回升 1ms 以跟上时钟漂移，
  // 这样倒计时不会随网络抖动跳来跳去
  // 用真实时间校准（演出时钟慢放时会落后，混进偏移里要好几秒才回得来），换算时再减去落后的部分（localTime）
  const sample = performance.now() - frame.time * 1000;
  // 差了 2 秒以上说明服务端时钟重新开始了（服务器重启），直接重新取
  const restarted = sample - state.clockOffset > 2000;
  state.clockOffset = state.clockSynced && !restarted ? Math.min(sample, state.clockOffset + 1) : sample;
  state.clockSynced = true;
  for (const m of frame.msgs) handleMessage(m, now, deps);
}

function handleMessage(m: ServerMessage, now: number, deps: SyncDeps): void {
  switch (m.t) {
    case 'welcome': onWelcome(m, deps); break;
    case 'enter':
      for (const d of m.ents || []) {
        const old = state.ents.get(d.id);
        if (!old) {
          state.ents.set(d.id, makeEntity({ ...d, ...d.state }, now));
        } else {
          // 已存在的实体再收到 Enter：对方换了职业、外观或武器，更新模型、外观、武器、名字、颜色和半径
          if (d.model !== undefined) old.model = d.model;
          if (d.skin !== undefined) old.skin = d.skin;
          if (d.gear !== undefined) old.gear = d.gear;
          if (d.name) old.name = d.name;
          if (d.color) old.color = d.color;
          if (d.r) old.r = d.r;
          if (d.owner !== undefined) old.owner = d.owner;
          if (d.kind === 'pet') old.petName = d.name || old.petName;
        }
        if (d.id === state.myId && d.skin !== undefined && d.skin !== state.mySkin) {
          state.mySkin = d.skin;
          refreshBag();
        }
      }
      refreshPetNames();   // 宠物的名牌要等主人也在视野里才能拼上主人名
      break;
    case 'leave':
      for (const id of m.ids || []) {
        state.ents.delete(id);
        forgetEntity(id);
        state.bubbles.delete(id);
        state.lands.delete(id);
        if (id === state.target) {
          state.target = 0;
          deps.send({ t: 'target', target: 0 });
        }
      }
      break;
    case 'state': onState(m.state, now); break;
    case 'event': onEvent(m.ev, now); break;
    case 'self': onSelf(m.self, now); break;
    case 'zones': setZones(m.zones, now); break;
    case 'ai':
      deps.debug.trace(m.trace);
      state.aiPath = m.trace.path.length >= 4 ? { id: m.trace.id, pts: m.trace.path, at: now } : null;
      break;
    case 'msg': showToast(m.text); break;
    case 'skills': {
      const classChanged = !!m.playerClass && m.playerClass !== state.playerClass;
      setSkills(m.skills);
      if (m.playerClass) setPlayerClass(m.playerClass);
      if (!state.canBlock) forgetBlock();
      buildSkillBar();
      showToast('技能已更换');
      if (classChanged) {
        // 服务端换职业时把外观重置成新职业的默认；再选上面板里刚选的，没有就用这个职业上次用的
        state.mySkin = '';
        const picked = takePendingSkin(state.playerClass);
        if (picked) rememberSkin(state.playerClass, picked);
        const skin = picked || rememberedSkin(state.playerClass);
        if (skin && skin !== state.skins[0]?.id) deps.send({ t: 'skin', skin });
      }
      refreshBag();
      break;
    }
    case 'inventory':
      state.inventory = { items: m.items || [], capacity: m.capacity || 0 };
      refreshBag();
      break;
    case 'petStatus': onPetStatus(m, now); break;
    case 'lines': renderLines(m); break;
    case 'travel': showTravel(m.scene); break;
    case 'level': onLevel(m); break;
  }
}

// onPetStatus 记下自己宠物的状态：选的是哪只、实体 id、复活和换宠物冷却还剩多久。
// 冷却和复活的时刻换算成本地时间，面板上按它倒数。
function onPetStatus(m: PetStatusMsg, now: number): void {
  const changed = m.pet !== state.myPet;
  state.myPet = m.pet;
  state.petEntity = m.entity;
  state.petRespawnAt = m.respawnIn > 0 ? now + m.respawnIn * 1000 : 0;
  if (m.cooldown > 0) state.petCooldownUntil = now + m.cooldown * 1000;
  if (changed) showToast(m.pet ? `宠物：${state.pets.find((pet) => pet.id === m.pet)?.name ?? m.pet}` : '宠物已收回');
  renderPetHud();
  refreshBag();
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
  state.skins = cls?.skins ?? [];
  if (!cls) return;
  state.skillPool = cls.pool;
  state.skillPick = cls.pick;
  state.canBlock = cls.canBlock;
}

// setZones 换上服务端发来的整份回血区列表。新出现的技能法阵从施法动作按地的那一刻开始铺开；
// 刚连上时收到的（已经在那儿的）直接显示；服务端去掉的留一会儿淡出。
function setZones(zones: ZoneInfo[], now: number): void {
  const first = !zonesSeen;
  zonesSeen = true;
  const old = new Map(state.zones.map((zone) => [zone.id, zone]));
  const next: ClientZone[] = [];
  for (const info of zones) {
    const prev = old.get(info.id);
    old.delete(info.id);
    const endsAt = localTime(info.until ?? 0);
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

function onWelcome(m: WelcomeMsg, deps: SyncDeps): void {
  const prevScene = state.scene;
  state.scene = m.scene;
  // 换了场景或线：新线的时钟和原来差不多，但不保证一样，下一帧重新取时钟偏移
  if (prevScene && m.scene && (prevScene.id !== m.scene.id || prevScene.line !== m.scene.line)) state.clockSynced = false;
  hideTravel();
  renderSceneBadge();
  resetLevel();
  state.myId = m.id;
  state.map = m.map || state.map;
  state.cell = (m.aoi && m.aoi.cell) || state.cell;
  setSkills(m.skills);
  state.skillPool = m.pool || [];
  state.skillPick = m.pick || 0;
  state.classes = m.classes || [];
  state.items = new Map((m.items || []).map((item) => [item.id, item]));
  state.pets = m.pets || [];
  state.myPet = '';                                // 服务端随后发 PetStatus
  state.petEntity = 0;
  state.petRespawnAt = 0;
  state.petCooldownUntil = 0;
  state.inventory = { items: [], capacity: 0 };   // 服务端随后发 Inventory
  state.mySkin = '';                               // 以自己的 Enter 为准
  state.canBlock = true;
  setPlayerClass(m.playerClass || '');
  // welcome 里的 pool / pick 就是当前职业的，以它们为准
  state.skillPool = m.pool || [];
  state.skillPick = m.pick || 0;

  // welcome 之后服务端会把视野里的实体全部重新 Enter：旧的实体、特效全部丢掉。
  // resumed 表示还是原来的角色（重连后接不上、或者客户端跟不上时的全量），玩家自己的选择保留。
  state.ents.clear();
  state.fx!.clear();
  state.lands.clear();
  state.zones = [];
  zonesSeen = false;
  state.pending = [];
  state.floats = [];
  state.bubbles.clear();
  if (!m.resumed) {
    state.self = null;
    state.cds = {};
    state.target = 0;
  }   // resumed：自己的信息接着用，服务端随后发的全量 self 会整份覆盖
  state.hoverSlot = 0;

  loadScene().catch((err) => console.error('场景创建失败', err));
  state.obstacles = m.obstacles || [];
  state.aiPath = null;

  buildSkillBar();
  refreshBag();
  renderPetHud();
  setConn('ok', '已连接');
  deps.resendMove();
  if (m.resumed) return;

  // 新角色：
  // 服务端进游戏默认召唤第一只宠物；本地记住的选择和默认不同就发过去换上
  const remembered = rememberedPet();
  if (remembered !== null && remembered !== (state.pets[0]?.id ?? '') && state.pets.some((pet) => pet.id === remembered)) {
    deps.send({ t: 'pet', pet: remembered });
  } else if (remembered === '' && state.pets.length) {
    deps.send({ t: 'pet', pet: '' });
  }
  closePicker();
  openPicker('join');   // 新角色：先挑技能
  deps.debug.setTarget(0);
  deps.debug.reset();
}

// onState 把一个实体的增量状态合并进本地实体：只处理出现了的字段，位置出现才做插值。
// 不认识的实体（还没 Enter，或已经 Leave）直接忽略。
function onState(s: EntityState, now: number): void {
  const e = state.ents.get(s.id);
  if (!e) return;
  // 击退途中：位置以击退曲线为准（终点就是服务端的落点），途中同步来的位置先不管
  const knocked = !!e.slide?.knock && now < e.slide.at + e.slide.ms;
  if ((s.x !== undefined || s.y !== undefined) && !knocked) {
    const x = s.x ?? e.x;
    const y = s.y ?? e.y;
    const cur = posOf(e, now);
    const jump = hypot(cur.x, cur.y, x, y) > SNAP_DIST;
    const mdx = x - e.x;
    if (!jump && hypot(e.x, e.y, x, y) > 0.5) {
      e.moveUntil = now + LERP_MS * 1.6;
      // 自己按着左右键时朝向由按键决定（main.ts 的 faceInput），这里只管别人和被推动的情况
      // 格挡中的人举着盾倒退，朝向不跟着移动方向转
      const steered = (s.id === state.myId && (state.moveDx !== 0 || state.blockHeld)) || e.blocking;
      if (!steered && Math.abs(mdx) > 0.3 && now - e.attackAt > e.attackMs) e.facing = mdx < 0 ? Math.PI : 0;
    }
    if (jump) { e.rx = x; e.ry = y; }
    e.px = jump ? x : cur.x;
    e.py = jump ? y : cur.y;
    e.x = x;
    e.y = y;
    e.t0 = now;
  }
  if (s.dead !== undefined) {
    if (s.dead && !e.dead) e.deadAt = e.fresh ? now - DEATH_MS : now;
    if (!s.dead) e.deadAt = -1;
    e.dead = s.dead;
    if (e.dead) { e.blocking = false; e.looks = 0; }
  }
  if (s.hp !== undefined) e.hp = s.hp;
  if (s.maxHp !== undefined) e.maxHp = s.maxHp;
  if (s.lv !== undefined) e.lv = s.lv;
  if (s.act !== undefined) e.act = s.act;
  if (s.tg !== undefined) e.tg = s.tg;
  if (s.shield !== undefined) {
    if (s.shield > e.shield) e.shieldMax = s.shield;          // 新加了一层护盾
    else if (s.shield <= 0 && e.shield > 0 && !e.dead) {
      state.fx?.shieldBreak(e.id, now);
      sfxAt('shield.break', e.id, now);
    }
    e.shield = s.shield;
  }
  if (s.blocking !== undefined) e.blocking = s.blocking && !e.dead;
  if (s.looks !== undefined) e.looks = e.dead ? 0 : s.looks;
  if (s.guard !== undefined && s.guard !== e.guard) { e.guard = s.guard; e.guardAt = now; }
  e.fresh = false;
}

// onSelf 把自己的增量信息合并进 state.self。时间点（冷却结束、Buff 结束、复活）用服务端时钟，这里换成本地时间。
function onSelf(u: SelfUpdate, now: number): void {
  const prev = state.self;
  const merged = prev ?? { lv: 1, exp: 0, next: 0, hp: 0, buffs: [], dead: false, respawnAt: 0 };
  if (u.lv !== undefined) merged.lv = u.lv;
  if (u.exp !== undefined) merged.exp = u.exp;
  if (u.next !== undefined) merged.next = u.next;
  if (u.hp !== undefined) merged.hp = u.hp;
  if (u.base) merged.base = u.base;
  if (u.attr) merged.attr = u.attr;
  if (u.buffs) merged.buffs = u.buffs.map((b) => ({ name: b.name, endsAt: localTime(b.until) }));
  if (u.cds) {
    state.cds = {};
    for (const c of u.cds) state.cds[c.skill] = localTime(c.readyAt);
  }
  if (u.respawnAt !== undefined) merged.respawnAt = localTime(u.respawnAt);
  const wasDead = !!prev?.dead;
  if (u.dead !== undefined) merged.dead = u.dead;
  state.self = merged;
  // 刚死：弹出选技能面板，复活后用新技能
  if (merged.dead && !wasDead) openPicker('death');
  renderSelf();
  renderBagStats();
}

// loadScene 下载地图并建场景。每次 welcome 都重新下载（服务端可能换了地图），
// 内容没变就不重画。第一次下载完成前画面只有角色，没有地表；下载失败时保留原来的场景。
let sceneLoad = 0;
async function loadScene(): Promise<void> {
  const seq = ++sceneLoad;
  const { w, h } = state.map;
  let map = null;
  try {
    map = await loadMap(state.scene?.map);
  } catch (err) {
    console.error('地图加载失败', err);
    showToast('地图加载失败，刷新页面重试');
    if (state.scenery) return;
  }
  if (seq !== sceneLoad) return;   // 期间又收到了新的 welcome
  const key = `${state.scene?.id ?? ''}:${w}x${h}:${map?.key ?? ''}`;
  if (state.scenery && state.sceneKey === key) return;
  state.scenery = createScenery(w, h, map);
  state.sceneKey = key;
}
