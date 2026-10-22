// 把服务端事件（施法、伤害、死亡……）变成动画、特效和飘字。

import type { GameEvent } from '../net/types';
import { faceToward, headY, posOf, state, type FloatOpts } from './state';

export function onEvent(ev: GameEvent, now: number): void {
  const fx = state.fx!;
  switch (ev.k) {
    case 'cast': {
      const src = state.ents.get(ev.src);
      if (src) {
        src.attackAt = now;
        const dst = ev.dst && ev.dst !== ev.src ? state.ents.get(ev.dst) : null;
        if (dst) { const dp = posOf(dst, now); faceToward(src, dp.x, dp.y, now); }
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
        if (e) e.hitAt = t;
        const v = ev.v || 0;
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
        if (ev.crit) addFloat(t, ev.dst, `暴击 ${v}`, '#ffe14d', ev.blocked ? 20 : 26, 1100, { pop: true, rise: 54 });
        else addFloat(t, ev.dst, `-${v}`, ev.dst === state.myId ? '#ff6b6b' : '#ffffff', ev.blocked ? 14 : 17, 900);
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
  });
}
