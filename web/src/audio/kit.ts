// 合成工具箱：配方（recipes.ts）用这几个积木拼出声音。
// 同一套代码既能接实时的 AudioContext，也能接 OfflineAudioContext 把声音烘焙成文件。
//
// 时间 t 都是 AudioContext 的秒；peak 是线性音量（1 大约是满幅）；
// wet 是送到混响的比例（0 不送），金属、铃声这类要尾音的声音才送。

export class Kit {
  constructor(
    readonly ctx: BaseAudioContext,
    readonly out: AudioNode,           // 这个声音的出口（引擎在后面接声像和距离衰减）
    readonly reverb: AudioNode | null, // 混响送出口
    readonly noiseBuffer: AudioBuffer, // 共享的一段白噪声，每次从随机位置开始播
  ) {}

  // envelope 在 gain 上画一个"快起、指数衰减"的包络。
  private envelope(gain: GainNode, t: number, peak: number, attack: number, decay: number): void {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  // connect 把 node 接到出口，wet > 0 时再分一路去混响。
  private connect(node: AudioNode, wet: number): void {
    node.connect(this.out);
    if (wet > 0 && this.reverb) {
      const send = this.ctx.createGain();
      send.gain.value = wet;
      node.connect(send);
      send.connect(this.reverb);
    }
  }

  // noise 播一段滤过的白噪声：滤波器频率从 from 扫到 to。
  // 低通是闷响、碎屑，带通是挥风声和撕裂声，高通是"咔"的瞬态。
  noise(
    t: number,
    duration: number,
    filter: BiquadFilterType,
    from: number,
    to: number,
    q: number,
    peak: number,
    attack = 0.002,
    wet = 0,
  ): void {
    const source = this.ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const biquad = this.ctx.createBiquadFilter();
    biquad.type = filter;
    biquad.Q.value = q;
    biquad.frequency.setValueAtTime(from, t);
    biquad.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + attack + duration);
    const gain = this.ctx.createGain();
    this.envelope(gain, t, peak, attack, duration);
    source.connect(biquad);
    biquad.connect(gain);
    this.connect(gain, wet);
    const offset = Math.random() * Math.max(0, this.noiseBuffer.duration - duration - 0.1);
    source.start(t, offset);
    source.stop(t + attack + duration + 0.05);
  }

  // tone 播一个振荡器音：频率从 from 滑到 to（音高下坠的正弦就是打击的"本体"）。
  tone(
    t: number,
    wave: OscillatorType,
    from: number,
    to: number,
    duration: number,
    peak: number,
    attack = 0.003,
    wet = 0,
  ): void {
    const oscillator = this.ctx.createOscillator();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(from, t);
    if (to !== from) oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + attack + duration);
    const gain = this.ctx.createGain();
    this.envelope(gain, t, peak, attack, duration);
    oscillator.connect(gain);
    this.connect(gain, wet);
    oscillator.start(t);
    oscillator.stop(t + attack + duration + 0.05);
  }

  // metal 播一组不成谐波的泛音：金属的"哐"和"叮"都靠它，ratios 决定是盾牌、剑还是铃。
  metal(t: number, base: number, ratios: number[], duration: number, peak: number, wet = 0): void {
    ratios.forEach((ratio, index) => {
      const detune = 1 + (Math.random() - 0.5) * 0.01;
      this.tone(
        t,
        index === 0 ? 'triangle' : 'sine',
        base * ratio * detune,
        base * ratio * detune,
        duration * (1 - index * 0.1),
        peak / (1 + index * 0.6),
        0.002,
        wet,
      );
    });
  }

  // crackle 在 duration 秒里随机撒 count 个极短的"噼啪"（火焰、碎石）。
  crackle(t: number, duration: number, count: number, peak: number): void {
    for (let i = 0; i < count; i++) {
      const at = t + Math.random() * duration;
      this.noise(at, 0.008 + Math.random() * 0.01, 'bandpass', 2500 + Math.random() * 3000, 2000, 2, peak * (0.4 + Math.random() * 0.6), 0.001);
    }
  }

  // arpeggio 依次播一串音（治疗、升级、拾取的铃声）。
  arpeggio(t: number, notes: number[], step: number, duration: number, peak: number, wave: OscillatorType = 'sine', wet = 0.3): void {
    notes.forEach((frequency, index) => {
      this.tone(t + index * step, wave, frequency, frequency, duration, peak, 0.004, wet);
      this.tone(t + index * step, 'sine', frequency * 2.01, frequency * 2.01, duration * 0.6, peak * 0.25, 0.004, wet);
    });
  }
}

// makeNoiseBuffer 生成一段 2 秒的白噪声，所有噪声层共用。
export function makeNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

// makeImpulse 生成一段指数衰减的立体声噪声，当混响的冲激响应（像一个石头大厅）。
export function makeImpulse(ctx: BaseAudioContext, seconds = 1.6): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.2);
  }
  return buffer;
}
