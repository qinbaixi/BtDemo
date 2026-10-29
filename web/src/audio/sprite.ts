// 烘焙好的音频图集：启动时读 audio/audio.json 和图集文件，按偏移表切成一段段注册给引擎。
// 文件缺失、浏览器解码不了时什么都不做，引擎照样用配方实时合成（开发时不用每次都烘焙）。
// 图集由 tools/sfxbake 生成，格式见 audio/bake.ts。

export interface SpriteIndex {
  version: number;
  sampleRate: number;
  scale: number;                               // 烘焙时整体压低的倍数，切出来的时候除回去
  files: { webm?: string; m4a?: string; wav?: string };
  hash?: string;                               // 图集内容的指纹：加在文件地址后面，重新烘焙后不会读到浏览器缓存的旧图集
  sounds: Record<string, [number, number][]>;  // 声音名 -> 每个变体的 [起点秒, 长度秒]
}

const BASE = 'audio/';

// loadSprite 读图集，返回 声音名 -> 变体 的波形；没有图集或者加载失败返回 null。
export async function loadSprite(ctx: BaseAudioContext): Promise<Map<string, AudioBuffer[]> | null> {
  let index: SpriteIndex;
  try {
    const res = await fetch(BASE + 'audio.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    index = await res.json();
  } catch {
    return null;
  }
  const file = pickFile(index.files);
  if (!file || !index.sounds) return null;
  let atlas: AudioBuffer;
  try {
    const res = await fetch(BASE + file + (index.hash ? `?v=${index.hash}` : ''));
    if (!res.ok) return null;
    atlas = await ctx.decodeAudioData(await res.arrayBuffer());
  } catch (err) {
    console.warn('音频图集解码失败，改用实时合成', err);
    return null;
  }
  const source = atlas.getChannelData(0);
  const restore = index.scale > 0 ? 1 / index.scale : 1;
  const out = new Map<string, AudioBuffer[]>();
  for (const [name, variants] of Object.entries(index.sounds)) {
    const buffers: AudioBuffer[] = [];
    for (const [start, length] of variants) {
      // 按秒切：解码出来的采样率跟着 AudioContext，不一定是烘焙时的采样率
      const from = Math.round(start * atlas.sampleRate);
      // 多切 30ms：有的解码器不跳过 AAC 的编码延迟，声音会整体晚一点点（段与段之间留了静音，不会切到隔壁）
      const count = Math.min(Math.round((length + 0.03) * atlas.sampleRate), source.length - from);
      if (count <= 0) continue;
      const buffer = ctx.createBuffer(1, count, atlas.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < count; i++) data[i] = source[from + i] * restore;
      buffers.push(buffer);
    }
    if (buffers.length) out.set(name, buffers);
  }
  return out;
}

// pickFile 挑浏览器能放的格式：Opus（webm）最小，苹果设备用 AAC（m4a），都不行再用 wav。
function pickFile(files: SpriteIndex['files']): string | undefined {
  const probe = typeof Audio !== 'undefined' ? new Audio() : null;
  if (files.webm && probe?.canPlayType('audio/webm; codecs="opus"')) return files.webm;
  if (files.m4a && probe?.canPlayType('audio/mp4; codecs="mp4a.40.2"')) return files.m4a;
  return files.wav ?? files.m4a ?? files.webm;
}
