// 玩家设置：音量（音效、环境声、音乐）、震屏强度、受击闪白、手柄 / 手机震动、清场慢放。
// 存在浏览器本地（localStorage），设置面板（ui/settings.ts）改，各模块直接读 SETTINGS。
// 总音量和静音还在 audio/engine.ts 里（M 键），这里不重复存。
//
// 系统开了“减少动态效果”（prefers-reduced-motion）时，第一次打开的默认值是：震屏 30%、不闪白、不慢放。

export interface Settings {
  sfx: number;        // 音效音量 0..1
  ambience: number;   // 环境声音量 0..1
  music: number;      // 副本音乐音量 0..1（audio/music.ts）
  shake: number;      // 震屏、镜头冲击、缩放冲击的强度 0..1
  flash: boolean;     // 受击闪白
  rumble: boolean;    // 手柄 / 手机震动
  slowmo: boolean;    // 清场、击杀首领时的慢放
}

const STORE_KEY = 'btdemo.settings';

function defaults(): Settings {
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return {
    sfx: 1,
    ambience: 0.7,
    music: 0.6,
    shake: reduced ? 0.3 : 1,
    flash: !reduced,
    rumble: true,
    slowmo: !reduced,
  };
}

export const SETTINGS: Settings = load();

const listeners: ((settings: Settings) => void)[] = [];

function load(): Settings {
  const base = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      for (const key of Object.keys(base) as (keyof Settings)[]) {
        if (typeof saved[key] === typeof base[key]) (base as unknown as Record<string, unknown>)[key] = saved[key];
      }
    }
  } catch {
    // 隐私模式、存储被禁用：用默认值
  }
  base.sfx = clamp01(base.sfx);
  base.ambience = clamp01(base.ambience);
  base.music = clamp01(base.music);
  base.shake = clamp01(base.shake);
  return base;
}

// updateSettings 改几项设置、存起来并通知订阅者（音量要立刻生效）。
export function updateSettings(change: Partial<Settings>): void {
  Object.assign(SETTINGS, change);
  SETTINGS.sfx = clamp01(SETTINGS.sfx);
  SETTINGS.ambience = clamp01(SETTINGS.ambience);
  SETTINGS.music = clamp01(SETTINGS.music);
  SETTINGS.shake = clamp01(SETTINGS.shake);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(SETTINGS));
  } catch {
    // 存不了就只在这次打开里生效
  }
  for (const listener of listeners) listener(SETTINGS);
}

// resetSettings 恢复默认值。
export function resetSettings(): void {
  updateSettings(defaults());
}

// onSettings 订阅设置变化。
export function onSettings(listener: (settings: Settings) => void): void {
  listeners.push(listener);
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}
