// 把服务端事件（施法、伤害、死亡……）变成动画、特效和飘字。

import type { GameEvent } from '../net/types';
import { cameraKick, cameraPunch } from '../render/camera';
import { FEEL, LOOK_FIRE } from './config';
import { hypot } from './math';
import { faceToward, headY, posOf, state, type ClientEntity, type FloatOpts } from './state';

export function onEvent(ev: GameEvent, now: number): void {
  const fx = state.fx!;
  switch (ev.k) {
    case 'cast': {
      const src = state.ents.get(ev.src);
      if (src) {
        src.attackAt = now;
        const dst = ev.dst && ev.dst !== ev.src ? state.ents.get(ev.dst) : null;
        if (dst) { const dp = posOf(dst, now); faceToward(src, dp.x, dp.y, now); }
        else if (typeof ev.tx === 'number' && typeof ev.x === 'number' && Math.abs(ev.tx - ev.x) > 1) {
          faceToward(src, ev.tx, ev.ty ?? src.y, now);   // 闪现、没打中的飞斧：朝飞出去的方向
        }
        if (ev.fx === 'blink' && typeof ev.tx === 'number') blinkTo(src, ev, now);
        // 武器着火时，物理技能的刀光和命中火花都换成火焰色
        if (src.looks & LOOK_FIRE && (ev.fx === 'melee' || ev.fx === 'circle' || ev.fx === 'axe')) ev = { ...ev, color: '#ff7a2a' };
      }
      const delay = fx.cast(ev, now);
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
      const land = state.lands.get(ev.src);
      const at = land && land.at > now ? land.at : now;
      const color = land ? land.color : '#ffd166';
      const hit = () => {
        const t = performance.now();
        const e = state.ents.get(ev.dst);
        const v = ev.v || 0;
        let side = Math.random() < 0.5 ? -1 : 1;
        if (e) {
          e.hitAt = t;
          const push = feelHit(e, ev.src, !!ev.crit, !!ev.blocked, v, t);
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
        if (ev.blocked) {
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
    case 'heal':
      addFloat(now, ev.dst, `+${ev.v}`, '#7cff9b', 18, 1000);
      break;
    case 'buff':
      addFloat(now, ev.dst, String(ev.name || ''), '#9ad7ff', 15, 1200, { rise: 50 });
      break;
    case 'die': {
      state.bubbles.delete(ev.id);
      const e = state.ents.get(ev.id);
      if (e && e.deadAt < 0) e.deadAt = now;
      // 倒地时被打飞一小段（方向沿用最后一次受击）
      if (e) e.knockAmp = FEEL.knockPx * 3;
      fx.death(ev.id, e ? e.color : '#ffffff', now);
      break;
    }
    case 'respawn':
      fx.respawn(ev.id, now);
      addFloat(now, ev.id, '复活', '#7cff9b', 16, 1000);
      break;
    case 'say':
      state.bubbles.set(ev.id, { text: String(ev.text || ''), until: now + 3000 });
      break;
    case 'lvl':
      fx.levelUp(ev.id, now);
      addFloat(now, ev.id, `升级! Lv ${ev.lv}`, '#ffd54a', 26, 1600, { pop: true, rise: 60 });
      break;
  }
}

// feelHit 处理一次命中的打击感：双方顿帧、受击方向、镜头冲击、连击数。
// 返回受击方向的横向分量（伤害数字往这边飘）。
function feelHit(target: ClientEntity, srcId: number, crit: boolean, blocked: boolean, damage: number, now: number): number {
  const src = srcId ? state.ents.get(srcId) : undefined;
  const tp = posOf(target, now);
  let dx = 0;
  let dy = 0;
  if (src && src !== target) {
    const sp = posOf(src, now);
    const len = Math.hypot(tp.x - sp.x, tp.y - sp.y);
    if (len > 0.5) { dx = (tp.x - sp.x) / len; dy = (tp.y - sp.y) / len; }
  }
  if (dx === 0 && dy === 0) dx = Math.cos(target.facing) < 0 ? 1 : -1;   // 不知道谁打的：往身后推
  target.knockX = dx;
  target.knockY = dy;
  const amp = blocked ? FEEL.knockPx * 0.5 : FEEL.knockPx * (crit ? 1.7 : 1);
  // 已经倒地（箭比死亡事件晚到）时保留被打飞的距离
  target.knockAmp = target.dead ? Math.max(target.knockAmp, amp) : amp;

  // 顿帧：受击者停住；近战的攻击者也停（远程的箭飞到时攻击动作早就结束了）
  const stop = blocked ? FEEL.hitStopBlockMs : crit ? FEEL.hitStopCritMs : FEEL.hitStopMs;
  target.freezeUntil = Math.max(target.freezeUntil, now + stop);
  const srcPos = src ? posOf(src, now) : null;
  if (src && srcPos && src !== target && hypot(srcPos.x, srcPos.y, tp.x, tp.y) < 140) src.freezeUntil = Math.max(src.freezeUntil, now + stop);

  // 镜头：只在自己打人或被打时动，旁边 NPC 互殴不晃屏幕
  if (srcId === state.myId && target.id !== state.myId) {
    cameraKick(dx, dy, crit ? 7 : 2.5);
    if (crit) cameraPunch(FEEL.zoomPunch);
    // 一次范围技能同时打中好几个只算一击（同一时刻的命中合并）
    const combo = state.combo;
    if (damage > 0 && now - combo.at > 1) {
      combo.n = now - combo.at < 2000 ? combo.n + 1 : 1;
      combo.at = now;
    }
  } else if (target.id === state.myId) {
    cameraKick(dx, dy, blocked ? 3 : crit ? 8 : 4.5);
    if (damage > 0) state.hurtAt = now;
  }
  return dx;
}

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

// blinkTo 让闪现的人直接出现在终点（不做插值滑过去），并记下起点画残影。
function blinkTo(e: ClientEntity, ev: GameEvent, now: number): void {
  e.blinkFrom = { x: ev.x ?? e.x, y: ev.y ?? e.y, at: now };
  e.x = e.px = e.rx = ev.tx!;
  e.y = e.py = e.ry = ev.ty ?? e.y;
  e.t0 = now;
}
