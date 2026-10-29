// 打击感档位表：每次命中先定一个档（轻 / 中 / 重，外加格挡、免疫），再按档查这里的参数。
// 取代以前 FEEL 里的全局顿帧和击退：重锤和斩击终于不一样重了。
// ?fxlab 实验页里可以逐档拖滑条，并导出 JSON 粘回这里。
//
// 现在（P0）档位由前端按技能名查 SKILL_FEEL；以后服务端会直接在 DAMAGE 事件里给档位。

import type { Material, Tier, Weapon } from '../audio/recipes';

export interface Profile {
  hitStopMs: number;  // 顿帧：双方动作停住多久
  knockPx: number;    // 受击者被推开的显示距离（像素）
  squash: number;     // 受击形变幅度
  kickOut: number;    // 自己打中别人时镜头被推的强度（像素）
  kickIn: number;     // 自己挨打时镜头被推的强度
  shake: number;      // 自己参与时加的震动强度（像素，0 不震）
}

export type ProfileName = Tier | 'block' | 'immune';

export const PROFILES: Record<ProfileName, Profile> = {
  light: { hitStopMs: 60, knockPx: 6, squash: 0.16, kickOut: 2.5, kickIn: 4, shake: 0 },
  medium: { hitStopMs: 80, knockPx: 10, squash: 0.22, kickOut: 4, kickIn: 5.5, shake: 0 },
  heavy: { hitStopMs: 110, knockPx: 16, squash: 0.3, kickOut: 6, kickIn: 8, shake: 3.5 },
  block: { hitStopMs: 90, knockPx: 4, squash: 0.08, kickOut: 2, kickIn: 3, shake: 0 },
  immune: { hitStopMs: 40, knockPx: 0, squash: 0, kickOut: 1, kickIn: 1, shake: 0 },
};

// 暴击在本档上叠加
export const CRIT = { hitStopMs: 40, knockScale: 1.6, kickScale: 1.6, zoom: 0.035 };

// 倒地时尸体被打飞的距离（像素）
export const DEATH_KNOCK_PX = 18;
// 致命一击（自己或自己的宠物打死的）：再停一下、飞得更远、镜头放大
export const KILL = { hitStopMs: 90, knockScale: 1.5, zoom: 0.03 };

// 每个技能的档位和武器种类（技能 id 见 config/skills.yaml）。没列出的按 fx 猜，见 skillFeel()。
export const SKILL_FEEL: Record<string, { tier: Tier; weapon: Weapon }> = {
  slash: { tier: 'light', weapon: 'blade' },
  whirlwind: { tier: 'heavy', weapon: 'blade' },
  axe: { tier: 'medium', weapon: 'blade' },
  fireball: { tier: 'medium', weapon: 'fire' },
  frost_nova: { tier: 'medium', weapon: 'frost' },
  shot: { tier: 'light', weapon: 'arrow' },
  pierce_shot: { tier: 'medium', weapon: 'arrow' },
  arrow_rain: { tier: 'light', weapon: 'arrow' },
  frost_arrow: { tier: 'medium', weapon: 'frost' },
  bite: { tier: 'light', weapon: 'claw' },
  heavy_bite: { tier: 'heavy', weapon: 'claw' },
  arrow: { tier: 'light', weapon: 'arrow' },
  smash: { tier: 'heavy', weapon: 'blunt' },
  boss_whirl: { tier: 'heavy', weapon: 'blunt' },
  guard_hit: { tier: 'medium', weapon: 'blade' },
  pet_bite: { tier: 'light', weapon: 'claw' },
  pet_firebolt: { tier: 'light', weapon: 'fire' },
  pet_flare: { tier: 'medium', weapon: 'fire' },
  pet_thorn: { tier: 'light', weapon: 'magic' },
};

// 装备特效打出的伤害：都算轻击，武器按特效
const PROC_WEAPON: Record<string, Weapon> = { thorns: 'blade', ignite: 'fire', multishot: 'arrow' };

// 模型的材质：决定命中声和（以后的）命中火花
export const MODEL_MATERIAL: Record<string, Material> = {
  knight: 'metal',
  guard: 'metal',
  ranger: 'flesh',
  villager: 'flesh',
  skeleton_archer: 'bone',
  slime: 'goo',
  wolf: 'beast',
  wolf_pup: 'beast',
  ogre_chief: 'flesh',
  ember: 'wood',
  sprout: 'wood',
};

// skillFeel 给出一次伤害的档位和武器：先查技能表，再看装备特效，最后按施法 fx 猜。
export function skillFeel(skill: string | undefined, proc: string | undefined, fx: string | undefined): { tier: Tier; weapon: Weapon } {
  if (proc) return { tier: 'light', weapon: PROC_WEAPON[proc] ?? 'magic' };
  const known = skill ? SKILL_FEEL[skill] : undefined;
  if (known) return known;
  switch (fx) {
    case 'circle': return { tier: 'heavy', weapon: 'blade' };
    case 'projectile': return { tier: 'medium', weapon: 'magic' };
    case 'arrow': case 'rain': return { tier: 'light', weapon: 'arrow' };
    case 'pierce': return { tier: 'medium', weapon: 'arrow' };
    case 'frost': case 'frostarrow': return { tier: 'medium', weapon: 'frost' };
    case 'axe': return { tier: 'medium', weapon: 'blade' };
    default: return { tier: 'light', weapon: 'blade' };
  }
}
