// 程序化音效配方：每个声音是一个函数，用 Kit 的积木在时间 t 拼出来，返回声音持续的秒数。
// p 是这次播放的音高系数（引擎每次随机 ±5%，同一个声音连播不会像复读机）。
//
// 命名：类别.细分……，比如 hit.blade.bone.heavy（武器.材质.档位）。
// 找不到的名字按 resolve() 的规则退到更通用的声音，所以以后换真实素材时可以只录几个通用音。

import type { Kit } from './kit';

export type Recipe = (kit: Kit, t: number, p: number) => number;

export const WEAPONS = ['blade', 'blunt', 'arrow', 'claw', 'fire', 'frost', 'magic'] as const;
export const MATERIALS = ['metal', 'bone', 'flesh', 'beast', 'goo', 'wood'] as const;
export const TIERS = ['light', 'medium', 'heavy'] as const;
export type Weapon = typeof WEAPONS[number];
export type Material = typeof MATERIALS[number];
export type Tier = typeof TIERS[number];

// 档位的整体音量和低频份量
const TIER_GAIN: Record<Tier, number> = { light: 0.55, medium: 0.75, heavy: 1 };

// weaponLayer 是"什么东西打上去"：刀刃的切、钝器的砸、箭的扎……
function weaponLayer(kit: Kit, t: number, p: number, weapon: Weapon, tier: Tier): void {
  const g = TIER_GAIN[tier];
  // 所有命中都有一个极短的"咔"，让耳朵知道命中的精确时刻
  kit.noise(t, 0.012, 'highpass', 3200 * p, 3200, 0.7, 0.55 * g, 0.001);
  switch (weapon) {
    case 'blade':
      kit.noise(t, 0.07, 'bandpass', 3400 * p, 1300, 1.4, 0.45 * g, 0.002);
      break;
    case 'blunt':
      kit.tone(t, 'sine', 150 * p, 48, 0.2 + g * 0.15, 0.55 * g);
      kit.noise(t, 0.16, 'lowpass', 1600 * p, 250, 0.7, 0.5 * g, 0.003);
      break;
    case 'arrow':
      kit.noise(t, 0.03, 'bandpass', 2200 * p, 1400, 3, 0.4 * g, 0.001);
      kit.tone(t, 'triangle', 420 * p, 180, 0.06, 0.25 * g);
      break;
    case 'claw':
      kit.noise(t, 0.05, 'bandpass', 2600 * p, 1100, 2.5, 0.4 * g, 0.001);
      kit.noise(t + 0.035, 0.05, 'bandpass', 2300 * p, 900, 2.5, 0.3 * g, 0.001);
      break;
    case 'fire':
      kit.noise(t, 0.28, 'lowpass', 2200 * p, 320, 0.8, 0.55 * g, 0.004);
      kit.crackle(t + 0.02, 0.3, 6, 0.18 * g);
      break;
    case 'frost':
      kit.metal(t, 2300 * p, [1, 1.33, 1.87, 2.52], 0.35, 0.12 * g, 0.25);
      kit.noise(t, 0.12, 'highpass', 5000, 3000, 0.7, 0.3 * g, 0.002);
      break;
    case 'magic':
      kit.tone(t, 'sine', 880 * p, 330, 0.18, 0.22 * g, 0.003, 0.2);
      kit.noise(t, 0.12, 'bandpass', 1800 * p, 600, 1.5, 0.3 * g, 0.003);
      break;
  }
}

// materialLayer 是"打在什么上面"：骨头脆、肉闷、盔甲叮当、史莱姆噗叽。
function materialLayer(kit: Kit, t: number, p: number, material: Material, tier: Tier): void {
  const g = TIER_GAIN[tier];
  switch (material) {
    case 'flesh':
      kit.tone(t, 'sine', 170 * p, 62, 0.12 + g * 0.06, 0.7 * g);
      kit.noise(t, 0.09, 'lowpass', 2000 * p, 400, 0.8, 0.4 * g, 0.002);
      break;
    case 'beast':
      kit.tone(t, 'sine', 200 * p, 75, 0.12, 0.6 * g);
      kit.noise(t, 0.11, 'bandpass', 1300 * p, 500, 1.2, 0.4 * g, 0.002);
      break;
    case 'metal':
      kit.metal(t, 700 * p, [1, 1.62, 2.31, 3.07], 0.18 + g * 0.12, 0.22 * g, 0.12);
      kit.tone(t, 'sine', 220 * p, 110, 0.07, 0.4 * g);
      break;
    case 'bone':
      kit.noise(t, 0.04, 'bandpass', 1800 * p, 900, 4, 0.6 * g, 0.001);
      kit.noise(t + 0.028, 0.05, 'bandpass', 2700 * p, 1300, 5, 0.38 * g, 0.001);
      kit.tone(t, 'sine', 230 * p, 120, 0.06, 0.35 * g);
      break;
    case 'goo':
      kit.tone(t, 'sine', 330 * p, 85, 0.2, 0.55 * g);
      kit.noise(t, 0.22, 'lowpass', 900 * p, 180, 7, 0.45 * g, 0.012);
      break;
    case 'wood':
      kit.noise(t, 0.08, 'bandpass', 650 * p, 420, 3.5, 0.6 * g, 0.002);
      kit.tone(t, 'triangle', 310 * p, 200, 0.07, 0.3 * g);
      break;
  }
  if (tier === 'heavy') {
    // 重击：再垫一层次低频和碎屑尾巴
    kit.tone(t, 'sine', 95 * p, 34, 0.42, 0.45);
    kit.noise(t + 0.05, 0.45, 'bandpass', 2400, 700, 1.6, 0.12, 0.02);
  }
}

// swing 是挥空的风声：轻的短促尖，重的长而低。
function swing(kit: Kit, t: number, p: number, low: number, high: number, duration: number, peak: number): number {
  kit.noise(t, duration, 'bandpass', low * p, high * p, 1.1, peak, duration * 0.45);
  return duration + 0.05;
}

export const RECIPES: Record<string, Recipe> = {
  // —— 挥空（动作开始时）
  'swing.light': (k, t, p) => swing(k, t, p, 700, 3400, 0.16, 0.32),
  'swing.medium': (k, t, p) => swing(k, t, p, 500, 2600, 0.22, 0.38),
  'swing.heavy': (k, t, p) => {
    k.tone(t, 'sine', 70 * p, 55, 0.3, 0.18, 0.12);
    return swing(k, t, p, 260, 1500, 0.34, 0.45);
  },
  'swing.claw': (k, t, p) => swing(k, t, p, 1200, 3800, 0.1, 0.26),

  // —— 命中上的附加层
  'hit.crit': (k, t, p) => {
    k.metal(t + 0.004, 1900 * p, [1, 1.51, 2.37], 0.6, 0.16, 0.35);
    k.tone(t, 'sine', 130 * p, 40, 0.3, 0.6);
    return 0.7;
  },
  'block': (k, t, p) => {
    k.noise(t, 0.02, 'highpass', 4200, 4200, 0.7, 0.5, 0.001);
    k.metal(t, 620 * p, [1, 1.62, 2.31, 3.07, 4.18], 0.42, 0.26, 0.25);
    k.tone(t, 'sine', 260 * p, 120, 0.08, 0.3);
    return 0.6;
  },
  'block.raise': (k, t, p) => {
    k.noise(t, 0.09, 'bandpass', 900 * p, 1600, 1.4, 0.16, 0.03);
    k.metal(t + 0.06, 900 * p, [1, 2.4, 3.9], 0.12, 0.06);
    return 0.25;
  },
  'immune': (k, t, p) => {
    k.metal(t, 1500 * p, [1, 1.5, 2.0, 3.0], 0.7, 0.14, 0.5);
    k.tone(t, 'sine', 300, 300, 0.1, 0.15);
    return 0.9;
  },
  'shield.hit': (k, t, p) => {
    k.tone(t, 'sine', 520 * p, 760, 0.18, 0.18, 0.004, 0.3);
    k.noise(t, 0.15, 'bandpass', 2800 * p, 4200, 4, 0.15, 0.004);
    return 0.4;
  },
  'shield.break': (k, t, p) => {
    k.noise(t, 0.4, 'highpass', 6000, 2500, 0.8, 0.35, 0.002, 0.3);
    k.metal(t, 1300 * p, [1, 1.41, 2.13, 2.88], 0.35, 0.18, 0.3);
    return 0.7;
  },
  'proc': (k, t, p) => {
    k.tone(t, 'triangle', 1200 * p, 900, 0.08, 0.12, 0.002, 0.2);
    return 0.2;
  },

  // —— 击杀和生死
  'kill': (k, t, p) => {
    k.tone(t, 'sine', 80 * p, 30, 0.6, 0.9);
    k.noise(t, 0.5, 'lowpass', 1200, 120, 0.6, 0.45, 0.004);
    k.metal(t + 0.02, 1240 * p, [1, 1.5, 2.25], 0.9, 0.09, 0.6);
    return 1.1;
  },
  'die.fall': (k, t, p) => {
    k.noise(t + 0.18, 0.18, 'lowpass', 700 * p, 150, 0.7, 0.4, 0.004);
    k.tone(t + 0.18, 'sine', 110 * p, 50, 0.16, 0.45);
    k.noise(t + 0.34, 0.12, 'lowpass', 500 * p, 120, 0.7, 0.2, 0.004);
    return 0.6;
  },
  'respawn': (k, t, p) => {
    k.arpeggio(t, [392 * p, 523 * p, 659 * p, 784 * p], 0.07, 0.5, 0.12, 'triangle', 0.4);
    return 1;
  },

  // —— 技能（出手时）
  'cast.whirl': (k, t, p) => {
    swing(k, t, p, 300, 2200, 0.25, 0.4);
    swing(k, t + 0.16, p * 1.1, 350, 2600, 0.25, 0.36);
    k.tone(t, 'sine', 60 * p, 45, 0.45, 0.25, 0.1);
    return 0.6;
  },
  'cast.fire': (k, t, p) => {
    k.noise(t, 0.35, 'lowpass', 500 * p, 2600, 0.9, 0.42, 0.06);
    k.crackle(t + 0.05, 0.3, 5, 0.12);
    return 0.45;
  },
  'cast.bow': (k, t, p) => {
    k.tone(t, 'triangle', 190 * p, 150, 0.12, 0.3);
    k.noise(t, 0.04, 'bandpass', 2600 * p, 1800, 3, 0.2, 0.001);
    k.noise(t + 0.02, 0.14, 'bandpass', 3800 * p, 2200, 6, 0.08, 0.02);
    return 0.25;
  },
  'cast.bow.heavy': (k, t, p) => {
    k.tone(t, 'triangle', 150 * p, 110, 0.18, 0.4);
    k.noise(t, 0.05, 'bandpass', 2000 * p, 1400, 3, 0.25, 0.001);
    k.noise(t + 0.02, 0.35, 'bandpass', 2600 * p, 5200, 5, 0.14, 0.04);
    return 0.45;
  },
  'cast.axe': (k, t, p) => {
    for (let i = 0; i < 4; i++) k.noise(t + i * 0.07, 0.06, 'bandpass', 900 * p, 2200, 1.5, 0.22 - i * 0.03, 0.025);
    return 0.4;
  },
  'cast.rain': (k, t, p) => {
    k.tone(t, 'triangle', 170 * p, 130, 0.14, 0.3);
    for (let i = 0; i < 6; i++) k.noise(t + 0.3 + i * 0.06, 0.18, 'bandpass', 4200 * p, 1800, 6, 0.06, 0.06);
    return 0.9;
  },
  'cast.magic': (k, t, p) => {
    k.tone(t, 'sine', 400 * p, 820, 0.18, 0.14, 0.02, 0.3);
    k.noise(t, 0.2, 'bandpass', 900 * p, 2400, 2, 0.12, 0.05);
    return 0.35;
  },
  'cast.frost': (k, t, p) => {
    k.tone(t, 'sine', 90 * p, 40, 0.35, 0.6);
    k.noise(t, 0.4, 'highpass', 2500 * p, 7000, 0.7, 0.3, 0.004);
    k.metal(t + 0.02, 2100 * p, [1, 1.25, 1.68, 2.44, 3.1], 0.8, 0.09, 0.5);
    return 0.9;
  },
  'cast.heal': (k, t, p) => {
    k.arpeggio(t, [523 * p, 659 * p, 784 * p, 1046 * p], 0.06, 0.55, 0.1);
    return 1;
  },
  'cast.roar': (k, t, p) => {
    k.tone(t, 'sawtooth', 110 * p, 85, 0.5, 0.12, 0.06);
    k.noise(t, 0.55, 'bandpass', 500 * p, 300, 3, 0.3, 0.08);
    return 0.7;
  },
  'cast.shield': (k, t, p) => {
    k.tone(t, 'sine', 330 * p, 660, 0.35, 0.16, 0.05, 0.4);
    k.tone(t, 'sine', 495 * p, 990, 0.35, 0.08, 0.05, 0.4);
    k.metal(t + 0.3, 1320 * p, [1, 2.01, 3.0], 0.5, 0.06, 0.5);
    return 0.9;
  },
  'cast.haste': (k, t, p) => {
    k.noise(t, 0.4, 'bandpass', 600 * p, 4200, 1.8, 0.26, 0.15);
    k.tone(t, 'sine', 300 * p, 900, 0.35, 0.07, 0.1, 0.3);
    return 0.5;
  },
  'cast.holy': (k, t, p) => {
    k.metal(t, 523 * p, [1, 2, 3.01, 4.2], 1.4, 0.18, 0.6);
    k.arpeggio(t + 0.05, [659 * p, 784 * p, 1046 * p], 0.08, 0.9, 0.06);
    return 1.6;
  },
  'cast.enchant': (k, t, p) => {
    k.noise(t, 0.12, 'bandpass', 3000, 1500, 2, 0.2, 0.002);
    k.noise(t + 0.05, 0.6, 'lowpass', 300 * p, 1800, 0.8, 0.4, 0.15);
    k.crackle(t + 0.1, 0.6, 9, 0.12);
    return 0.8;
  },
  'cast.blink': (k, t, p) => {
    k.tone(t, 'sine', 1400 * p, 220, 0.18, 0.18, 0.004, 0.35);
    k.noise(t, 0.16, 'highpass', 6000, 1500, 0.7, 0.2, 0.004);
    return 0.4;
  },
  'cast.roll': (k, t, p) => {
    k.noise(t, 0.22, 'bandpass', 500 * p, 1200, 1, 0.22, 0.06);
    k.noise(t + 0.26, 0.1, 'lowpass', 600, 150, 0.7, 0.25, 0.004);
    return 0.45;
  },
  'cast.zone': (k, t, p) => {
    k.arpeggio(t, [392 * p, 587 * p, 784 * p], 0.09, 0.8, 0.08);
    for (let i = 0; i < 5; i++) k.tone(t + 0.15 + i * 0.07, 'sine', (500 + Math.random() * 500) * p, 1300, 0.05, 0.05, 0.004, 0.3);
    return 1.2;
  },
  'cast.focus': (k, t, p) => {
    k.tone(t, 'sine', 1600 * p, 1600, 0.05, 0.12, 0.002, 0.2);
    k.tone(t + 0.09, 'sine', 2400 * p, 2400, 0.2, 0.1, 0.002, 0.4);
    return 0.5;
  },
  'cast.summon': (k, t, p) => {
    k.tone(t, 'sine', 300 * p, 1200, 0.3, 0.1, 0.02, 0.4);
    for (let i = 0; i < 5; i++) k.tone(t + 0.1 + i * 0.05, 'sine', (1500 + i * 300) * p, 1500 + i * 300, 0.12, 0.05, 0.003, 0.4);
    return 0.8;
  },

  // —— 回血、成长、拾取
  'heal.tick': (k, t, p) => {
    k.tone(t, 'sine', 880 * p, 1100, 0.12, 0.05, 0.004, 0.3);
    return 0.3;
  },
  'levelup': (k, t, p) => {
    k.arpeggio(t, [523 * p, 659 * p, 784 * p, 1046 * p, 1318 * p], 0.08, 0.9, 0.12, 'triangle', 0.45);
    k.tone(t, 'sine', 130 * p, 130, 0.9, 0.12, 0.02);
    return 1.5;
  },
  'loot.common': (k, t, p) => {
    k.tone(t, 'triangle', 988 * p, 988, 0.12, 0.1, 0.002, 0.2);
    return 0.3;
  },
  'loot.rare': (k, t, p) => {
    k.arpeggio(t, [988 * p, 1318 * p], 0.07, 0.35, 0.1);
    return 0.6;
  },
  'loot.epic': (k, t, p) => {
    k.arpeggio(t, [784 * p, 988 * p, 1175 * p, 1568 * p], 0.07, 0.7, 0.12, 'triangle', 0.5);
    k.metal(t + 0.25, 1568 * p, [1, 2.01, 2.99], 1, 0.05, 0.6);
    return 1.3;
  },

  // —— 界面
  'ui.deny': (k, t, p) => {
    k.tone(t, 'square', 180 * p, 150, 0.1, 0.06);
    return 0.15;
  },
  'ui.toggle': (k, t, p) => {
    k.tone(t, 'triangle', 1200 * p, 1200, 0.04, 0.08);
    return 0.1;
  },
};

// 命中声 = 武器层 + 材质层，按"武器 × 材质 × 档位"全部注册，名字形如 hit.blade.bone.heavy
for (const weapon of WEAPONS) {
  for (const material of MATERIALS) {
    for (const tier of TIERS) {
      RECIPES[`hit.${weapon}.${material}.${tier}`] = (kit, t, p) => {
        weaponLayer(kit, t, p, weapon, tier);
        materialLayer(kit, t, p, material, tier);
        return tier === 'heavy' ? 0.6 : 0.35;
      };
    }
  }
}

// fallbacks 列出 name 找不到时依次尝试的名字：从倒数第二段往前逐段换成 *，最后只留类别。
// hit.blade.bone.heavy → hit.blade.*.heavy → hit.*.*.heavy → hit
export function fallbacks(name: string): string[] {
  const parts = name.split('.');
  const out = [name];
  for (let i = parts.length - 2; i >= 1; i--) {
    parts[i] = '*';
    out.push(parts.join('.'));
  }
  if (parts.length > 1) out.push(parts[0]);
  return out;
}
