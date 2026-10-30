// 把服务端事件（施法、伤害、死亡……）变成动画、特效和飘字。

import { gameNow } from './clock';
import type { GameEvent, SkillInfo } from '../net/types';
import { buildHit, isMine, onCast, onDeath, playHit, sfxAt } from '../feel/director';
import { forgetBlock } from '../input';
import { ACTIONS, muzzleOffset } from '../render/knightActions';
import { ATTACK_IMPACT, ATTACK_MS, LOOK_FIRE, MODEL_SCALE, RARITY_COLOR } from './config';
import { hypot } from './math';
import { faceToward, headY, localTime, posOf, state, type ClientEntity, type FloatOpts } from './state';

const ROLL_SLIDE = 0.75;   // 翻滚动作里身体在地上滑动的那一段（占动作时长的比例）

export function onEvent(ev: GameEvent, now: number): void {
  const fx = state.fx!;
  switch (ev.k) {
    case 'cast': {
      const src = state.ents.get(ev.src);
      // 宠物出现（召唤 / 复活）和瞬移回主人身边：只放特效，不是技能
      if (ev.fx === 'pet_summon') {
        fx.petSummon(ev.src, ev.x ?? 0, ev.y ?? 0, ev.color || '#ffe08a', now);
        onCast(ev, src, now, 0);
        break;
      }
      if (ev.fx === 'pet_teleport') {
        // 出发点那一圈要在挪走实体之前放（petSummon 优先用实体当前的位置）
        fx.petSummon(ev.src, ev.x ?? 0, ev.y ?? 0, src?.color || '#ffe08a', now, true);
        if (src && typeof ev.tx === 'number') blinkTo(src, ev, now);
        fx.petSummon(ev.src, ev.tx ?? 0, ev.ty ?? 0, src?.color || '#ffe08a', now + 120, true);
        onCast(ev, src, now, 0);
        break;
      }
      let lead = 0;
      let origin: { x: number; y: number } | null = null;
      if (src) {
        // 玩家的每个技能有自己的动作（见 render/knightActions.ts，游侠的动作名前面加 "ranger:"），怪物都是普通攻击动作
        const actionName = src.model === 'ranger' ? `ranger:${ev.fx}` : ev.fx;
        const action = src.kind === 'player' && ev.fx ? ACTIONS[actionName!] : undefined;
        // 自己按键时已经先播了这个动作（本地预测，见 predictCast），服务端确认后接着播，不从头再来
        const predicted = src.id === state.myId && takePrediction(ev.skill, now);
        // 前摇：服务端到 hitAt 才结算命中，动作和特效都对准那一刻
        const windupMs = ev.hitAt ? Math.max(0, localTime(ev.hitAt) - now) : 0;
        if (src.id === state.myId && windupMs > 0) busyUntil = now + windupMs;
        src.windupFrom = 0;
        // 装备特效追加的一箭（连射）和正常那一箭同时射出，不重新播一遍拉弓动作
        if (!ev.proc && !predicted) {
          src.attackAt = now;
          // 宠物的施放类技能（嚎叫、爆燃、愈合）用 fx 当动作名，模型里画仰头 / 胀大 / 举手
          const petCast = src.kind === 'pet' && (ev.fx === 'buff' || ev.fx === 'circle' || ev.fx === 'heal');
          src.action = action ? actionName! : petCast ? ev.fx! : '';
          src.attackMs = action ? action.ms : ATTACK_MS;
          if (!action && windupMs > 0) {
            // 普通攻击动作：武器举起来停住，砸下去打到人的那一刻正好是命中时刻
            src.attackAt = now + windupMs - ATTACK_IMPACT * ATTACK_MS;
            src.windupFrom = now;
          }
        }
        lead = action ? action.lead : windupMs > 0 ? windupMs - 40 : 0;
        if (predicted) lead = Math.max(0, lead - (now - src.attackAt));
        // 冲锋（扑杀）：地上画一条从起点到预计终点的预警带，不画目标脚下的圈
        const charge = ev.fx === 'pounce' && typeof ev.tx === 'number';
        if (charge && windupMs > 0) {
          fx.chargeWarn(src.id, ev.x ?? src.x, ev.y ?? src.y, ev.tx!, ev.ty ?? src.y, (ev.radius || src.r || 14) * 2, windupMs, now);
        }
        if (windupMs > 0 && src.kind !== 'player') {
          fx.telegraph(src.id, ev.dst || 0, ev.radius || 0, ev.weight === 'heavy' && !charge, windupMs, now);
        }
        const dst = ev.dst && ev.dst !== ev.src ? state.ents.get(ev.dst) : null;
        if (dst) { const dp = posOf(dst, now); faceToward(src, dp.x, dp.y, now); }
        else if (typeof ev.tx === 'number' && typeof ev.x === 'number' && Math.abs(ev.tx - ev.x) > 1) {
          faceToward(src, ev.tx, ev.ty ?? src.y, now);   // 闪现、没打中的飞斧：朝飞出去的方向
        }
        if (ev.fx === 'blink' && typeof ev.tx === 'number') blinkTo(src, ev, now);
        if (ev.fx === 'roll' && typeof ev.tx === 'number') rollTo(src, ev, now, action ? action.ms : 400);
        if (ev.fx === 'pounce_go' && typeof ev.tx === 'number') pounceTo(src, ev, now);
        // 火球从剑尖、飞斧从手里飞出去：动作出手那一刻的位置（相对脚底的世界坐标偏移）
        const muzzle = action ? muzzleOffset(src.action) : null;
        if (muzzle) {
          const scale = ((src.r || 14) * MODEL_SCALE) / 16;
          const dir = Math.cos(src.facing) < -0.1 ? -1 : 1;
          origin = { x: muzzle.x * scale * dir, y: muzzle.y * scale };
        }
        // 武器着火时，物理技能的刀光和命中火花都换成火焰色
        if (src.looks & LOOK_FIRE && (ev.fx === 'melee' || ev.fx === 'circle' || ev.fx === 'axe')) ev = { ...ev, color: '#ff7a2a' };
      }
      // 特效等动作出手时才放（火球从推出去的手心飞出、冰霜新星在剑插地时炸开）
      const delay = fx.cast(ev, now, lead, origin);
      if (!src || src.id !== state.myId || !predictedSwing(ev.skill)) onCast(ev, src, now, delay);
      state.lands.set(ev.src, { at: now + delay, color: ev.color });
      // 玩家的技能，以及怪物的大招，头顶报技能名
      const big = ev.fx === 'circle' || ev.fx === 'buff';
      if (ev.name && src && (src.kind === 'player' || big)) {
        addFloat(now, ev.src, String(ev.name), ev.color || '#ffffff', 13, 900, { rise: 22 });
      }
      break;
    }
    case 'dmg': {
      if (!ev.dst) break;
      // 荆棘反伤：等攻击者那一下打到身上再弹回去（攻击者的出手时刻记在 lands 里）
      const land = state.lands.get(ev.proc === 'thorns' ? ev.dst : ev.src);
      const at = land && land.at > now ? land.at : now;
      const proc = PROC_DAMAGE[ev.proc || ''];
      const color = proc ? proc.color : land ? land.color : '#ffd166';
      const hit = () => {
        const t = gameNow();
        const e = state.ents.get(ev.dst);
        const v = ev.v || 0;
        let side = Math.random() < 0.5 ? -1 : 1;
        // 顿帧、受击位移、镜头、命中声都在 feel/director.ts 里按档位处理
        const context = buildHit(ev);
        if (context) {
          const push = playHit(context, t);
          if (Math.abs(push) > 0.2) side = Math.sign(push);
        }
        // 伤害数字往被推开的方向抛出去（竖着打时随机左右）
        const drift = e ? side * 26 : 0;
        if (ev.immune) {
          // 无敌：金色的“免疫”，不推不闪
          fx.impact(ev.dst, '#ffe9a0', false, t);
          addFloat(t, ev.dst, '免疫', '#ffe9a0', 18, 900, { pop: true, rise: 46 });
          return;
        }
        if (ev.result === 'parry') {
          // 完美格挡：盾前一圈亮金色的冲击环，一个字都不掉；被弹开的攻击者头上冒“失衡”
          if (ev.src) fx.deflect(ev.src, t);
          fx.perfectBlock(ev.dst, ev.src || 0, t);
          addFloat(t, ev.dst, '完美格挡', '#ffe9a0', 19, 1100, { pop: true, rise: 54 });
          if (ev.src && ev.stun) addFloat(t, ev.src, '失衡', '#ffd166', 15, 900, { rise: 40 });
          return;
        }
        if (ev.result === 'guard_break') {
          // 破防：盾被砸开，碎片四溅，盾放下（自己的话右键要重新按）
          fx.guardBreak(ev.dst, t);
          addFloat(t, ev.dst, '破防', '#ff7a45', 20, 1100, { pop: true, rise: 54 });
          if (e) e.blocking = false;
          if (ev.dst === state.myId) forgetBlock(true);
        } else if (ev.blocked) {
          // 格挡：盾上迸出火花，伤害数字小一号
          fx.block(ev.dst, t);
          addFloat(t, ev.dst, '格挡', '#9ad7ff', 18, 900, { pop: true, rise: 46 });
        } else {
          fx.impact(ev.dst, color, ev.crit, t);
        }
        if (ev.absorbed) {
          fx.shieldHit(ev.dst, t);
          addFloat(t, ev.dst, `吸收 ${ev.absorbed}`, '#7fd8ff', 15, 900, { rise: 30 });
        }
        if (v <= 0) return;   // 全被挡下或吸收
        if (proc) {
          // 装备特效打出的伤害：带特效名的小一号数字，配一个特效
          fx.procHit(ev.dst, ev.proc!, t);
          addFloat(t, ev.dst, `${proc.label} ${v}`, proc.color, ev.crit ? 20 : 15, 900, { rise: 34, drift });
          return;
        }
        const mine = ev.dst === state.myId;
        // 自己挨的暴击用大号红字，金色暴击留给自己打出去的
        if (ev.crit && !mine) addFloat(t, ev.dst, `${v}`, '#ffe14d', ev.blocked ? 22 : 30, 1200, { pop: true, rise: 58, crit: true, drift: drift * 0.5 });
        else if (ev.crit) addFloat(t, ev.dst, `${v}`, '#ff4a3a', ev.blocked ? 18 : 24, 1100, { pop: true, rise: 50, drift });
        else addFloat(t, ev.dst, `${v}`, mine ? '#ff6b6b' : '#ffffff', ev.blocked ? 14 : 18, 900, { drift });
      };
      if (at > now) state.pending.push({ at, fn: hit });
      else hit();
      break;
    }
    case 'heal': {
      if (ev.zone) {
        // 站在回血区里：小一号的数字，身上冒两个小十字
        addFloat(now, ev.dst, `+${ev.v}`, '#7cff9b', 13, 800, { rise: 30 });
        fx.zoneHeal(ev.dst, now);
        sfxAt('heal.tick', ev.dst, now, true);
        break;
      }
      // 自己放的治疗：等动作出手、绿光亮起来再飘数字；吸血、格挡回血等装备特效等那一下打中
      const land = state.lands.get(ev.dst);
      const proc = PROC_HEAL[ev.proc || ''];
      const show = proc
        ? () => {
          const t = gameNow();
          fx.procHeal(ev.dst, ev.proc!, t);
          sfxAt('heal.tick', ev.dst, t, true);
          addFloat(t, ev.dst, `${proc.label} +${ev.v}`, proc.color, 14, 900, { rise: 30 });
        }
        : () => addFloat(gameNow(), ev.dst, `+${ev.v}`, '#7cff9b', 18, 1000);
      if (land && land.at > now) state.pending.push({ at: land.at, fn: show });
      else show();
      break;
    }
    case 'buff':
      addFloat(now, ev.dst, String(ev.name || ''), '#9ad7ff', 15, 1200, { rise: 50 });
      break;
    case 'die': {
      state.bubbles.delete(ev.id);
      const e = state.ents.get(ev.id);
      if (e && e.deadAt < 0) e.deadAt = now;
      // 倒地时被打飞一小段（方向沿用最后一次受击），自己打死的再停一下、响收尾音
      if (e) onDeath(e, now);
      fx.death(ev.id, e ? e.color : '#ffffff', now);
      break;
    }
    case 'respawn':
      fx.respawn(ev.id, now);
      sfxAt('respawn', ev.id, now);
      addFloat(now, ev.id, '复活', '#7cff9b', 16, 1000);
      break;
    case 'say':
      state.bubbles.set(ev.id, { text: String(ev.text || ''), until: now + 3000 });
      break;
    case 'loot': {
      // 掉落：一颗稀有度颜色的光从怪物身上飞到拿到的人身上，头顶报装备名
      const item = ev.item ? state.items.get(ev.item) : undefined;
      const color = RARITY_COLOR[item?.rarity || 'common'] || RARITY_COLOR.common;
      const from = ev.src ? state.ents.get(ev.src) : undefined;
      const start = from ? posOf(from, now) : null;
      const flight = fx.loot(start, ev.dst, color, item?.rarity === 'epic', now);
      if (item) {
        const mine = ev.dst === state.myId;
        state.pending.push({
          at: now + flight,
          fn: () => {
            addFloat(gameNow(), ev.dst, `获得 ${item.name}`, color, mine ? 17 : 13, 1500, { pop: mine, rise: 54 });
            if (mine) sfxAt(`loot.${item.rarity || 'common'}`, ev.dst, gameNow());
          },
        });
      }
      break;
    }
    case 'interrupt': {
      // 前摇被打出硬直：举着的武器放下，预警圈收掉
      const e = state.ents.get(ev.id!);
      if (e) {
        e.windupFrom = 0;
        e.attackAt = -1e9;
      }
      fx.cancel(ev.id!);
      state.lands.delete(ev.id!);
      addFloat(now, ev.id!, '打断', '#ffffff', 16, 800, { pop: true, rise: 44 });
      sfxAt('interrupt', ev.id, now);
      break;
    }
    case 'lvl':
      fx.levelUp(ev.id, now);
      sfxAt('levelup', ev.id, now, !isMine(ev.id));
      addFloat(now, ev.id, `升级! Lv ${ev.lv}`, '#ffd54a', 26, 1600, { pop: true, rise: 60 });
      break;
  }
}

// 装备特效打出的伤害和治疗：飘字前缀和颜色（特效本身在 render/fx.ts 的 procHit / procHeal）
const PROC_DAMAGE: Record<string, { label: string; color: string }> = {
  thorns: { label: '反伤', color: '#d8dde6' },
  ignite: { label: '点燃', color: '#ff8a3a' },
  multishot: { label: '连射', color: '#f0e2b6' },
};
const PROC_HEAL: Record<string, { label: string; color: string }> = {
  lifesteal: { label: '吸血', color: '#ff7a8a' },
  block_heal: { label: '格挡', color: '#7cff9b' },
};

// addFloat 在实体头顶加一行飘字（实体消失后停在最后的位置）。
export function addFloat(
  now: number, anchorId: number, text: string, color: string, size: number, life: number, opts: FloatOpts = {},
): void {
  const e = state.ents.get(anchorId);
  if (!e) return;
  const p = posOf(e, now);
  // 同时打在一个目标上的数字散开，不叠在一起
  let recent = 0;
  for (const f of state.floats) if (f.anchor === anchorId && now - f.born < 300) recent++;
  state.floats.push({
    anchor: anchorId,
    x: p.x, y: p.y,
    oy: headY(e, p) - p.y - 16 - Math.min(recent, 4) * 13,
    jx: (recent % 2 ? 1 : -1) * Math.min(recent, 3) * 12 + (Math.random() - 0.5) * 10,
    text, color, size, life,
    born: now,
    rise: opts.rise ?? 40,
    pop: !!opts.pop,
    drift: opts.drift ?? 0,
    crit: !!opts.crit,
  });
}

// rollTo 让翻滚的人在翻滚动作的前大半段里从起点滑到终点（服务端是瞬间到位的）。
function rollTo(e: ClientEntity, ev: GameEvent, now: number, ms: number): void {
  const from = posOf(e, now);
  e.slide = { x0: from.x, y0: from.y, x1: ev.tx!, y1: ev.ty ?? e.y, at: now, ms: ms * ROLL_SLIDE };
  e.x = e.px = ev.tx!;
  e.y = e.py = ev.ty ?? e.y;
  e.t0 = now;
}

// pounceTo 让冲锋的怪在 dur 毫秒里从起点扑到终点（服务端也是这么快冲过去的），扑的时候摆出咬的姿势；
// 撞墙时头顶冒星星、报“晕眩”，直到服务端的硬直结束。
function pounceTo(e: ClientEntity, ev: GameEvent, now: number): void {
  const dur = Math.max(1, (ev.dur || 0) * 1000);   // 协议层已经换成秒
  e.slide = { x0: ev.x ?? e.x, y0: ev.y ?? e.y, x1: ev.tx!, y1: ev.ty ?? e.y, at: now, ms: dur };
  e.x = e.px = ev.tx!;
  e.y = e.py = ev.ty ?? e.y;
  e.t0 = now;
  e.attackAt = now;
  e.attackMs = Math.max(ATTACK_MS, dur + 160);
  e.windupFrom = 0;
  if (ev.wall && ev.stun) {
    const stunMs = ev.stun * 1000;
    state.fx!.dizzy(e.id, stunMs, now + dur);
    e.stunUntil = Math.max(e.stunUntil, now + dur + stunMs);
    addFloat(now + dur, e.id, '撞晕了！', '#ffe066', 16, 1200, { rise: 30, pop: true });
  }
}

// blinkTo 让闪现的人直接出现在终点（不做插值滑过去），并记下起点画残影。
function blinkTo(e: ClientEntity, ev: GameEvent, now: number): void {
  e.blinkFrom = { x: ev.x ?? e.x, y: ev.y ?? e.y, at: now };
  e.x = e.px = e.rx = ev.tx!;
  e.y = e.py = e.ry = ev.ty ?? e.y;
  e.t0 = now;
}

// 自己的出招还在前摇里（服务端这时不接受新的出招）
let busyUntil = 0;
export function castBusy(now: number): boolean {
  return now < busyUntil;
}

// —— 本地预测出手：按下技能键就先播动作和挥空声，不等服务端的 CAST 回来（省掉一个来回的延迟）。
// 服务端确认时（同一个技能、PREDICT_MS 内）动作接着播；没确认（被拒绝）这一下就是挥了个空。
const PREDICT_MS = 500;
let prediction: { skill: string; at: number; swing: boolean } | null = null;

// predictCast 在自己按下技能时调用：只预测单体和自身范围技能（位移、投掷要等服务端的落点）。
export function predictCast(skill: SkillInfo, targetId: number, now: number): void {
  const me = state.ents.get(state.myId);
  if (!me || me.dead || castBusy(now) || (skill.kind !== 'target' && skill.kind !== 'aoe') || !skill.fx) return;
  const actionName = me.model === 'ranger' ? `ranger:${skill.fx}` : skill.fx;
  const action = ACTIONS[actionName];
  if (!action) return;
  const target = targetId ? state.ents.get(targetId) : undefined;
  if (skill.kind === 'target') {
    // 单体技能要有够得着的目标才预测，不然服务端会拒绝（"目标太远"），白挥一下
    if (!target || target.dead || target.kind !== 'monster') return;
    const mp = posOf(me, now);
    const tp = posOf(target, now);
    if (hypot(mp.x, mp.y, tp.x, tp.y) - (me.r || 14) - (target.r || 14) > (skill.range || 0) + 10) return;
  }
  if (target) { const tp = posOf(target, now); faceToward(me, tp.x, tp.y, now); }
  me.attackAt = now;
  me.action = actionName;
  me.attackMs = action.ms;
  const swing = skill.fx === 'melee';
  if (swing) predictSwing(skill.id, me, now, action.lead);
  prediction = { skill: skill.id, at: now, swing };
}

// takePrediction 在收到自己的 CAST 时调用：这个技能刚预测过就返回 true（并用掉这次预测）。
function takePrediction(skill: string | undefined, now: number): boolean {
  const hit = !!prediction && prediction.skill === skill && now - prediction.at < PREDICT_MS;
  if (hit) lastConfirmed = prediction;
  prediction = null;
  return hit;
}
let lastConfirmed: { skill: string; at: number; swing: boolean } | null = null;

// predictedSwing 说明这个技能的挥空声在预测时已经响过了。
function predictedSwing(skill: string | undefined): boolean {
  const confirmed = lastConfirmed;
  lastConfirmed = null;
  return !!confirmed && confirmed.skill === skill && confirmed.swing;
}

function predictSwing(skill: string, me: ClientEntity, now: number, lead: number): void {
  onCast({ k: 'cast', src: me.id, skill, fx: 'melee' }, me, now, lead);
}
