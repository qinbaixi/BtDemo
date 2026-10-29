// 演出时钟：画面、动画、特效、飘字、声音排期都用 gameNow()，不直接用 performance.now()。
//
// 平时 gameNow() 就是 performance.now()。慢放时演出时钟走得比真实时间慢，落后的部分记在 lag 里；
// 慢放结束后时钟以 CATCH_UP 倍速追上去，追平后又和真实时间一样。服务端照常按真实时间跑，
// 所以慢放只能短（清场、击杀首领那一下），追赶期间画面比服务端晚一点点，看不出来。
//
// 顿帧（单个角色停住）不走这里，见 feel/director.ts 的 freezeUntil。

const CATCH_UP = 0.6;          // 追赶时每真实 1ms 追回 0.6ms（也就是 1.6 倍速）
const RAMP_MS = 120;           // 慢放结束时速度从 scale 渐变回 1，不是一下跳回去

let lag = 0;                   // 演出时钟比真实时间落后多少毫秒
let lastReal = 0;
let slowScale = 1;             // 这次慢放的速度
let slowFrom = 0;              // 慢放开始、结束的真实时间
let slowUntil = 0;
let fixedScale = 1;            // fxlab 手动设的常驻速度（0 = 暂停）
let stepMs = 0;                // 暂停时单帧步进：下一帧往前走这么多

// gameNow 是演出时钟的当前时间（毫秒）。
export function gameNow(): number {
  return performance.now() - lag;
}

// tickClock 每帧开头调用一次（main.ts 的 frame），按这一帧的真实时长推进演出时钟。
export function tickClock(): void {
  const real = performance.now();
  const realDt = lastReal ? Math.min(100, real - lastReal) : 0;
  lastReal = real;
  const speed = currentSpeed(real);
  let advance = realDt * speed;
  if (stepMs > 0) {
    advance += stepMs;
    stepMs = 0;
  }
  lag += realDt - advance;
  // 没有慢放也没有常驻速度时追赶落下的时间
  if (fixedScale === 1 && real >= slowUntil && lag > 0) lag = Math.max(0, lag - realDt * CATCH_UP);
  if (lag < 0) lag = 0;
}

function currentSpeed(real: number): number {
  if (fixedScale !== 1) return fixedScale;
  if (real < slowFrom || real >= slowUntil + RAMP_MS) return 1;
  if (real < slowUntil) return slowScale;
  // 慢放尾巴：渐变回正常速度
  const k = (real - slowUntil) / RAMP_MS;
  return slowScale + (1 - slowScale) * k;
}

// slowMotion 从现在开始以 scale 倍速放 realMs 毫秒（真实时间），之后渐变回正常、再追上。
// 正在慢放时取更慢、更长的那个。
export function slowMotion(scale: number, realMs: number): void {
  const real = performance.now();
  if (real < slowUntil) {
    slowScale = Math.min(slowScale, scale);
    slowUntil = Math.max(slowUntil, real + realMs);
    return;
  }
  slowScale = scale;
  slowFrom = real;
  slowUntil = real + realMs;
}

// setTimeScale 设一个常驻速度（fxlab 的 0.25× 慢放、暂停），1 恢复正常并慢慢追上真实时间。
export function setTimeScale(scale: number): void {
  fixedScale = Math.max(0, scale);
}

// clockSpeed 是演出时钟这一刻的速度（1 正常，慢放时小于 1，暂停为 0）：声音排期按它把演出时间换成真实时间。
export function clockSpeed(): number {
  return currentSpeed(performance.now());
}

export function timeScale(): number {
  return fixedScale;
}

// stepFrame 暂停时往前走一帧。
export function stepFrame(ms = 1000 / 60): void {
  stepMs += ms;
}

// clockLag 是演出时钟落后真实时间多少毫秒（调试、测试用）。
export function clockLag(): number {
  return lag;
}
