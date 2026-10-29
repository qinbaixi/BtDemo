// 反馈调度器：一次命中先整理成 HitContext（谁打谁、几档、什么武器打在什么材质上、和自己有没有关系），
// 再按档位表（profiles.ts）分发给各个通道：顿帧、受击位移和形变、镜头、连击和红边、音效。
// 特效和飘字还留在 events.ts 里，它们只看命中结果，不看档位。
//
// 视角规则：自己（或自己的宠物）参与的命中全通道满强度；别人之间的命中不动镜头，声音小一些。

import { play } from '../audio/engine';
import type { Material, Tier, Weapon } from '../audio/recipes';
import { cameraKick, cameraPunch } from '../render/camera';
import { LOOK_FIRE } from '../game/config';
import { hypot } from '../game/math';
import { posOf, state, type ClientEntity } from '../game/state';
import type { GameEvent } from '../net/types';
import { CRIT, DEATH_KNOCK_PX, KILL, MODEL_MATERIAL, PARRY, PROFILES, skillFeel, type Profile } from './profiles';

export type HitResult = 'hit' | 'block' | 'parry' | 'guard_break' | 'immune';

export interface HitContext {
  srcId: number;
  src: ClientEntity | undefined;
  target: ClientEntity;
  tier: Tier;
  weapon: Weapon;
  material: Material;
  result: HitResult;
  crit: boolean;
  damage: number;
  absorbed: boolean;   // 有一部分被护盾吸收了
  mine: boolean;       // 自己或自己的宠物打的
  hurtMe: boolean;     // 打在自己身上
  knock: { x: number; y: number; ms: number } | null;   // 服务端的真实击退：落点和用时（完美格挡时是攻击者的）
  stunMs: number;      // 服务端给的硬直（完美格挡时是攻击者的）
  wall: boolean;       // 被打到撞墙
}

const BYSTANDER_GAIN = 0.35;   // 别人之间的命中：声音约 -9dB

// 每个实体最近一次放的技能 fx（伤害事件里没有 fx，猜档位时用）和最近一次被谁打
const lastCastFx = new Map<number, string>();
const lastHitBy = new Map<number, { src: number; at: number }>();
// 镜头冲击的预算：同一时刻（范围技能一下打中一群）只取最强的那一次
let kickBudget = { at: -1e9, strength: 0 };

// forgetEntity 在实体离开视野时丢掉它的记录。
export function forgetEntity(id: number): void {
  lastCastFx.delete(id);
  lastHitBy.delete(id);
}

// isMine 判断实体是不是自己或自己的宠物。
export function isMine(id: number | undefined): boolean {
  if (!id) return false;
  if (id === state.myId) return true;
  const entity = state.ents.get(id);
  return !!entity && entity.kind === 'pet' && entity.owner === state.myId;
}

// buildHit 把一个 DAMAGE 事件整理成 HitContext；目标不在视野里时返回 null。
export function buildHit(ev: GameEvent): HitContext | null {
  const target = ev.dst ? state.ents.get(ev.dst) : undefined;
  if (!target) return null;
  const srcId = ev.src || 0;
  const src = srcId ? state.ents.get(srcId) : undefined;
  // 服务端给了档位就用服务端的（skills.yaml 的 weight）；复制一份，别改到 SKILL_FEEL 表里
  const feel = { ...skillFeel(ev.skill, ev.proc, lastCastFx.get(srcId)) };
  if (ev.weight && ev.weight in PROFILES) feel.tier = ev.weight as Tier;
  let weapon = feel.weapon;
  // 武器着火时，刀剑和钝器打出来是火焰声
  if (src && src.looks & LOOK_FIRE && (weapon === 'blade' || weapon === 'blunt') && !ev.proc) weapon = 'fire';
  const result: HitResult = ev.result ?? (ev.immune ? 'immune' : ev.blocked ? 'block' : 'hit');
  return {
    srcId,
    src,
    target,
    tier: feel.tier,
    weapon,
    // 举盾挡住时打在盾上
    material: result === 'block' || result === 'parry' || result === 'guard_break' ? 'metal' : MODEL_MATERIAL[target.model] ?? 'flesh',
    result,
    crit: !!ev.crit,
    damage: ev.v || 0,
    absorbed: !!ev.absorbed,
    mine: isMine(srcId),
    hurtMe: target.id === state.myId,
    knock: typeof ev.kx === 'number' && typeof ev.ky === 'number'
      ? { x: ev.kx, y: ev.ky, ms: (ev.knockTime || 0.18) * 1000 }
      : null,
    stunMs: (ev.stun || 0) * 1000,
    wall: !!ev.wall,
  };
}

// profileOf 是这次命中用的档位参数（格挡、完美格挡、破防、免疫有自己的一档）。
function profileOf(hit: HitContext): Profile {
  return hit.result === 'hit' ? PROFILES[hit.tier] : PROFILES[hit.result];
}

// playHit 播放一次命中的打击感，返回受击方向的横向分量（伤害数字往这边飘）。
export function playHit(hit: HitContext, now: number): number {
  if (hit.result === 'parry') return playParry(hit, now);
  const { target, src } = hit;
  const profile = profileOf(hit);
  if (hit.result === 'guard_break') target.breakAt = now;
  const crit = hit.crit && hit.result === 'hit';
  lastHitBy.set(target.id, { src: hit.srcId, at: now });

  // 受击方向：从攻击者指向受击者；不知道谁打的就往身后推
  const tp = posOf(target, now);
  let dx = 0;
  let dy = 0;
  if (src && src !== target) {
    const sp = posOf(src, now);
    const len = Math.hypot(tp.x - sp.x, tp.y - sp.y);
    if (len > 0.5) { dx = (tp.x - sp.x) / len; dy = (tp.y - sp.y) / len; }
  }
  if (dx === 0 && dy === 0) dx = Math.cos(target.facing) < 0 ? 1 : -1;

  // 身体：被推开和压扁（免疫不推不闪）
  if (hit.result !== 'immune') {
    target.hitAt = now;
    target.knockX = dx;
    target.knockY = dy;
    // 有真实击退时身体只再晃一小下，主要的位移由击退曲线走
    const amp = profile.knockPx * (crit ? CRIT.knockScale : 1) * (hit.knock ? 0.4 : 1);
    // 已经倒地（箭比死亡事件晚到）时保留被打飞的距离
    target.knockAmp = target.dead ? Math.max(target.knockAmp, amp) : amp;
    target.squashAmp = profile.squash;
  }

  if (hit.knock) knockTo(target, hit.knock, now);
  if (hit.stunMs > 0) target.stunUntil = Math.max(target.stunUntil, now + hit.stunMs);
  if (hit.wall) {
    // 撞墙：一团土、一声闷响，自己参与的话镜头再震一下
    const end = hit.knock ?? tp;
    state.fx?.footDust(end.x, end.y, dx < 0 ? 1 : -1, now + (hit.knock?.ms ?? 0) * 0.6);
    play('wall', { x: end.x, y: end.y, gain: hit.mine || hit.hurtMe ? 1 : BYSTANDER_GAIN, at: now + (hit.knock?.ms ?? 0) * 0.6 });
    if ((hit.mine || hit.hurtMe) && state.fx) state.fx.shake = Math.max(state.fx.shake, 3);
  }

  // 时间：受击者停住；近战的攻击者也停（远程的箭飞到时攻击动作早就结束了）
  const stop = profile.hitStopMs + (crit ? CRIT.hitStopMs : 0);
  target.freezeUntil = Math.max(target.freezeUntil, now + stop);
  const srcPos = src ? posOf(src, now) : null;
  if (src && srcPos && src !== target && hypot(srcPos.x, srcPos.y, tp.x, tp.y) < 140) {
    src.freezeUntil = Math.max(src.freezeUntil, now + stop);
  }

  // 镜头：只在自己打人或被打时动
  if (hit.srcId !== 0 && hit.srcId === state.myId && !hit.hurtMe) {
    kick(dx, dy, profile.kickOut * (crit ? CRIT.kickScale : 1), now);
    if (crit) cameraPunch(CRIT.zoom);
    // 一次范围技能同时打中好几个只算一击（同一时刻的命中合并）
    const combo = state.combo;
    if (hit.damage > 0 && now - combo.at > 1) {
      combo.n = now - combo.at < 2000 ? combo.n + 1 : 1;
      combo.at = now;
    }
  } else if (hit.hurtMe) {
    kick(dx, dy, profile.kickIn * (crit ? CRIT.kickScale : 1), now);
    if (hit.damage > 0) state.hurtAt = now;
  }
  if ((hit.mine || hit.hurtMe) && profile.shake > 0 && state.fx) state.fx.shake = Math.max(state.fx.shake, profile.shake);

  hitSound(hit, tp.x, tp.y);
  return dx;
}

// playParry 是完美格挡：举盾的人往前一顶，攻击者被弹开、白闪、硬直；
// 自己参与时整个画面停一下、镜头放大。返回伤害数字的飘向（往攻击者那边）。
function playParry(hit: HitContext, now: number): number {
  const { target, src } = hit;
  const profile = PROFILES.parry;
  target.parryAt = now;
  const tp = posOf(target, now);
  let dx = Math.cos(target.facing) < 0 ? -1 : 1;
  let dy = 0;
  if (src && src !== target) {
    const sp = posOf(src, now);
    const len = Math.hypot(sp.x - tp.x, sp.y - tp.y);
    if (len > 0.5) { dx = (sp.x - tp.x) / len; dy = (sp.y - tp.y) / len; }
    // 攻击者：被弹开（服务端的落点）、白闪、受击形变、硬直。白闪等停顿过去再亮：
    // 停住的那一下它的武器还压在盾上，这时闪白会把举盾的人一起糊成一片白
    src.hitAt = now + profile.hitStopMs;
    src.knockX = dx;
    src.knockY = dy;
    src.knockAmp = profile.knockPx;
    src.squashAmp = profile.squash;
    if (hit.knock) knockTo(src, hit.knock, now);
    if (hit.stunMs > 0) src.stunUntil = Math.max(src.stunUntil, now + hit.stunMs);
    src.freezeUntil = Math.max(src.freezeUntil, now + profile.hitStopMs);
  }
  target.freezeUntil = Math.max(target.freezeUntil, now + profile.hitStopMs);
  const involved = hit.hurtMe || hit.mine || (!!src && isMine(src.id));
  if (involved) {
    // 整个画面停一下：谁都别动，只有火花和声音
    for (const entity of state.ents.values()) entity.freezeUntil = Math.max(entity.freezeUntil, now + PARRY.worldStopMs);
    cameraPunch(PARRY.zoom);
    kick(dx, dy, hit.hurtMe ? profile.kickIn : profile.kickOut, now);
  }
  play('parry', { x: tp.x, y: tp.y, gain: involved ? 1 : BYSTANDER_GAIN });
  return dx;
}

// knockTo 让 target 沿击退曲线（先快后慢）滑到服务端的落点；途中的位置同步在 sync.ts 里先不管。
function knockTo(target: ClientEntity, knock: { x: number; y: number; ms: number }, now: number): void {
  const from = posOf(target, now);
  target.slide = { x0: from.x, y0: from.y, x1: knock.x, y1: knock.y, at: now, ms: knock.ms, knock: true };
  target.x = target.px = knock.x;
  target.y = target.py = knock.y;
  target.t0 = now;
  target.moveUntil = 0;   // 被推着走不迈腿
}

// kick 推镜头，同一时刻的多次命中只取最强的一次。
function kick(dx: number, dy: number, strength: number, now: number): void {
  const sameMoment = now - kickBudget.at < 30;
  if (sameMoment && strength <= kickBudget.strength) return;
  // 同一时刻已经推过一次：只补上差的那部分
  cameraKick(dx, dy, sameMoment ? strength - kickBudget.strength : strength);
  kickBudget = { at: sameMoment ? kickBudget.at : now, strength };
}

// hitSound 是命中的声音：武器 × 材质 × 档位，暴击、格挡、破防、免疫、护盾各加一层（完美格挡见 playParry）。
function hitSound(hit: HitContext, x: number, y: number): void {
  const gain = hit.mine || hit.hurtMe ? 1 : BYSTANDER_GAIN;
  const where = { x, y, gain };
  if (hit.result === 'immune') {
    play('immune', where);
    return;
  }
  if (hit.result === 'block') {
    play('block', where);
    return;
  }
  if (hit.result === 'guard_break') {
    play('guard.break', where);
    if (hit.damage > 0) play(`hit.${hit.weapon}.${MODEL_MATERIAL[hit.target.model] ?? 'flesh'}.${hit.tier}`, { ...where, gain: where.gain * 0.6 });
    return;
  }
  if (hit.damage > 0) play(`hit.${hit.weapon}.${hit.material}.${hit.tier}`, where);
  if (hit.crit) play('hit.crit', where);
  if (hit.absorbed) play('shield.hit', where);
}

// onDeath 处理倒地：自己（或宠物）打死的再停一下、放大镜头、响收尾音。
export function onDeath(entity: ClientEntity, now: number): void {
  const p = posOf(entity, now);
  const last = lastHitBy.get(entity.id);
  lastHitBy.delete(entity.id);
  const myKill = !!last && now - last.at < 1500 && isMine(last.src);
  entity.knockAmp = DEATH_KNOCK_PX * (myKill ? KILL.knockScale : 1);
  const gain = myKill || entity.id === state.myId ? 1 : BYSTANDER_GAIN;
  play('die.fall', { x: p.x, y: p.y, gain });
  if (!myKill) return;
  entity.freezeUntil = Math.max(entity.freezeUntil, now + KILL.hitStopMs);
  if (last.src === state.myId) cameraPunch(KILL.zoom);
  play('kill', { x: p.x, y: p.y });
}

// 施法 fx → 出手时的声音（不在表里的 fx 没有声音）
const CAST_SOUND: Record<string, string> = {
  circle: 'cast.whirl',
  projectile: 'cast.magic',
  arrow: 'cast.bow',
  frostarrow: 'cast.bow',
  pierce: 'cast.bow.heavy',
  rain: 'cast.rain',
  axe: 'cast.axe',
  frost: 'cast.frost',
  heal: 'cast.heal',
  buff: 'cast.roar',
  shield: 'cast.shield',
  haste: 'cast.haste',
  holy: 'cast.holy',
  enchant: 'cast.enchant',
  blink: 'cast.blink',
  roll: 'cast.roll',
  zone: 'cast.zone',
  focus: 'cast.focus',
  pet_summon: 'cast.summon',
  pet_teleport: 'cast.summon',
};

// 投射物技能出手时的声音按技能区分（火球和骨箭都是 projectile）
const PROJECTILE_SOUND: Record<string, string> = {
  fireball: 'cast.fire',
  pet_firebolt: 'cast.fire',
  arrow: 'cast.bow',
};

// onCast 播放出招的声音：近战在动作开始时挥空，其它在动作出手时（now + delay）。
export function onCast(ev: GameEvent, src: ClientEntity | undefined, now: number, delay: number): void {
  if (ev.src) lastCastFx.set(ev.src, ev.fx || '');
  const p = src ? posOf(src, now) : { x: ev.x ?? 0, y: ev.y ?? 0 };
  const gain = isMine(ev.src) || ev.dst === state.myId ? 1 : BYSTANDER_GAIN;
  if (ev.fx === 'melee') {
    const feel = skillFeel(ev.skill, undefined, ev.fx);
    const name = feel.weapon === 'claw' ? 'swing.claw' : `swing.${feel.tier}`;
    play(name, { x: p.x, y: p.y, gain, at: now + Math.max(0, delay - 120) });
    return;
  }
  const name = (ev.fx === 'projectile' && ev.skill && PROJECTILE_SOUND[ev.skill]) || CAST_SOUND[ev.fx || ''];
  if (name) play(name, { x: p.x, y: p.y, gain, at: now + delay });
}

// sfxAt 在实体身上放一个声音（回血、升级、复活、拾取这类），和自己无关的小声一些。
export function sfxAt(name: string, id: number | undefined, now: number, quiet = false): void {
  const entity = id ? state.ents.get(id) : undefined;
  if (!entity) return;
  const p = posOf(entity, now);
  const gain = isMine(id) ? (quiet ? 0.5 : 1) : BYSTANDER_GAIN * (quiet ? 0.5 : 1);
  play(name, { x: p.x, y: p.y, gain });
}
