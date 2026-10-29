// 特效实验页（地址后面加 ?fxlab）：不连服务器，摆几个假角色，按按钮播放命中、暴击、格挡、
// 击杀、技能等效果，拖滑条实时调打击感参数（feel/profiles.ts 的档位表、config.ts 的 FEEL）和后期处理，
// 试听所有音效（audio/recipes.ts）。
// 改特效时用它看效果、出预览，不用每次进游戏找怪打。

import { getVolume, play, setVolume } from './audio/engine';
import { MATERIALS, RECIPES, TIERS, WEAPONS } from './audio/recipes';
import { PROFILES, type Profile, type ProfileName } from './feel/profiles';
import { FEEL, LOOK_FIRE, LOOK_FROST, LOOK_HASTE, LOOK_HOLY, ZONE_ASPECT } from './game/config';
import { onEvent } from './game/events';
import { makeEntity, posOf, state, type ClientEntity, type ClientZone } from './game/state';
import { ACTIONS as KNIGHT_ACTIONS } from './render/knightActions';
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
// 假 Buff 外观：实体 id -> (外观位 -> 到期时间)，tick 里算出每个实体的 looks
const lookUntil = new Map<number, Map<number, number>>();

function addLook(id: number, look: number, seconds: number): void {
  let looks = lookUntil.get(id);
  if (!looks) lookUntil.set(id, (looks = new Map()));
  looks.set(look, performance.now() + seconds * 1000);
}

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
  // ?fxlab&ranger 一开始就是游侠
  const ranger = new URLSearchParams(location.search).has('ranger');
  const me = makeEntity({ id: ME, kind: 'player', name: '我', model: ranger ? 'ranger' : 'knight', r: 16, lv: 10, x: center.x, y: center.y, hp: 500, maxHp: 500 }, now);
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
  if (tickN % 10 === 0) zoneHeals(now);
  for (const e of state.ents.values()) {
    if (e.dead && e.deadAt >= 0 && now - e.deadAt > 5000) revive(e);
    let looks = 0;
    for (const [look, until] of lookUntil.get(e.id) ?? []) if (until > now) looks |= look;
    e.looks = e.dead ? 0 : looks;
  }
}

// 假回血区：和服务端一样，站在椭圆里、没满血的每秒回一次
let nextZoneId = 1;

function addZone(zone: Omit<ClientZone, 'id' | 'goneAt' | 'seed' | 'pulseFrom'>): void {
  // 同一个人只能有一个法阵：旧的淡出
  for (const old of state.zones) if (zone.owner && old.owner === zone.owner && !old.goneAt) old.goneAt = performance.now();
  state.zones.push({ ...zone, id: nextZoneId++, goneAt: 0, pulseFrom: zone.born, seed: Math.random() * 100 });
}

function zoneHeals(now: number): void {
  state.zones = state.zones.filter((zone) => (zone.goneAt ? now - zone.goneAt < 700 : !zone.endsAt || zone.endsAt > now));
  for (const zone of state.zones) {
    if (zone.goneAt || now < zone.born) continue;
    for (const e of state.ents.values()) {
      if (e.kind !== 'player' || e.dead || e.hp >= e.maxHp) continue;
      if (Math.hypot(e.x - zone.x, (e.y - zone.y) / ZONE_ASPECT) > zone.radius) continue;
      const v = Math.min(e.maxHp - e.hp, Math.round(e.maxHp * (zone.heal || 0.03)));
      e.hp += v;
      emit({ k: 'heal', dst: e.id, v, zone: zone.id });
    }
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
  emit({ k: 'cast', src: ME, dst: t.id, fx: 'melee', skill: heavy ? 'smash' : 'slash', color: '#ffd166' });
  emit({ k: 'dmg', src: ME, dst: t.id, v, skill: heavy ? 'smash' : 'slash', crit });
  damage(t, v);
  if (t.hp <= 0) kill(t);
}

// later 让 fn 在 ms 毫秒后跑（走主循环的 state.pending，录预览换掉时钟时也对得上）。
function later(ms: number, fn: () => void): void {
  state.pending.push({ at: performance.now() + ms, fn });
}

// knockAway 算 victim 被 from 打中后、推开 distance 像素的落点（服务端用 nav.Reach，这里是空地）。
function knockAway(victim: ClientEntity, from: ClientEntity, distance: number): { kx: number; ky: number } {
  const now = performance.now();
  const vp = posOf(victim, now);
  const fp = posOf(from, now);
  const len = Math.hypot(vp.x - fp.x, vp.y - fp.y) || 1;
  return { kx: vp.x + (vp.x - fp.x) / len * distance, ky: vp.y + (vp.y - fp.y) / len * distance };
}

// ogreSmash 是食人魔首领的重锤：举锤前摇 0.6 秒、地上红圈填满，砸中自己把人砸退并硬直（blocked：举盾挡住，只退一点）。
function ogreSmash(blocked: boolean): void {
  const ogre = state.ents.get(3)!;
  const me = state.ents.get(ME)!;
  const windup = 600;
  // 先走到自己身边（够得着重锤的射程）
  const mp = posOf(me, performance.now());
  moveTo(ogre, mp.x + 74, mp.y - 6, performance.now());
  ogre.facing = Math.PI;
  emit({ k: 'cast', src: ogre.id, dst: ME, fx: 'melee', skill: 'smash', weight: 'heavy', color: '#ff9f43',
    hitAt: (performance.now() + windup) / 1000 });
  if (blocked) me.blocking = true;
  later(windup, () => {
    const knock = knockAway(me, ogre, blocked ? 50 / 1.2 * 0.3 : 50 / 1.2);
    emit({ k: 'dmg', src: ogre.id, dst: ME, v: blocked ? 12 : 70, skill: 'smash', weight: 'heavy', blocked: blocked ? 48 : undefined,
      ...knock, knockTime: 0.18, stun: blocked ? 0 : 0.45 });
    if (!blocked) damage(me, 70);
    later(600, () => { me.blocking = false; });
  });
}

// guardDemo 是格挡 2.0 的几种结果：parry 在重锤落下前一刻才举盾（完美格挡，食人魔被弹开），
// guard_break 是架势只剩一点时硬挡（盾被砸开、人被推开），back 是盾朝着反方向、从背后挨了一锤。
function guardDemo(kind: 'parry' | 'guard_break' | 'back'): void {
  const ogre = state.ents.get(3)!;
  const me = state.ents.get(ME)!;
  const windup = 600;
  const mp = posOf(me, performance.now());
  moveTo(ogre, mp.x + 74, mp.y - 6, performance.now());
  ogre.facing = Math.PI;
  me.facing = kind === 'back' ? Math.PI : 0;
  emit({ k: 'cast', src: ogre.id, dst: ME, fx: 'melee', skill: 'smash', weight: 'heavy', color: '#ff9f43',
    hitAt: (performance.now() + windup) / 1000 });
  // 完美格挡：命中前 0.1 秒才举盾；其它两种一开始就举着
  const raiseAt = kind === 'parry' ? windup - 100 : 0;
  later(raiseAt, () => {
    me.blocking = true;
    if (kind === 'guard_break') { me.guard = 0.25; me.guardAt = performance.now(); }
  });
  later(windup, () => {
    const now = performance.now();
    if (kind === 'parry') {
      const knock = knockAway(ogre, me, 18 / 2.5);
      emit({ k: 'dmg', src: ogre.id, dst: ME, v: 0, skill: 'smash', weight: 'heavy', blocked: 60, result: 'parry',
        ...knock, knockTime: 0.18, stun: 0.6 });
    } else if (kind === 'guard_break') {
      const knock = knockAway(me, ogre, 30 / 1.2);
      me.guard = 0; me.guardAt = now;
      emit({ k: 'dmg', src: ogre.id, dst: ME, v: 12, skill: 'smash', weight: 'heavy', blocked: 48, result: 'guard_break',
        ...knock, knockTime: 0.18, stun: 0.8 });
      damage(me, 12);
      // 架势过一会儿开始回
      for (let i = 1; i <= 20; i++) later(1000 + i * 125, () => { me.guard = i / 20; me.guardAt = performance.now(); });
    } else {
      // 盾还举着，但朝着另一边：照样挨了整整一锤
      const knock = knockAway(me, ogre, 50 / 1.2);
      emit({ k: 'dmg', src: ogre.id, dst: ME, v: 70, skill: 'smash', weight: 'heavy', ...knock, knockTime: 0.18, stun: 0.45 });
      damage(me, 70);
    }
    later(700, () => { me.blocking = false; });
  });
}

// heavySweep 是自己的旋风斩：重击，按每只怪的重量把它们推开，食人魔首领韧性高推不动。
function heavySweep(): void {
  const me = state.ents.get(ME)!;
  const p = posOf(me, performance.now());
  emit({ k: 'cast', src: ME, fx: 'circle', skill: 'whirlwind', name: '旋风斩', weight: 'heavy', color: '#e0e0e0', radius: 130, x: p.x, y: p.y });
  later(80, () => {
    for (const e of state.ents.values()) {
      if (e.id === ME || e.dead || e.kind === 'pet') continue;
      const mass = e.model === 'slime' || e.model === 'skeleton_archer' ? 0.8 : 1;
      const armored = e.model === 'ogre_chief';
      const knock = armored ? {} : { ...knockAway(e, me, 50 / mass), knockTime: 0.18, stun: 0.45 };
      emit({ k: 'dmg', src: ME, dst: e.id, v: 45, skill: 'whirlwind', weight: 'heavy', ...knock });
      damage(e, 45);
      if (e.hp <= 0) kill(e);
    }
  });
}

// groundMarksDemo 一次打出四种地面印记：重锤砸狼（裂纹）、火球烧食人魔（焦痕）、冰霜打骷髅（霜）、
// 重击把史莱姆推出去（拖痕）。
function groundMarksDemo(): void {
  const me = state.ents.get(ME)!;
  emit({ k: 'cast', src: ME, dst: 2, fx: 'melee', skill: 'smash', weight: 'heavy', color: '#ffd166' });
  later(120, () => emit({ k: 'dmg', src: ME, dst: 2, v: 30, skill: 'smash', weight: 'heavy' }));
  emit({ k: 'cast', src: ME, dst: 3, fx: 'projectile', skill: 'fireball', name: '火球术', color: '#ff7b39' });
  later(300, () => emit({ k: 'dmg', src: ME, dst: 3, v: 30, skill: 'fireball' }));
  later(200, () => emit({ k: 'dmg', src: ME, dst: 4, v: 30, skill: 'frost_nova' }));
  const slime = state.ents.get(5)!;
  later(260, () => emit({ k: 'dmg', src: ME, dst: 5, v: 20, skill: 'whirlwind', weight: 'heavy', ...knockAway(slime, me, 60), knockTime: 0.2, stun: 0.3 }));
}

// interruptWolf 是灰狼扑上来前摇 0.5 秒，自己抢先一刀把它砍出硬直，这一口就没咬下来。
function interruptWolf(): void {
  const wolf = state.ents.get(2)!;
  emit({ k: 'cast', src: wolf.id, dst: ME, fx: 'melee', skill: 'heavy_bite', weight: 'heavy', color: '#ffef5c',
    hitAt: (performance.now() + 500) / 1000 });
  later(220, () => {
    emit({ k: 'cast', src: ME, dst: wolf.id, fx: 'melee', skill: 'slash', weight: 'light', color: '#ffd166' });
    later(130, () => {
      emit({ k: 'dmg', src: ME, dst: wolf.id, v: 30, skill: 'slash', weight: 'light', ...knockAway(wolf, state.ents.get(ME)!, 10), knockTime: 0.18, stun: 0.15 });
      damage(wolf, 30);
      emit({ k: 'interrupt', id: wolf.id });
    });
  });
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
  ['击杀', () => { const t = target(); if (t) { emit({ k: 'cast', src: ME, dst: t.id, fx: 'melee', skill: 'smash', color: '#ffd166' }); emit({ k: 'dmg', src: ME, dst: t.id, v: t.hp, skill: 'smash', crit: true }); damage(t, t.hp); kill(t); } }],
  ['旋风斩', () => {
    const me = posOf(state.ents.get(ME)!, performance.now());
    emit({ k: 'cast', src: ME, fx: 'circle', skill: 'whirlwind', name: '旋风斩', color: '#ff9a3c', radius: 130, x: me.x, y: me.y });
    for (const e of state.ents.values()) if (e.id !== ME && !e.dead) { const v = 45; emit({ k: 'dmg', src: ME, dst: e.id, v, crit: Math.random() < 0.3 }); damage(e, v); if (e.hp <= 0) kill(e); }
  }],
  ['被打', () => { const t = target(); const me = state.ents.get(ME)!; if (!t) return; emit({ k: 'cast', src: t.id, dst: ME, fx: 'melee', skill: 'bite', color: '#ff5a50' }); emit({ k: 'dmg', src: t.id, dst: ME, v: 40, skill: 'bite', crit: Math.random() < 0.3 }); damage(me, 40); }],
  ['被重锤', () => { const me = state.ents.get(ME)!; emit({ k: 'cast', src: 3, dst: ME, fx: 'melee', skill: 'smash', color: '#ff9f43' }); emit({ k: 'dmg', src: 3, dst: ME, v: 70, skill: 'smash' }); damage(me, 70); }],
  ['怪物重锤', () => ogreSmash(false)],
  ['重锤被格挡', () => ogreSmash(true)],
  ['完美格挡', () => guardDemo('parry')],
  ['破防', () => guardDemo('guard_break')],
  ['背后挨锤', () => guardDemo('back')],
  ['重击击退', () => heavySweep()],
  ['打断前摇', () => interruptWolf()],
  ['地面印记', () => groundMarksDemo()],
  ['格挡', () => { const t = target(); if (!t) return; emit({ k: 'cast', src: t.id, dst: ME, fx: 'melee', skill: 'smash', color: '#ff5a50' }); emit({ k: 'dmg', src: t.id, dst: ME, v: 8, skill: 'smash', blocked: 32 }); }],
  ['箭矢', () => { emit({ k: 'cast', src: 4, dst: ME, fx: 'projectile', skill: 'arrow', color: '#cfe8ff' }); emit({ k: 'dmg', src: 4, dst: ME, v: 22, skill: 'arrow' }); damage(state.ents.get(ME)!, 22); }],
  ['治疗', () => { const me = state.ents.get(ME)!; emit({ k: 'cast', src: ME, fx: 'heal', skill: 'heal', name: '治疗', color: '#7cff9b' }); emit({ k: 'heal', dst: ME, v: 120 }); me.hp = Math.min(me.maxHp, me.hp + 120); }],
  ['护盾', () => emit({ k: 'cast', src: ME, fx: 'shield', skill: 'shield', name: '圣盾', color: '#7fd8ff' })],
  ['火球术', () => {
    const t = target();
    if (!t) return;
    emit({ k: 'cast', src: ME, dst: t.id, fx: 'projectile', skill: 'fireball', name: '火球术', color: '#ff7b39' });
    emit({ k: 'dmg', src: ME, dst: t.id, v: 52 });
    damage(t, 52);
    if (t.hp <= 0) kill(t);
  }],
  ['战吼', () => emit({ k: 'cast', src: ME, fx: 'buff', skill: 'warcry', name: '战吼', color: '#ff4d6d' })],
  ['升级', () => emit({ k: 'lvl', id: ME, lv: 11 })],
  ['疾风步', () => { emit({ k: 'cast', src: ME, fx: 'haste', skill: 'haste', name: '疾风步', color: '#9effd8' }); addLook(ME, LOOK_HASTE, 4); }],
  ['圣光庇护', () => { emit({ k: 'cast', src: ME, fx: 'holy', skill: 'holy_guard', name: '圣光庇护', color: '#ffe9a0' }); addLook(ME, LOOK_HOLY, 2); }],
  ['免疫', () => { const t = target(); if (!t) return; emit({ k: 'cast', src: t.id, dst: ME, fx: 'melee', skill: 'bite', color: '#ff5a50' }); emit({ k: 'dmg', src: t.id, dst: ME, v: 0, immune: true }); }],
  ['闪现', () => {
    const me = state.ents.get(ME)!;
    const from = posOf(me, performance.now());
    const dir = Math.cos(me.facing) < 0 ? -1 : 1;
    // 闪出去再闪回来，来回都看得到
    const to = { x: from.x + dir * 170, y: from.y };
    emit({ k: 'cast', src: ME, fx: 'blink', skill: 'blink', name: '闪现', color: '#b98cff', x: from.x, y: from.y, tx: to.x, ty: to.y });
    me.facing = dir < 0 ? 0 : Math.PI;
  }],
  ['烈焰附魔', () => { emit({ k: 'cast', src: ME, fx: 'enchant', skill: 'enchant', name: '烈焰附魔', color: '#ff8a3a' }); addLook(ME, LOOK_FIRE, 8); }],
  ['飞斧', () => {
    const victim = target();
    const from = posOf(state.ents.get(ME)!, performance.now());
    if (!victim) return;
    const to = posOf(victim, performance.now());
    const dist = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const stop = Math.max(0, dist - (victim.r || 14));
    emit({ k: 'cast', src: ME, dst: victim.id, fx: 'axe', skill: 'axe', name: '飞斧', color: '#d8dde6',
      x: from.x, y: from.y, tx: from.x + (to.x - from.x) / dist * stop, ty: from.y + (to.y - from.y) / dist * stop });
    emit({ k: 'dmg', src: ME, dst: victim.id, v: 38 });
    damage(victim, 38);
    if (victim.hp <= 0) kill(victim);
  }],
  ['冰霜新星', () => {
    const me = posOf(state.ents.get(ME)!, performance.now());
    emit({ k: 'cast', src: ME, fx: 'frost', skill: 'frost_nova', name: '冰霜新星', color: '#8fd8ff', radius: 130, x: me.x, y: me.y });
    for (const e of state.ents.values()) {
      if (e.id === ME || e.dead) continue;
      emit({ k: 'dmg', src: ME, dst: e.id, v: 24 });
      damage(e, 24);
      if (e.hp <= 0) kill(e); else addLook(e.id, LOOK_FROST, 3);
    }
  }],
  ['治愈之泉', () => {
    const me = state.ents.get(ME)!;
    const p = posOf(me, performance.now());
    emit({ k: 'cast', src: ME, fx: 'zone', skill: 'healing_spring', name: '治愈之泉', color: '#7dffb0', radius: 110, x: p.x, y: p.y });
    const now = performance.now();
    addZone({ x: p.x, y: p.y, radius: 110, name: '治愈之泉', color: '#7dffb0', look: 'rune', owner: ME,
      dur: 60, interval: 1, heal: 0.03, born: now + leadOf('zone'), endsAt: now + leadOf('zone') + 60000 });
    me.hp = Math.min(me.hp, me.maxHp * 0.5);   // 先掉点血，看得到回血
  }],
  ['生命之泉', () => {
    const now = performance.now();
    const old = state.zones.find((zone) => zone.look === 'spring' && !zone.goneAt);
    if (old) { old.goneAt = now; return; }
    // 放在广场中间（村子里正好是游戏里出生点的位置）
    addZone({ x: center.x + 60, y: center.y - 40, radius: 130, name: '生命之泉', color: '#7dffc4', look: 'spring',
      owner: 0, dur: 0, interval: 1, heal: 0.05, born: now, endsAt: 0 });
  }],
];

// leadOf 是自己放技能 fx 时动作出手前的那段时间（游侠的动作名前面加 "ranger:"）。
function leadOf(fx: string): number {
  const me = state.ents.get(ME);
  const name = me?.model === 'ranger' ? `ranger:${fx}` : fx;
  return KNIGHT_ACTIONS[name]?.lead ?? 0;
}

// 游侠的技能按钮：先切成游侠再放
function asRanger(fn: () => void): () => void {
  return () => {
    const me = state.ents.get(ME)!;
    if (me.model !== 'ranger') { me.model = 'ranger'; me.color = '#8fd17a'; }
    fn();
  };
}

// shoot 是游侠朝目标射一箭（fx: arrow / frostarrow）。
function shoot(fx: string, skill: string, name: string, color: string, v: number): void {
  const t = target();
  if (!t) return;
  emit({ k: 'cast', src: ME, dst: t.id, fx, skill, name: fx === 'arrow' ? undefined : name, color });
  emit({ k: 'dmg', src: ME, dst: t.id, v, crit: Math.random() < 0.25 });
  damage(t, v);
  if (t.hp <= 0) kill(t); else if (fx === 'frostarrow') addLook(t.id, LOOK_FROST, 3);
}

ACTIONS.push(
  ['骑士', () => { const me = state.ents.get(ME)!; me.model = 'knight'; me.color = '#4da3ff'; }],
  ['游侠', asRanger(() => {})],
  ['射击', asRanger(() => shoot('arrow', 'shot', '射击', '#f0e2b6', 26))],
  ['穿云箭', asRanger(() => {
    // 朝目标方向射穿到 380 外，沿线的敌人按远近挨个挨打
    const me = state.ents.get(ME)!;
    const from = posOf(me, performance.now());
    const t = target();
    const dir = t ? Math.atan2(posOf(t, performance.now()).y - from.y, posOf(t, performance.now()).x - from.x) : (Math.cos(me.facing) < 0 ? Math.PI : 0);
    const range = 380 + 16;
    const hits = [...state.ents.values()].filter((e) => {
      if (e.id === ME || e.dead) return false;
      const p = posOf(e, performance.now());
      const along = (p.x - from.x) * Math.cos(dir) + (p.y - from.y) * Math.sin(dir);
      const across = Math.abs(-(p.x - from.x) * Math.sin(dir) + (p.y - from.y) * Math.cos(dir));
      return along > 0 && along < range && across < (e.r || 14) + 10;
    }).sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y));
    emit({ k: 'cast', src: ME, dst: hits[0]?.id, fx: 'pierce', skill: 'pierce_shot', name: '穿云箭', color: '#ffe08a',
      x: from.x, y: from.y, tx: from.x + Math.cos(dir) * range, ty: from.y + Math.sin(dir) * range });
    for (const e of hits) { emit({ k: 'dmg', src: ME, dst: e.id, v: 64 }); damage(e, 64); if (e.hp <= 0) kill(e); }
  })],
  ['箭雨', asRanger(() => {
    const t = target();
    const me = state.ents.get(ME)!;
    const from = posOf(me, performance.now());
    const dir = Math.cos(me.facing) < 0 ? -1 : 1;
    const c = t ? posOf(t, performance.now()) : { x: from.x + dir * 180, y: from.y };
    emit({ k: 'cast', src: ME, dst: t?.id, fx: 'rain', skill: 'arrow_rain', name: '箭雨', color: '#cfe6ff', radius: 90, x: c.x, y: c.y });
    for (const e of state.ents.values()) {
      if (e.id === ME || e.dead || Math.hypot(e.x - c.x, e.y - c.y) > 90 + (e.r || 14)) continue;
      emit({ k: 'dmg', src: ME, dst: e.id, v: 34 });
      damage(e, 34);
      if (e.hp <= 0) kill(e);
    }
  })],
  ['冰霜箭', asRanger(() => shoot('frostarrow', 'frost_arrow', '冰霜箭', '#8fd8ff', 30))],
  ['翻滚', asRanger(() => {
    const me = state.ents.get(ME)!;
    const from = posOf(me, performance.now());
    const dir = Math.cos(me.facing) < 0 ? -1 : 1;
    emit({ k: 'cast', src: ME, fx: 'roll', skill: 'roll', name: '翻滚', color: '#c8f0c0', x: from.x, y: from.y, tx: from.x + dir * 130, ty: from.y });
    // 滚完转回来，下一次往回滚
    setTimeout(() => { me.facing = dir < 0 ? 0 : Math.PI; }, 500);
  })],
  ['鹰眼专注', asRanger(() => emit({ k: 'cast', src: ME, fx: 'focus', skill: 'focus', name: '鹰眼专注', color: '#ffd27a' }))],
);

// 皮肤和武器外观：按一下换下一套（同一套骨骼和动作）
const SKINS: Record<string, string[]> = { knight: ['', 'obsidian', 'gilded'], ranger: ['', 'nightshade', 'snowfield'] };
const GEARS: Record<string, string[]> = {
  knight: ['', 'blood_blade', 'flame_greatsword'],
  ranger: ['', 'hunter_bow', 'wind_bow', 'frost_bow'],
};
function cycle(list: string[], current: string): string {
  return list[(list.indexOf(current) + 1) % list.length];
}

// 实验页没有连服务端，掉落要用的装备名自己填几件
const LAB_ITEMS = [
  { id: 'blood_blade', name: '渴血之刃', rarity: 'rare' },
  { id: 'flame_greatsword', name: '炎魔巨剑', rarity: 'epic' },
  { id: 'life_charm', name: '生命护符', rarity: 'common' },
];

// procHit 让自己对目标打出一下普攻，再追加一次装备特效伤害（点燃）或者回血（吸血）
function procAttack(proc: 'ignite' | 'lifesteal'): void {
  const t = target();
  if (!t) return;
  hit(false);
  if (proc === 'ignite') {
    emit({ k: 'dmg', src: ME, dst: t.id, v: 14, proc: 'ignite' });
    damage(t, 14);
  } else {
    const me = state.ents.get(ME)!;
    emit({ k: 'heal', dst: ME, v: 9, proc: 'lifesteal' });
    me.hp = Math.min(me.maxHp, me.hp + 9);
  }
  if (t.hp <= 0) kill(t);
}

ACTIONS.push(
  ['换皮肤', () => { const me = state.ents.get(ME)!; me.skin = cycle(SKINS[me.model] || [''], me.skin); }],
  ['换武器', () => { const me = state.ents.get(ME)!; me.gear = cycle(GEARS[me.model] || [''], me.gear); }],
  ['掉落', () => {
    for (const item of LAB_ITEMS) {
      if (!state.items.has(item.id)) {
        state.items.set(item.id, { id: item.id, name: item.name, slot: 'weapon', cls: '', rarity: item.rarity, desc: '', stats: [], effect: '', look: '' });
      }
    }
    const t = target();
    const pick = LAB_ITEMS[Math.floor(Math.random() * LAB_ITEMS.length)];
    emit({ k: 'loot', src: t?.id, dst: ME, item: pick.id });
  }],
  ['点燃', () => procAttack('ignite')],
  ['吸血', () => procAttack('lifesteal')],
  ['反伤', () => {
    const t = target();
    if (!t) return;
    emit({ k: 'cast', src: t.id, dst: ME, fx: 'melee', skill: 'bite', color: '#ff5a50' });
    emit({ k: 'dmg', src: t.id, dst: ME, v: 20 });
    emit({ k: 'dmg', src: ME, dst: t.id, v: 6, proc: 'thorns' });
    damage(t, 6);
  }],
);

// 宠物：召唤到自己身后，按按钮让它攻击当前目标、放技能、瞬移
const PET = 50;
const LAB_PETS: Record<string, { name: string; color: string; r: number; attack: string; skill: string; skillName: string; skillColor: string }> = {
  wolf_pup: { name: '小狼', color: '#b5824e', r: 13, attack: 'melee', skill: 'buff', skillName: '嚎叫', skillColor: '#ffcf6e' },
  ember: { name: '火灵', color: '#ff7a2a', r: 12, attack: 'projectile', skill: 'circle', skillName: '爆燃', skillColor: '#ffb347' },
  sprout: { name: '林精', color: '#7dd87d', r: 12, attack: 'projectile', skill: 'heal', skillName: '愈合', skillColor: '#7dff9b' },
};

function summonPet(model: string): void {
  const now = performance.now();
  const me = state.ents.get(ME)!;
  const from = posOf(me, now);
  const cfg = LAB_PETS[model];
  const pet = makeEntity({
    id: PET, kind: 'pet', name: `我 的 ${cfg.name}`, model, r: cfg.r, lv: 10,
    x: from.x - 46, y: from.y + 14, hp: 160, maxHp: 160, owner: ME, color: cfg.color,
  }, now);
  pet.fresh = false;
  pet.petName = cfg.name;
  state.ents.set(PET, pet);
  emit({ k: 'cast', src: PET, fx: 'pet_summon', color: cfg.color, x: pet.x, y: pet.y });
}

function petOf(): ClientEntity | undefined {
  const pet = state.ents.get(PET);
  return pet && !pet.dead ? pet : undefined;
}

ACTIONS.push(
  ['召唤小狼', () => summonPet('wolf_pup')],
  ['召唤火灵', () => summonPet('ember')],
  ['召唤林精', () => summonPet('sprout')],
  ['宠物攻击', () => {
    const pet = petOf();
    const t = target();
    if (!pet || !t) return;
    const cfg = LAB_PETS[pet.model];
    // 小狼先扑到目标身边再咬
    if (cfg.attack === 'melee') {
      const p = posOf(t, performance.now());
      moveTo(pet, p.x - 34, p.y + 4, performance.now());
    }
    const color = pet.model === 'sprout' ? '#8fe08f' : pet.model === 'ember' ? '#ff7b39' : '#e8c9a0';
    emit({ k: 'cast', src: PET, dst: t.id, fx: cfg.attack, color });
    emit({ k: 'dmg', src: PET, dst: t.id, v: 18 });
    damage(t, 18);
    if (t.hp <= 0) kill(t);
  }],
  ['宠物技能', () => {
    const pet = petOf();
    if (!pet) return;
    const cfg = LAB_PETS[pet.model];
    if (cfg.skill === 'heal') {
      emit({ k: 'cast', src: PET, dst: ME, fx: 'heal', name: cfg.skillName, color: cfg.skillColor });
      emit({ k: 'heal', dst: ME, v: 60 });
    } else {
      emit({ k: 'cast', src: PET, fx: cfg.skill, name: cfg.skillName, color: cfg.skillColor, radius: 90 });
    }
  }],
  ['宠物传送', () => {
    const pet = petOf();
    if (!pet) return;
    const now = performance.now();
    const from = posOf(pet, now);
    const me = posOf(state.ents.get(ME)!, now);
    const away = from.x < me.x ? 1 : -1;
    emit({ k: 'cast', src: PET, fx: 'pet_teleport', x: from.x, y: from.y, tx: me.x + away * 46, ty: me.y + 14 });
  }],
);

// 滑条：[标签, FEEL 字段, 最小, 最大, 步长]
const SLIDERS: [string, keyof typeof FEEL, number, number, number][] = [
  ['镜头跟随 ms', 'camFollowMs', 0, 400, 10],
  ['镜头前瞻 px', 'camLead', 0, 160, 5],
  ['震屏倍数', 'shake', 0, 3, 0.1],
  ['溶解延迟 ms', 'dissolveDelayMs', 0, 4000, 100],
  ['溶解时长 ms', 'dissolveMs', 200, 3000, 100],
  ['扭曲倍数', 'distort', 0, 5, 0.1],
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
  panel.appendChild(profileEditor());
  panel.appendChild(soundPanel());
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
#fxlab .v { text-align: right; color: #c9b88f; font-variant-numeric: tabular-nums; }
#fxlab { max-height: calc(100vh - 80px); overflow-y: auto; }
#fxlab .fxlab-sub { color: #e8b65a; margin: 8px 0 4px; }
#fxlab select { background: #1d1424; color: #f3e9d2; border: 1px solid #5a4630; font: inherit; }
#fxlab textarea { width: 100%; height: 90px; background: #1d1424; color: #f3e9d2; border: 1px solid #5a4630; font: 11px monospace; }`;
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

// 档位滑条：[标签, Profile 字段, 最小, 最大, 步长]
const PROFILE_SLIDERS: [string, keyof Profile, number, number, number][] = [
  ['顿帧 ms', 'hitStopMs', 0, 250, 5],
  ['击退 px', 'knockPx', 0, 40, 1],
  ['受击形变', 'squash', 0, 0.6, 0.02],
  ['打中镜头', 'kickOut', 0, 15, 0.5],
  ['挨打镜头', 'kickIn', 0, 15, 0.5],
  ['震动 px', 'shake', 0, 10, 0.5],
];
const PROFILE_LABELS: [ProfileName, string][] = [['light', '轻'], ['medium', '中'], ['heavy', '重'], ['block', '格挡'], ['parry', '完美格挡'], ['guard_break', '破防'], ['immune', '免疫']];

// profileEditor 是档位表编辑器：选一档，拖滑条改这一档的参数，导出整张表的 JSON 粘回 feel/profiles.ts。
function profileEditor(): HTMLElement {
  const box = document.createElement('div');
  box.innerHTML = '<div class="fxlab-sub">命中档位（普攻=轻，飞斧=中，重击/被重锤=重）</div>';
  const tabs = document.createElement('div');
  tabs.className = 'fxlab-buttons';
  const rows = document.createElement('div');
  const show = (name: ProfileName) => {
    for (const b of tabs.children) b.classList.toggle('on', (b as HTMLElement).dataset.name === name);
    rows.replaceChildren(...PROFILE_SLIDERS.map(([label, key, min, max, step]) =>
      slider(label, min, max, step, PROFILES[name][key], (v) => { PROFILES[name][key] = v; })));
  };
  for (const [name, label] of PROFILE_LABELS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = 'toggle';
    b.dataset.name = name;
    b.onclick = () => show(name);
    tabs.appendChild(b);
  }
  const output = document.createElement('textarea');
  output.hidden = true;
  const exportButton = document.createElement('button');
  exportButton.textContent = '导出档位表';
  exportButton.onclick = () => {
    output.hidden = false;
    output.value = JSON.stringify(PROFILES, null, 1);
    output.select();
  };
  box.append(tabs, rows, exportButton, output);
  show('light');
  return box;
}

// soundPanel 是音效试听：音量、按名字播放任意配方、命中声的武器 × 材质 × 档位组合。
function soundPanel(): HTMLElement {
  const box = document.createElement('div');
  box.innerHTML = '<div class="fxlab-sub">音效（M 静音）</div>';
  box.appendChild(slider('音量', 0, 1, 0.05, getVolume(), setVolume));
  const options = (list: readonly string[]) => list.map((v) => `<option>${v}</option>`).join('');
  const matrix = document.createElement('div');
  matrix.className = 'fxlab-buttons';
  matrix.innerHTML = `<select id="sfx-weapon">${options(WEAPONS)}</select><select id="sfx-material">${options(MATERIALS)}</select>`
    + `<select id="sfx-tier">${options(TIERS)}</select>`;
  const playHit = document.createElement('button');
  playHit.textContent = '命中';
  playHit.onclick = () => {
    const value = (id: string) => (matrix.querySelector(`#${id}`) as HTMLSelectElement).value;
    play(`hit.${value('sfx-weapon')}.${value('sfx-material')}.${value('sfx-tier')}`);
  };
  matrix.appendChild(playHit);
  box.appendChild(matrix);
  const others = document.createElement('div');
  others.className = 'fxlab-buttons';
  for (const name of Object.keys(RECIPES).filter((n) => !n.startsWith('hit.') || n === 'hit.crit')) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => play(name);
    others.appendChild(b);
  }
  box.appendChild(others);
  return box;
}
