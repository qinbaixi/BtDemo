// 音效烘焙：用 OfflineAudioContext 把 recipes.ts 的配方离线渲染成波形，再拼成一个音频图集。
//
// 只在地址带 ?sfxbake 时挂到 window.btdemo.sfxbake 上，由 tools/sfxbake/bake.mjs 用无头浏览器调用：
// 它把真实素材（assets-src/audio/<声音名>/*.wav）传进来，拿回拼好的 PCM 和偏移表，
// 再用 ffmpeg 编码成 web/public/audio/sfx.webm / sfx.m4a，偏移表写成 audio.json。
//
// 烘焙不改音量：每个声音按实时合成时同样的电平渲染（连混响尾巴一起），所以烘焙版和实时版听起来一样；
// 整个图集只在峰值超过满幅时整体压低，压低的倍数记在 audio.json 的 scale 里，播放时乘回去。

import { Kit, makeImpulse, makeNoiseBuffer } from './kit';
import { RECIPES } from './recipes';

export const BAKE_RATE = 32000;    // 采样率：打击声的能量都在 12kHz 以下，32k 够用，文件小一半
const VARIANTS = 3;                // 每个声音烘几个变体（配方里有随机，三个变体轮流播不会像复读机）
const HIT_VARIANTS = 2;            // 命中声组合有一百多个，少烘一个
const GAP = 0.08;                  // 图集里两段之间留的静音（秒），编码器的前后延迟不会串到隔壁
const TAIL_SILENCE = 0.0005;       // 结尾低于这个幅度的部分裁掉
const WET = 0.5;                   // 混响送出量，和 engine.ts 里的一样

export interface BakeResult {
  sampleRate: number;
  scale: number;                               // 拼图集时整体乘了多少（≤ 1），播放时除回去
  sounds: Record<string, [number, number][]>;  // 声音名 -> 每个变体的 [起点秒, 长度秒]
  pcm: string;                                 // 整个图集的单声道 Float32 PCM，base64
  sources: Record<string, 'recipe' | 'file'>;  // 每个声音来自配方还是素材文件
}

// sfxBake 烘焙全部配方；overrides 是真实素材（声音名 -> 若干个 wav 文件的 base64），有素材的声音用素材不用配方。
export async function sfxBake(overrides: Record<string, string[]> = {}): Promise<BakeResult> {
  const clips: { name: string; data: Float32Array; source: 'recipe' | 'file' }[] = [];
  const names = Object.keys(RECIPES).sort();
  for (const name of names) {
    if (overrides[name]) continue;
    const count = name.startsWith('hit.') ? HIT_VARIANTS : VARIANTS;
    for (let i = 0; i < count; i++) clips.push({ name, data: await renderRecipe(name), source: 'recipe' });
  }
  for (const [name, files] of Object.entries(overrides)) {
    for (const file of files) clips.push({ name, data: await decodeFile(file), source: 'file' });
  }
  // 拼图集：每段后面留 GAP 秒静音
  const gap = Math.round(GAP * BAKE_RATE);
  const total = clips.reduce((sum, clip) => sum + clip.data.length + gap, gap);
  const atlas = new Float32Array(total);
  const sounds: BakeResult['sounds'] = {};
  const sources: BakeResult['sources'] = {};
  let at = gap;
  let peak = 0;
  for (const clip of clips) {
    atlas.set(clip.data, at);
    (sounds[clip.name] ||= []).push([round(at / BAKE_RATE), round(clip.data.length / BAKE_RATE)]);
    sources[clip.name] = clip.source;
    for (const v of clip.data) {
      const level = Math.abs(v);
      if (level > peak) peak = level;   // NaN 比较为假，坏样本不会把 peak 变成 NaN
    }
    at += clip.data.length + gap;
  }
  // 编码成 16 位以前不能超过满幅；留 1dB 余量
  const scale = peak > 0.89 ? 0.89 / peak : 1;
  if (scale < 1) for (let i = 0; i < atlas.length; i++) atlas[i] *= scale;
  return { sampleRate: BAKE_RATE, scale: round(scale), sounds, pcm: toBase64(atlas), sources };
}

// renderRecipe 离线渲染一个配方（干声 + 混响尾巴），裁掉结尾的静音。
export async function renderRecipe(name: string, sampleRate = BAKE_RATE): Promise<Float32Array> {
  const recipe = RECIPES[name];
  // 先用一个很短的上下文问出配方多长（配方返回声音持续的秒数），再按长度 + 混响尾巴开真正的上下文
  const probe = new OfflineAudioContext(1, sampleRate, sampleRate);
  const probeKit = new Kit(probe, probe.destination, null, makeNoiseBuffer(probe));
  const duration = recipe(probeKit, 0, 1);
  const length = Math.ceil((duration + 1.8) * sampleRate);
  const ctx = new OfflineAudioContext(1, length, sampleRate);
  const reverb = ctx.createConvolver();
  reverb.buffer = makeImpulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = WET;
  reverb.connect(wet);
  wet.connect(ctx.destination);
  const kit = new Kit(ctx, ctx.destination, reverb, makeNoiseBuffer(ctx));
  recipe(kit, 0.002, 1);
  const rendered = await ctx.startRendering();
  return trimTail(rendered.getChannelData(0));
}

// decodeFile 把一个 wav（base64）解码成 BAKE_RATE 的单声道波形。
async function decodeFile(base64: string): Promise<Float32Array> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const decoder = new OfflineAudioContext(1, 1, BAKE_RATE);
  const decoded = await decoder.decodeAudioData(bytes.buffer);
  // 重采样并混成单声道：放进一个 BAKE_RATE 的离线上下文里播一遍
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * BAKE_RATE)), BAKE_RATE);
  const source = ctx.createBufferSource();
  source.buffer = decoded;
  source.connect(ctx.destination);
  source.start();
  return trimTail((await ctx.startRendering()).getChannelData(0));
}

function trimTail(data: Float32Array): Float32Array {
  let end = data.length;
  while (end > 0 && Math.abs(data[end - 1]) < TAIL_SILENCE) end--;
  // 末尾 10ms 淡出，裁掉的地方不会咔一声
  const out = data.slice(0, Math.max(1, end));
  const fade = Math.min(out.length, Math.round(0.01 * BAKE_RATE));
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
  return out;
}

function round(v: number): number {
  return Math.round(v * 100000) / 100000;
}

function toBase64(data: Float32Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
