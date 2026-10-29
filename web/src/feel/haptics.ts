// 震动：手柄（Gamepad 的 vibrationActuator）和手机（navigator.vibrate）。
//
// 只在自己参与的命中时调用（director.ts），强度 0..1 按档位给（profiles.ts 的 rumble）。
// 手柄是“强 / 弱”两个马达：重的一下强马达多，轻的一下只用弱马达。手机只能开关，所以只按时长区分，
// 而且太轻的不震（手机一直嗡嗡会烦）。iPhone 的浏览器不支持网页震动，调用了也没反应。
// 设置里关了震动（SETTINGS.rumble）就都不震。

import { SETTINGS } from '../game/settings';

const PHONE_MIN = 0.3;          // 手机上低于这个强度不震
const MIN_GAP_MS = 40;          // 两次震动至少隔这么久（范围技能一下打中一群只震一次）

let lastAt = -1e9;
let lastStrength = 0;

interface Actuator {
  playEffect?: (type: string, params: Record<string, number>) => Promise<unknown>;
}

// rumble 震一下：strength 0..1，ms 是时长。now 是演出时钟（同一时刻的多次只取最强的一次）。
export function rumble(strength: number, ms: number, now: number): void {
  if (!SETTINGS.rumble || strength <= 0.02) return;
  if (now - lastAt < MIN_GAP_MS && strength <= lastStrength) return;
  lastAt = now;
  lastStrength = strength;
  const duration = Math.round(ms);
  let gamepad = false;
  const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  for (const pad of pads) {
    const actuator = (pad as (Gamepad & { vibrationActuator?: Actuator }) | null)?.vibrationActuator;
    if (!actuator?.playEffect) continue;
    gamepad = true;
    actuator.playEffect('dual-rumble', {
      duration,
      startDelay: 0,
      strongMagnitude: Math.min(1, Math.max(0, strength * 1.2 - 0.25)),
      weakMagnitude: Math.min(1, 0.25 + strength * 0.6),
    }).catch(() => {});
  }
  // 有手柄时手机不再震（同时用的情况很少，避免重复）
  if (!gamepad && strength >= PHONE_MIN && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(duration);
    } catch {
      // 有的浏览器在没有用户操作前调用会报错
    }
  }
}
