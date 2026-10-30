// 环境声：按自己站在哪个区域（地图的区域中心，和区域调色同一份数据）混合几层声音。
//
//   风      一直有一层很轻的风；墓地里风大、更低沉
//   火      离营火、火盆近时有一层低沉的燃烧声，按方位左右声像
//   一次性  村子、草地、树林里随机的鸟叫；墓地里乌鸦和远处的钟；地穴里滴水和骨头声；火堆旁的噼啪（recipes.ts 的 amb.*）
//
// 全部走 amb 总线（engine.ts）：音量跟设置里的“环境声”，重击和完美格挡时被 duck() 压低。
// 每帧调用 updateAmbience；声音还没解锁（还没点过页面）时什么都不做。

import { state, posOf, type Point } from '../game/state';
import { ambienceOutput, play } from './engine';

const ZONE_SIGMA = 420;          // 区域影响范围（和后期处理的区域调色一样）
const FIRE_RANGE = 260;          // 离火这么近才听得到燃烧声
const BIRD_ZONES = ['village', 'meadow', 'forest'];
const FIRE_KINDS = new Set(['campfire', 'brazier']);

interface Bed {
  filter: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode | null;
}

let layers: { wind: Bed; gust: Bed; fire: Bed } | null = null;
let windDrift = 0.5;             // 风的音高随机游走 0..1
let nextBirdAt = 0;
let nextGraveAt = 0;
let nextCrackleAt = 0;
let nextCryptAt = 0;

// updateAmbience 每帧调用：算各层的权重，平滑地调过去，到时间就播一次性的声音。now 是演出时钟。
export function updateAmbience(now: number, dt: number): void {
  const out = ambienceOutput();
  if (!out) return;
  if (!layers) layers = startBeds(out.ctx, out.bus, out.noise);
  const listener = listenerPos(now);
  const zones = state.scenery?.zones ?? {};
  const weight = (kind: string) => {
    let sum = 0;
    for (const center of zones[kind] || []) {
      const d = Math.hypot(center.x - listener.x, center.y - listener.y);
      sum += Math.exp(-(d * d) / (2 * ZONE_SIGMA * ZONE_SIGMA));
    }
    return Math.min(1, sum);
  };
  const birds = Math.min(1, BIRD_ZONES.reduce((sum, kind) => sum + weight(kind), 0));
  // 亡者地穴里全是 graveyard 区域；地穴另外有滴水和骨头声，风换成闷闷的地底气流
  const crypt = state.scene?.id === 'crypt';
  const grave = crypt ? 0.5 : weight('graveyard');
  const fire = nearestFire(listener);
  const t = out.ctx.currentTime;

  // 风：随机游走的带通，墓地里更响、更低
  windDrift = Math.max(0, Math.min(1, windDrift + (Math.random() - 0.5) * dt * 0.0012));
  const windFreq = (380 + 520 * windDrift) * (1 - grave * 0.45);
  layers.wind.filter.frequency.setTargetAtTime(windFreq, t, 0.4);
  layers.wind.gain.gain.setTargetAtTime(0.05 + grave * 0.16, t, 0.6);
  // 阵风：低通噪声，音量慢慢起伏
  const gust = 0.5 + 0.5 * Math.sin(now / 3100) * Math.sin(now / 1700 + 1.3);
  layers.gust.gain.gain.setTargetAtTime((0.02 + grave * 0.1) * gust, t, 0.5);
  // 火：越近越响，按方位左右
  const fireLevel = fire ? Math.pow(1 - fire.distance / FIRE_RANGE, 1.5) * 0.22 : 0;
  layers.fire.gain.gain.setTargetAtTime(fireLevel, t, 0.3);
  if (fire && layers.fire.pan) layers.fire.pan.pan.setTargetAtTime(Math.max(-0.7, Math.min(0.7, fire.dx / FIRE_RANGE)), t, 0.3);

  // 一次性的声音：间隔随机，不在区域里就不播
  if (now >= nextBirdAt) {
    if (birds > 0.25 && Math.random() < birds) {
      const side = (Math.random() - 0.5) * 500;
      play(Math.random() < 0.7 ? 'amb.bird' : 'amb.bird.trill', { x: listener.x + side, y: listener.y - 120, gain: 0.5 + birds * 0.5, bus: 'amb' });
    }
    nextBirdAt = now + 1800 + Math.random() * 4500;
  }
  if (now >= nextGraveAt) {
    if (!crypt && grave > 0.3 && Math.random() < grave) {
      const side = (Math.random() - 0.5) * 700;
      play(Math.random() < 0.65 ? 'amb.crow' : 'amb.bell', { x: listener.x + side, y: listener.y - 200, gain: grave, bus: 'amb' });
    }
    nextGraveAt = now + 6000 + Math.random() * 9000;
  }
  if (crypt && now >= nextCryptAt) {
    const side = (Math.random() - 0.5) * 600;
    play(Math.random() < 0.7 ? 'amb.drip' : 'amb.rattle', { x: listener.x + side, y: listener.y - 80, gain: 0.8, bus: 'amb' });
    nextCryptAt = now + 1500 + Math.random() * 3500;
  }
  if (fire && now >= nextCrackleAt) {
    play('amb.crackle', { x: fire.x, y: fire.y, gain: 0.3 + fireLevel * 3, bus: 'amb' });
    nextCrackleAt = now + 350 + Math.random() * 900;
  }
}

function listenerPos(now: number): Point {
  const me = state.ents.get(state.myId);
  if (me) return posOf(me, now);
  return { x: state.cam.x + state.cam.w / 2, y: state.cam.y + state.cam.h / 2 };
}

function nearestFire(listener: Point): { x: number; y: number; distance: number; dx: number } | null {
  let best: { x: number; y: number; distance: number; dx: number } | null = null;
  for (const prop of state.scenery?.props ?? []) {
    if (!FIRE_KINDS.has(prop.kind)) continue;
    const distance = Math.hypot(prop.x - listener.x, prop.y - listener.y);
    if (distance < FIRE_RANGE && (!best || distance < best.distance)) best = { x: prop.x, y: prop.y, distance, dx: prop.x - listener.x };
  }
  return best;
}

// startBeds 建三层持续的底噪：都是循环播放的白噪声接滤波器，音量先为 0。
function startBeds(ctx: AudioContext, bus: GainNode, noise: AudioBuffer): { wind: Bed; gust: Bed; fire: Bed } {
  const bed = (type: BiquadFilterType, frequency: number, q: number, offset: number, panned: boolean): Bed => {
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(filter);
    filter.connect(gain);
    let pan: StereoPannerNode | null = null;
    if (panned && ctx.createStereoPanner) {
      pan = ctx.createStereoPanner();
      gain.connect(pan);
      pan.connect(bus);
    } else {
      gain.connect(bus);
    }
    // 三层从噪声的不同位置开始，不会听出是同一段
    source.start(ctx.currentTime, offset);
    return { filter, gain, pan };
  };
  return {
    wind: bed('bandpass', 600, 0.8, 0, false),
    gust: bed('lowpass', 260, 0.7, 0.7, false),
    fire: bed('lowpass', 420, 0.9, 1.3, true),
  };
}
