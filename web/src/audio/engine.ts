// 音频引擎：总线、限幅、混响、声像和距离衰减、并发限制。
//
//   声音 → 声像（按屏幕左右）→ 距离衰减（远了变小变闷）→ 总线（sfx / ui）→ 主音量 → 限幅器 → 扬声器
//                                                         ↘ 混响（金属、铃声的尾音）↗
//
// 浏览器要求用户点过页面才能出声，所以第一次按键或点击时才创建 AudioContext；在那之前 play() 什么都不做。
// 声音先找烘焙好的素材（audio/audio.json 的图集，见 sprite.ts；地址带 ?sfx=live 时不读），
// 没有就用 recipes.ts 的配方实时合成。每个声音的音量、音高微调在 mix.ts。

import { state } from '../game/state';
import { Kit, makeImpulse, makeNoiseBuffer } from './kit';
import { MIX } from './mix';
import { fallbacks, RECIPES } from './recipes';
import { loadSprite } from './sprite';

export type Bus = 'sfx' | 'ui';

export interface PlayOptions {
  x?: number;          // 世界坐标：给了就按屏幕位置算声像和距离衰减，不给就是正中、不衰减
  y?: number;
  gain?: number;       // 音量倍数（旁观的命中更小声）
  at?: number;         // 什么时候响（performance.now 的毫秒），不给就是马上
  bus?: Bus;
}

interface Voice { name: string; group: string; gain: GainNode; wet: GainNode | null; nodes: AudioNode[]; end: number }

// 每类声音最多同时响几个（满了把最老的那个淡出），以及全部加起来的上限
const GROUP_LIMIT: Record<string, number> = { hit: 6, swing: 4, block: 3, cast: 4, kill: 2 };
const DEFAULT_LIMIT = 3;
const TOTAL_LIMIT = 28;
const SAME_NAME_MS = 30;     // 同一个声音 30ms 内只响一次（范围技能同时打中一群）
const STORE_KEY = 'btdemo.audio';

const audio = {
  ctx: null as AudioContext | null,
  master: null as GainNode | null,
  buses: {} as Record<Bus, GainNode>,
  reverb: null as ConvolverNode | null,
  noise: null as AudioBuffer | null,
  voices: [] as Voice[],
  lastPlayed: new Map<string, number>(),
  samples: new Map<string, AudioBuffer[]>(),
  useSamples: true,      // false：全部实时合成（?sfx=live，或调音页切到"实时"对比）
  spriteLoaded: false,
  volume: 0.8,
  muted: false,
};

loadSettings();

// initAudio 等第一次用户操作再创建 AudioContext（浏览器的自动播放限制）。
export function initAudio(): void {
  // 监听一直留着：标签页切走、手机来电等会把 AudioContext 挂起，下一次操作时再恢复
  const unlock = () => {
    if (!audio.ctx || audio.ctx.state !== 'running') ensureContext();
  };
  for (const type of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(type, unlock, true);
}

function ensureContext(): AudioContext | null {
  if (!audio.ctx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    // 限幅器：几十个声音叠起来也不爆音
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 6;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
    limiter.connect(ctx.destination);
    const master = ctx.createGain();
    master.connect(limiter);
    const sfx = ctx.createGain();
    sfx.gain.value = 0.9;
    sfx.connect(master);
    const ui = ctx.createGain();
    ui.gain.value = 0.6;
    ui.connect(master);
    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    reverb.connect(wet);
    wet.connect(master);
    audio.ctx = ctx;
    audio.master = master;
    audio.buses = { sfx, ui };
    audio.reverb = reverb;
    audio.noise = makeNoiseBuffer(ctx);
    applyVolume();
    if (new URLSearchParams(location.search).get('sfx') === 'live') audio.useSamples = false;
    else void loadSprite(ctx).then((sounds) => {
      if (!sounds) return;
      for (const [name, buffers] of sounds) audio.samples.set(name, buffers);
      audio.spriteLoaded = true;
    }).catch((err) => console.warn('音频图集读取失败，改用实时合成', err));
  }
  if (audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
  return audio.ctx;
}

// play 播放名为 name 的声音，返回是否真的播了（没解锁、静音、太远、被限流时不播）。
export function play(name: string, options: PlayOptions = {}): boolean {
  const ctx = audio.ctx;
  if (!ctx || ctx.state !== 'running' || audio.muted || audio.volume <= 0) return false;
  const nowMs = performance.now();
  const last = audio.lastPlayed.get(name);
  if (last !== undefined && Math.abs((options.at ?? nowMs) - last) < SAME_NAME_MS) return false;

  let gain = options.gain ?? 1;
  let pan = 0;
  let muffle = 0;   // 0..1，越远越闷
  if (options.x !== undefined && options.y !== undefined) {
    const spatial = place(options.x, options.y);
    if (!spatial) return false;
    gain *= spatial.gain;
    pan = spatial.pan;
    muffle = spatial.muffle;
  }
  if (gain < 0.02) return false;

  const chain = fallbacks(name);
  const hasSample = (candidate: string) => audio.useSamples && audio.samples.has(candidate);
  const recipeName = chain.find((candidate) => hasSample(candidate) || RECIPES[candidate]);
  if (!recipeName) return false;
  const mix = mixOf(chain);
  gain *= mix.gain ?? 1;
  audio.lastPlayed.set(name, options.at ?? nowMs);

  const group = name.split('.')[0];
  makeRoom(group, ctx.currentTime);

  const t = ctx.currentTime + Math.max(0, ((options.at ?? nowMs) - nowMs) / 1000) + 0.005;
  const voiceGain = ctx.createGain();
  voiceGain.gain.value = Math.min(gain, 4);
  const nodes: AudioNode[] = [voiceGain];
  let tail: AudioNode = voiceGain;
  if (muffle > 0.05) {
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 12000 * Math.pow(0.12, muffle);
    tail.connect(lowpass);
    tail = lowpass;
    nodes.push(lowpass);
  }
  if (ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    tail.connect(panner);
    tail = panner;
    nodes.push(panner);
  }
  tail.connect(audio.buses[options.bus ?? 'sfx']);

  const pitch = (mix.pitch ?? 1) * (1 + (Math.random() - 0.5) * 0.1);   // 音高随机 ±5%
  let duration: number;
  let voiceWet: GainNode | null = null;
  const samples = hasSample(recipeName) ? audio.samples.get(recipeName) : undefined;
  if (samples && samples.length) {
    const source = ctx.createBufferSource();
    source.buffer = samples[Math.floor(Math.random() * samples.length)];
    source.playbackRate.value = pitch;
    source.connect(voiceGain);
    source.start(t);
    duration = source.buffer.duration / pitch;
  } else {
    // 混响送出也按这个声音的音量走（烘焙版的混响尾巴在素材里，同样被 voiceGain 缩放，两边才一致）
    if (audio.reverb) {
      voiceWet = ctx.createGain();
      voiceWet.gain.value = voiceGain.gain.value;
      voiceWet.connect(audio.reverb);
      nodes.push(voiceWet);
    }
    const kit = new Kit(ctx, voiceGain, voiceWet, audio.noise!);
    duration = RECIPES[recipeName](kit, t, pitch);
  }
  const end = t + duration + 0.1;
  const voice: Voice = { name, group, gain: voiceGain, wet: voiceWet, nodes, end };
  audio.voices.push(voice);
  // 播完断开整条链（音量、低通、声像），节点交给垃圾回收
  window.setTimeout(() => {
    for (const node of nodes) node.disconnect();
    audio.voices = audio.voices.filter((v) => v !== voice);
  }, (end - ctx.currentTime) * 1000 + 50);
  return true;
}

// mixOf 是声音的混音微调：按回退顺序取第一个在 MIX 里真的调过（有 gain 或 pitch）的名字。
function mixOf(chain: string[]): { gain?: number; pitch?: number } {
  for (const candidate of chain) {
    const entry = MIX[candidate];
    if (entry && (entry.gain !== undefined || entry.pitch !== undefined)) return entry;
  }
  return {};
}

// makeRoom 在这类声音或总数到上限时，把最老的一个淡出让位。
function makeRoom(group: string, now: number): void {
  audio.voices = audio.voices.filter((voice) => voice.end > now);
  const sameGroup = audio.voices.filter((voice) => voice.group === group);
  const limit = GROUP_LIMIT[group] ?? DEFAULT_LIMIT;
  const victim = sameGroup.length >= limit ? sameGroup[0] : audio.voices.length >= TOTAL_LIMIT ? audio.voices[0] : null;
  if (!victim) return;
  victim.gain.gain.cancelScheduledValues(now);
  victim.gain.gain.setTargetAtTime(0, now, 0.01);
  if (victim.wet) {
    victim.wet.gain.cancelScheduledValues(now);
    victim.wet.gain.setTargetAtTime(0, now, 0.01);
  }
  victim.end = now;
  audio.voices = audio.voices.filter((voice) => voice !== victim);
}

// place 按世界坐标算声像、距离衰减和闷的程度；离屏幕太远返回 null（不播）。
function place(x: number, y: number): { pan: number; gain: number; muffle: number } | null {
  const cam = state.cam;
  if (cam.w <= 0) return { pan: 0, gain: 1, muffle: 0 };
  const sx = x - cam.x;
  const sy = y - cam.y;
  const dx = sx - cam.w / 2;
  const dy = sy - cam.h / 2;
  const distance = Math.hypot(dx, dy * 1.3);
  const hearing = Math.max(cam.w, cam.h) * 0.75;
  if (distance > hearing * 1.6) return null;
  const far = Math.max(0, distance - hearing * 0.35) / hearing;
  return {
    pan: Math.max(-1, Math.min(1, dx / (cam.w / 2))) * 0.6,
    gain: 1 / (1 + far * far * 4),
    muffle: Math.min(1, far),
  };
}

// registerSample 让 name 用录好的（或烘焙好的）音频，多个变体随机挑一个。
export function registerSample(name: string, buffers: AudioBuffer[]): void {
  audio.samples.set(name, buffers);
}

// setSampleMode 切换用烘焙素材还是全部实时合成（调音页对比用）。
export function setSampleMode(on: boolean): void {
  audio.useSamples = on;
}

// sampleInfo 报告图集加载了没有、有多少个声音有素材，以及某个声音现在用的是素材还是配方。
export function sampleInfo(name?: string): { loaded: boolean; count: number; source?: 'sample' | 'recipe' | 'none' } {
  const info: { loaded: boolean; count: number; source?: 'sample' | 'recipe' | 'none' } = { loaded: audio.spriteLoaded, count: audio.samples.size };
  if (name !== undefined) {
    const found = fallbacks(name).find((candidate) => (audio.useSamples && audio.samples.has(candidate)) || RECIPES[candidate]);
    info.source = !found ? 'none' : audio.useSamples && audio.samples.has(found) ? 'sample' : 'recipe';
  }
  return info;
}

// sampleBuffers 是 name 烘焙好的变体（调音页画波形用），没有返回空数组。
export function sampleBuffers(name: string): AudioBuffer[] {
  return audio.samples.get(name) ?? [];
}

export function audioContext(): AudioContext | null {
  return audio.ctx;
}

export function isMuted(): boolean {
  return audio.muted;
}

export function getVolume(): number {
  return audio.volume;
}

// toggleMute 切换静音（M 键），返回切换后是否静音。
export function toggleMute(): boolean {
  audio.muted = !audio.muted;
  applyVolume();
  saveSettings();
  return audio.muted;
}

export function setVolume(volume: number): void {
  audio.volume = Math.max(0, Math.min(1, volume));
  applyVolume();
  saveSettings();
}

function applyVolume(): void {
  if (!audio.master || !audio.ctx) return;
  audio.master.gain.setTargetAtTime(audio.muted ? 0 : audio.volume, audio.ctx.currentTime, 0.02);
}

function loadSettings(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    if (typeof saved.volume === 'number') audio.volume = saved.volume;
    if (typeof saved.muted === 'boolean') audio.muted = saved.muted;
  } catch {
    // 隐私模式等拿不到 localStorage：用默认值
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ volume: audio.volume, muted: audio.muted }));
  } catch {
    // 存不了就算了，只影响下次打开时的音量
  }
}
