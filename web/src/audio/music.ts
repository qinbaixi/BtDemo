// 副本音乐：程序化合成，跟着关卡的局面换段落。只在副本里响，野外只有环境声。
//
//   探索  一层低沉的持续音（根音 + 五度，慢慢呼吸）加一串很稀的拨弦，节拍慢
//   战斗  房间锁门打起来时：拨弦变密，加上低沉的鼓点
//   首领  附近有活着的首领时：节拍更快，鼓更重，多一层高处的不和谐长音
//
// 每一关一套音阶和音色（MOODS）：黑松林道是 D 小调、木质的拨弦；亡者地穴是 D 弗里几亚、骨头般干脆的拨弦，
// 尾巴带一点回声（地穴里的回响）。
// 段落切换时持续音和鼓的音量慢慢过去，不会突然切断。音符提前 0.2 秒排进 AudioContext 的时间线，帧率抖动不会让节拍乱。
// 直接接主音量，音量乘设置里的“音乐”。

import { BOSS_MODELS } from '../feel/profiles';
import { gameNow } from '../game/clock';
import { SETTINGS } from '../game/settings';
import { posOf, state } from '../game/state';
import { musicOutput } from './engine';
import { Kit } from './kit';

type Section = 'quiet' | 'explore' | 'fight' | 'boss';

interface Mood {
  root: number;        // 根音（Hz）
  scale: number[];     // 音阶（相对根音的半音数）
  pluck: OscillatorType;
  bpm: Record<Exclude<Section, 'quiet'>, number>;
  echo: number;        // 回声的反馈量（0 = 没有回声）
}

const MOODS: Record<string, Mood> = {
  wolf_trail: { root: 73.42, scale: [0, 3, 5, 7, 10, 12, 15], pluck: 'triangle', bpm: { explore: 66, fight: 96, boss: 118 }, echo: 0.18 },
  crypt: { root: 73.42, scale: [0, 1, 5, 7, 8, 12, 13], pluck: 'square', bpm: { explore: 58, fight: 92, boss: 112 }, echo: 0.38 },
};
const DEFAULT_MOOD = MOODS.wolf_trail;

const LOOKAHEAD = 0.2;       // 提前多少秒排音符
const BOSS_RANGE = 620;      // 和首领血条同一个距离
const MUSIC_LEVEL = 0.8;

// 拨弦的走向：音阶里的第几个音，-1 是休止。探索时只弹偶数拍，战斗时每拍都弹。
const PATTERN = [0, -1, 2, 3, -1, 2, 4, 3, 0, -1, 2, 5, 4, -1, 3, 2];

interface Rig {
  out: GainNode;          // 音乐总出口（音量 = 设置 × 段落淡入淡出）
  drone: GainNode;        // 持续音
  droneOscs: OscillatorNode[];
  high: GainNode;         // 首领战高处的不和谐长音
  highOsc: OscillatorNode;
  drums: GainNode;        // 鼓的出口（战斗、首领时打开）
  notes: GainNode;        // 拨弦的出口（进回声）
  kit: Kit;
  drumKit: Kit;
  echo: GainNode;         // 回声的反馈
  mood: Mood;
}

let rig: Rig | null = null;
let section: Section = 'quiet';
let nextBeatAt = 0;      // AudioContext 的秒
let beat = 0;

// updateMusic 每帧调用：判断现在是哪一段，调各层的音量，把接下来的音符排进时间线。
export function updateMusic(): void {
  const output = musicOutput();
  if (!output) return;
  const { ctx } = output;
  if (!rig) rig = buildRig(ctx, output.bus, output.noise);
  const mood = MOODS[state.scene?.id ?? ''] ?? DEFAULT_MOOD;
  if (mood !== rig.mood) retune(rig, mood, ctx.currentTime);
  const now = ctx.currentTime;
  const next = currentSection();
  if (next !== section) {
    section = next;
    if (nextBeatAt < now) nextBeatAt = now + 0.05;
  }
  const playing = section !== 'quiet';
  rig.out.gain.setTargetAtTime(playing ? MUSIC_LEVEL * SETTINGS.music : 0, now, playing ? 1.2 : 0.8);
  rig.drone.gain.setTargetAtTime(playing ? (section === 'explore' ? 0.05 : 0.07) : 0, now, 1.5);
  rig.drums.gain.setTargetAtTime(section === 'fight' ? 0.5 : section === 'boss' ? 0.8 : 0, now, 0.6);
  rig.high.gain.setTargetAtTime(section === 'boss' ? 0.012 : 0, now, 2);
  if (!playing) return;
  const bpm = rig.mood.bpm[section as Exclude<Section, 'quiet'>];
  const step = 60 / bpm / 2;   // 八分音符
  while (nextBeatAt < now + LOOKAHEAD) {
    playBeat(rig, nextBeatAt, beat, step);
    nextBeatAt += step;
    beat++;
  }
}

// currentSection 是现在该放哪一段：不在副本里不放；附近有活着的首领是首领段；有房间在打是战斗段。
function currentSection(): Section {
  if (!state.scene?.dungeon) return 'quiet';
  const me = state.ents.get(state.myId);
  if (me) {
    const now = gameNow();
    const mine = posOf(me, now);
    for (const entity of state.ents.values()) {
      if (entity.dead || !BOSS_MODELS.has(entity.model)) continue;
      const at = posOf(entity, now);
      if (Math.hypot(at.x - mine.x, at.y - mine.y) < BOSS_RANGE) return 'boss';
    }
  }
  const fighting = state.level && [...state.level.rooms.values()].some((room) => room.phase === 'fight');
  return fighting ? 'fight' : 'explore';
}

// playBeat 排第 index 个八分音符：拨弦、鼓。
function playBeat(rig: Rig, t: number, index: number, step: number): void {
  const mood = rig.mood;
  const slot = PATTERN[index % PATTERN.length];
  const sparse = section === 'explore' && index % 2 === 1;
  if (slot >= 0 && !sparse) {
    const octave = section === 'boss' && index % 8 === 6 ? 2 : 1;
    const frequency = mood.root * 2 * octave * Math.pow(2, mood.scale[slot % mood.scale.length] / 12);
    const accent = index % 4 === 0 ? 1 : 0.7;
    rig.kit.tone(t, mood.pluck, frequency, frequency * 0.995, step * 1.6, 0.06 * accent, 0.004);
    // 拨弦下面垫一个低八度的软音，声音厚一点
    rig.kit.tone(t, 'sine', frequency / 2, frequency / 2, step * 2.2, 0.05 * accent, 0.01);
  }
  if (section === 'explore') return;
  // 鼓：一小节八拍，第 1、5 拍重鼓，首领段第 7 拍再补一下；中间是轻的沙沙声
  const bar = index % 8;
  if (bar === 0 || bar === 4 || (section === 'boss' && bar === 7)) {
    rig.drumKit.tone(t, 'sine', 120, 42, 0.32, bar === 0 ? 0.9 : 0.65, 0.002);
    rig.drumKit.noise(t, 0.12, 'lowpass', 900, 200, 0.7, 0.25, 0.002);
  } else if (section === 'boss' || bar % 2 === 0) {
    rig.drumKit.noise(t, 0.04, 'highpass', 5000, 4000, 0.7, section === 'boss' ? 0.08 : 0.05, 0.001);
  }
}

// buildRig 搭好音乐的各层：持续音、首领长音、拨弦（带回声）和鼓。
function buildRig(ctx: AudioContext, bus: GainNode, noise: AudioBuffer): Rig {
  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(bus);
  // 持续音：根音和五度两组略微走调的锯齿波，接一个慢慢开合的低通
  const drone = ctx.createGain();
  drone.gain.value = 0;
  const droneFilter = ctx.createBiquadFilter();
  droneFilter.type = 'lowpass';
  droneFilter.frequency.value = 260;
  droneFilter.Q.value = 2;
  const breath = ctx.createOscillator();
  const breathDepth = ctx.createGain();
  breath.frequency.value = 0.07;
  breathDepth.gain.value = 120;
  breath.connect(breathDepth);
  breathDepth.connect(droneFilter.frequency);
  breath.start();
  const droneOscs = [1, 1.004, 1.5, 1.497].map((ratio) => {
    const oscillator = ctx.createOscillator();
    oscillator.type = 'sawtooth';
    oscillator.frequency.value = DEFAULT_MOOD.root * ratio;
    oscillator.connect(droneFilter);
    oscillator.start();
    return oscillator;
  });
  droneFilter.connect(drone);
  drone.connect(out);
  // 首领段的高处长音：比根音高一个小二度的五个八度，很轻，听起来让人不安
  const high = ctx.createGain();
  high.gain.value = 0;
  const highOsc = ctx.createOscillator();
  highOsc.type = 'sine';
  highOsc.frequency.value = DEFAULT_MOOD.root * 16 * Math.pow(2, 1 / 12);
  highOsc.connect(high);
  highOsc.start();
  high.connect(out);
  // 拨弦接回声：延迟 3/8 拍左右，反馈量看这一关（地穴里回声长）
  const notes = ctx.createGain();
  notes.connect(out);
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.39;
  const echo = ctx.createGain();
  echo.gain.value = DEFAULT_MOOD.echo;
  const echoTone = ctx.createBiquadFilter();
  echoTone.type = 'lowpass';
  echoTone.frequency.value = 1800;
  notes.connect(delay);
  delay.connect(echoTone);
  echoTone.connect(echo);
  echo.connect(delay);
  echo.connect(out);
  const drums = ctx.createGain();
  drums.gain.value = 0;
  drums.connect(out);
  return {
    out,
    drone,
    droneOscs,
    high,
    highOsc,
    drums,
    notes,
    kit: new Kit(ctx, notes, null, noise),
    drumKit: new Kit(ctx, drums, null, noise),
    echo,
    mood: DEFAULT_MOOD,
  };
}

// retune 换一关的音阶和回声：持续音滑到新的根音。
function retune(rig: Rig, mood: Mood, t: number): void {
  rig.mood = mood;
  [1, 1.004, 1.5, 1.497].forEach((ratio, index) => rig.droneOscs[index].frequency.setTargetAtTime(mood.root * ratio, t, 0.5));
  rig.highOsc.frequency.setTargetAtTime(mood.root * 16 * Math.pow(2, 1 / 12), t, 0.5);
  rig.echo.gain.setTargetAtTime(mood.echo, t, 0.5);
}
