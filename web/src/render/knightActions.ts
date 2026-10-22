// 骑士（玩家模型）每个技能的专属动作：关键帧数据和插值。画法在 models.ts 的 drawKnight 里。
//
// 每个动作是 0..1 时间轴上的一串关键帧，帧与帧之间按缓动插值。关键帧里写：
//   near / far   近侧、远侧手的位置，用“躯干坐标”写：原点在两肩关节连线的中点，x 朝前、y 朝下。
//                远侧肩在 x = -6.5，近侧肩在 x = 6.5；腰在 y = 12，头顶约 y = -15，站着时地面在 y = 29。
//                初始化时用两节骨骼的 IK 换成 [大臂角度, 肘的弯曲]（角度从正下方算，往前为正）；
//                也可以直接写 { upper, elbow } 角度（和 models.ts 的 humanoid 一样）。
//   blade        剑的角度（躯干坐标里，和手臂一样从正下方算）；不写就顺着持剑那只手的小臂。
//                上半身前倾 lean 时剑跟着转，画面上的角度是 blade - lean
//   lean         上半身前倾（弧度，正数往前）
//   drop         胯往下沉多少（蹲、跪）
//   feet         [远侧脚, 近侧脚] 相对站立落脚点的偏移，y 负数是抬脚；每帧用 IK 算腿（膝盖朝前弯）。
//                不写表示用平常的步态（站着或走路），写了和不写的帧之间腿会平滑过渡
//   lift         整个人往上抬（跳起来）
//   jitter       发力时的颤动幅度
//   stretch      闪现到达时的横向拉伸（0..1）
//   ease         到达这一帧的缓动：out 先快后慢（出招）、in 先慢后快（砸下去）、smooth（默认）
//
// 动作的“出手”时刻（release）决定特效什么时候放：game/events.ts 把特效推迟 ms × release 毫秒，
// 让火球从剑尖飞出、飞斧离手、冰霜在跺脚时炸开。

type Vec2 = [number, number];
type ArmSpec = Vec2 | { upper: number; elbow: number };
type Ease = 'out' | 'in' | 'smooth';

interface KeySpec {
  t: number;
  near: ArmSpec;
  far: ArmSpec;
  blade?: number;
  lean?: number;
  drop?: number;
  feet?: [Vec2, Vec2];
  lift?: number;
  jitter?: number;
  stretch?: number;
  ease?: Ease;
}

interface ActionSpec {
  ms: number;
  release: number;   // 出手时刻（0..1）
  swap: boolean;     // true：剑在远侧手、盾在近侧手（和站立时一样）；false：近侧手持剑
  slung?: boolean;   // 盾背到背上，空出近侧手（swap 时）
  spin?: [number, number];   // 原地转一圈的起止时刻
  muzzle?: 'tip' | 'hand';   // 飞行道具从哪儿飞出去：剑尖（火球）或空着的近侧手（飞斧）
  keys: KeySpec[];
}

// 一帧的动作姿势（actionPose 的结果），models.ts 按它画
export interface ActionPose {
  name: string;
  k: number;          // 动作进度 0..1
  swap: boolean;
  slung: boolean;
  far: Vec2;          // [大臂, 肘]
  near: Vec2;
  blade: number;
  lean: number;
  drop: number;
  lift: number;
  jitter: number;
  stretch: number;
  feet: [Vec2, Vec2] | null;
  feetWeight: number; // 0..1：站姿 IK 腿和平常步态之间的混合
  spin: number;       // 转身角度（弧度），0 不转
}

interface Key {
  t: number;
  far: Vec2;
  near: Vec2;
  blade: number;
  lean: number;
  drop: number;
  lift: number;
  jitter: number;
  stretch: number;
  feet: [Vec2, Vec2] | null;
  ease: Ease;
}

// 和 models.ts 里骑士的尺寸一致
export const SHOULDER_X = 6.5;   // 肩关节离身体中线的距离
const HIP_Y = -17;               // 站着时胯的高度（脚底在 y = 0）
const SHOULDER_BELOW_HIP = -12;  // 肩关节在胯上面多少
const SWORD_LENGTH = 20;
const UPPER = 7.2;
const FORE = 6.8;

// 站立时的手臂（剑在远侧手，从身后指向前方；盾在近侧手挡在身前）
const IDLE_FAR = { upper: 0.9, elbow: 1.3 };
const IDLE_NEAR = { upper: 0.35, elbow: 0.6 };
// 近侧手持剑时的放松姿势（和普通斩击的起止姿势一样）
const HAND_FAR = { upper: 0.2, elbow: -0.5 };
const HAND_NEAR = { upper: 0.5, elbow: -0.9 };

// armIK 求两节手臂够到 (dx, dy)（相对肩关节）时的 [大臂角度, 肘的弯曲]。肘只往前弯（弯曲为正）；
// 够不着时手臂伸直指向目标。
export function armIK(dx: number, dy: number, upper = UPPER, fore = FORE): Vec2 {
  const distance = Math.min(upper + fore - 0.01, Math.max(Math.abs(upper - fore) + 0.01, Math.hypot(dx, dy)));
  const base = Math.atan2(dx, dy);
  const atShoulder = Math.acos((upper * upper + distance * distance - fore * fore) / (2 * upper * distance));
  const atHand = Math.acos((fore * fore + distance * distance - upper * upper) / (2 * fore * distance));
  return [base - atShoulder, atShoulder + atHand];
}

// legIK 求两节腿从胯够到 (dx, dy) 时的 [大腿角度, 小腿角度]（都是绝对角度），膝盖朝前弯。
export function legIK(dx: number, dy: number, thigh: number, shin: number): Vec2 {
  const distance = Math.min(thigh + shin - 0.01, Math.max(Math.abs(thigh - shin) + 0.01, Math.hypot(dx, dy)));
  const base = Math.atan2(dx, dy);
  const atHip = Math.acos((thigh * thigh + distance * distance - shin * shin) / (2 * thigh * distance));
  const atFoot = Math.acos((shin * shin + distance * distance - thigh * thigh) / (2 * shin * distance));
  return [base + atHip, base - atFoot];
}

// armAngles 把关键帧里的手写法换成角度：[x, y] 是躯干坐标里手的位置。
function armAngles(spec: ArmSpec, side: -1 | 1): Vec2 {
  if (!Array.isArray(spec)) return [spec.upper, spec.elbow];
  return armIK(spec[0] - side * SHOULDER_X, spec[1]);
}

// unwrap 把角度挪到离 prev 最近的那一圈，插值时不会绕远路转一大圈。
function unwrap(angle: number, prev: number): number {
  while (angle - prev > Math.PI) angle -= Math.PI * 2;
  while (prev - angle > Math.PI) angle += Math.PI * 2;
  return angle;
}

/* ------------------------------ 动作数据 ------------------------------ */

const SPECS: Record<string, ActionSpec> = {
  // 火球术：剑收到腰后蓄火（剑尖燃起火苗），弓步把剑往前一刺，火球从剑尖飞出，剑尖被后坐力顶起来
  projectile: {
    ms: 480, release: 0.28, swap: false, muzzle: 'tip',
    keys: [
      { t: 0, near: HAND_NEAR, far: HAND_FAR },
      { t: 0.18, near: [-2, 8], far: [5, 6], blade: 1.75, lean: -0.12, feet: [[-4, 0], [3, 0]], drop: 2, ease: 'out' },
      { t: 0.3, near: [19, -3], far: [-12, 4], blade: 1.82, lean: 0.28, feet: [[-8, 0], [9, 0]], drop: 4, ease: 'out' },
      { t: 0.46, near: [17, -5], far: [-11, 4], blade: 2.05, lean: 0.22, feet: [[-8, 0], [9, 0]], drop: 4 },
      { t: 1, near: HAND_NEAR, far: HAND_FAR },
    ],
  },
  // 旋风斩：压低身子把剑往后一收，剑平举伸直原地转一整圈，盾在身后平衡
  circle: {
    ms: 580, release: 0.14, swap: false, spin: [0.14, 0.8],
    keys: [
      { t: 0, near: HAND_NEAR, far: HAND_FAR },
      { t: 0.12, near: [-1, 8], far: [6, 6], blade: -1.3, lean: -0.12, feet: [[-5, 0], [5, 0]], drop: 4, ease: 'out' },
      { t: 0.26, near: [17, 4], far: [-13, 8], blade: 1.62, lean: 0.06, feet: [[-6, 0], [6, 0]], drop: 5 },
      { t: 0.78, near: [17, 4], far: [-13, 8], blade: 1.62, lean: 0.06, feet: [[-6, 0], [6, 0]], drop: 5 },
      { t: 1, near: HAND_NEAR, far: HAND_FAR },
    ],
  },
  // 治疗术：握剑竖在面前（骑士礼，持盾的手收在身侧），低头祈祷，踮起一点脚，绿光顺着剑身往上爬
  heal: {
    ms: 720, release: 0.2, swap: false,
    keys: [
      { t: 0, near: HAND_NEAR, far: HAND_FAR },
      { t: 0.22, near: [10, 2.5], far: [3, 6], blade: Math.PI - 0.1, lean: 0.05, ease: 'out' },
      { t: 0.5, near: [10, 2], far: [3, 6], blade: Math.PI - 0.1, lean: 0.13, lift: 1.5 },
      { t: 0.8, near: [10, 2], far: [3, 6], blade: Math.PI - 0.1, lean: 0.1, lift: 1 },
      { t: 1, near: HAND_NEAR, far: HAND_FAR },
    ],
  },
  // 战吼：先缩身蓄力（拳收在胸前），再猛地挺胸仰头，剑指天、盾甩向身后，张口怒吼，全身发颤
  buff: {
    ms: 680, release: 0.24, swap: false,
    keys: [
      { t: 0, near: HAND_NEAR, far: HAND_FAR },
      { t: 0.14, near: [9, 6], far: [3, 7], blade: 1.0, lean: 0.22, feet: [[-3, 0], [2, 0]], drop: 4, ease: 'out' },
      { t: 0.26, near: [12, -10], far: [-15, 6], blade: Math.PI - 0.3, lean: -0.24, feet: [[-6, 0], [6, 0]], drop: 1, lift: 2.5, jitter: 1, ease: 'out' },
      { t: 0.76, near: [12, -9], far: [-15, 5], blade: Math.PI - 0.27, lean: -0.2, feet: [[-6, 0], [6, 0]], drop: 1.5, jitter: 0.5 },
      { t: 1, near: HAND_NEAR, far: HAND_FAR },
    ],
  },
  // 护盾：把盾高高举向天空，身子微微后仰、两脚扎稳，剑压在身后
  shield: {
    ms: 540, release: 0.24, swap: true,
    keys: [
      { t: 0, near: IDLE_NEAR, far: IDLE_FAR },
      { t: 0.24, near: [9.5, -13], far: [-4, 7], blade: -0.5, lean: -0.12, feet: [[-5, 0], [5, 0]], drop: 2, ease: 'out' },
      { t: 0.72, near: [9.5, -12.5], far: [-4, 7], blade: -0.5, lean: -0.1, feet: [[-5, 0], [5, 0]], drop: 2.5, jitter: 0.3 },
      { t: 1, near: IDLE_NEAR, far: IDLE_FAR },
    ],
  },
  // 疾风步：起跑式——伏低身子、前脚弓后脚蹬，剑拖在身后，蓄一下力后一蹬冲出去（抬膝）
  haste: {
    ms: 460, release: 0.16, swap: true,
    keys: [
      { t: 0, near: IDLE_NEAR, far: IDLE_FAR },
      { t: 0.16, near: [13, 4], far: [-13, 3], blade: -1.75, lean: 0.55, feet: [[-12, 0], [7, 0]], drop: 7, ease: 'out' },
      { t: 0.42, near: [13, 4.5], far: [-13, 3.5], blade: -1.75, lean: 0.6, feet: [[-12, 0], [7, 0]], drop: 8 },
      { t: 0.6, near: [12, 2], far: [-12, 5], blade: -1.7, lean: 0.3, feet: [[-7, -1], [6, -6]], drop: 1, lift: 3, ease: 'out' },
      { t: 1, near: IDLE_NEAR, far: IDLE_FAR },
    ],
  },
  // 圣光庇护：倒提起剑，单膝跪地把剑插进身前的地里，手按在剑柄上，另一只手抚胸，低头
  holy: {
    ms: 780, release: 0.2, swap: false,
    keys: [
      { t: 0, near: HAND_NEAR, far: HAND_FAR },
      { t: 0.1, near: [11, -7], far: [2, 4], blade: 0.12, lean: -0.05, feet: [[-1, 0], [4, -3]], drop: 2, ease: 'out' },
      { t: 0.2, near: [16, 1], far: [4, 4], blade: 0.25, lean: 0.14, feet: [[-9, 0], [9, 0]], drop: 8, ease: 'in' },
      { t: 0.72, near: [16, 1.5], far: [4, 4], blade: 0.25, lean: 0.2, feet: [[-9, 0], [9, 0]], drop: 8 },
      { t: 1, near: HAND_NEAR, far: HAND_FAR },
    ],
  },
  // 闪现：到达时是一个往前扑的弓步，剑往前平伸，身子被拉长，随后收住站起
  blink: {
    ms: 380, release: 0, swap: false,
    keys: [
      { t: 0, near: [17, 3], far: [-13, 3], blade: 1.55, lean: 0.22, feet: [[-12, 0], [10, 0]], drop: 6, stretch: 1 },
      { t: 0.3, near: [16, 3.5], far: [-12, 4], blade: 1.55, lean: 0.2, feet: [[-12, 0], [10, 0]], drop: 6.5, ease: 'out' },
      { t: 1, near: HAND_NEAR, far: HAND_FAR },
    ],
  },
  // 烈焰附魔：盾背到背上，剑平举在胸前，空手从剑格抹到剑尖，火顺着手燃起来；最后剑尖一挑
  enchant: {
    ms: 720, release: 0.16, swap: true, slung: true,
    keys: [
      { t: 0, near: IDLE_NEAR, far: IDLE_FAR },
      { t: 0.16, near: [7, 4.2], far: [4, 6], blade: Math.PI / 2, lean: 0.04, ease: 'out' },
      { t: 0.56, near: [20, 4.2], far: [4, 6], blade: Math.PI / 2, lean: 0.08 },
      { t: 0.7, near: [11, 9], far: [5, 3], blade: 1.95, lean: -0.04, ease: 'out' },
      { t: 0.86, near: [11, 9], far: [5, 3], blade: 1.95, lean: -0.04 },
      { t: 1, near: IDLE_NEAR, far: IDLE_FAR },
    ],
  },
  // 飞斧：盾背到背上，空手从脑后抡起手斧，跨步把斧头甩出去，手顺势压到身前
  axe: {
    ms: 440, release: 0.27, swap: true, slung: true, muzzle: 'hand',
    keys: [
      { t: 0, near: IDLE_NEAR, far: IDLE_FAR },
      { t: 0.17, near: [-4, -8], far: [5, 2], blade: 1.4, lean: -0.22, feet: [[-5, 0], [3, 0]], drop: 2, ease: 'out' },
      { t: 0.29, near: [17, -4], far: [3, 4], blade: 1.5, lean: 0.2, feet: [[-8, 0], [9, 0]], drop: 4, ease: 'out' },
      { t: 0.45, near: [11, 11], far: [2, 5], blade: 1.5, lean: 0.32, feet: [[-8, 0], [9, 0]], drop: 4.5 },
      { t: 1, near: IDLE_NEAR, far: IDLE_FAR },
    ],
  },
  // 冰霜新星：高抬膝、盾和剑张开，一脚狠狠跺下去，蹲住，冰从脚下炸开，剑身结霜
  frost: {
    ms: 600, release: 0.24, swap: true,
    keys: [
      { t: 0, near: IDLE_NEAR, far: IDLE_FAR },
      { t: 0.15, near: [12, -6], far: [-9, -9], blade: -2.5, lean: -0.1, feet: [[-1, 0], [4, -9]], lift: 1, ease: 'out' },
      { t: 0.25, near: [14, 9], far: [-12, 7], blade: -1.1, lean: 0.16, feet: [[-6, 0], [7, 0]], drop: 4.5, jitter: 1, ease: 'in' },
      { t: 0.55, near: [14, 9], far: [-12, 7], blade: -1.1, lean: 0.12, feet: [[-6, 0], [7, 0]], drop: 4 },
      { t: 1, near: IDLE_NEAR, far: IDLE_FAR },
    ],
  },
};

// compile 把关键帧的手位置换成角度，补上默认值，并让相邻帧的角度连续。
function compile(spec: ActionSpec): Key[] {
  const keys: Key[] = [];
  for (const k of spec.keys) {
    const far = armAngles(k.far, -1);
    const near = armAngles(k.near, 1);
    const prev = keys[keys.length - 1];
    if (prev) {
      far[0] = unwrap(far[0], prev.far[0]);
      near[0] = unwrap(near[0], prev.near[0]);
    }
    const weaponArm = spec.swap ? far : near;
    let blade = k.blade ?? weaponArm[0] + weaponArm[1];
    if (prev) blade = unwrap(blade, prev.blade);
    keys.push({
      t: k.t,
      far,
      near,
      blade,
      lean: k.lean ?? 0,
      drop: k.drop ?? 0,
      lift: k.lift ?? 0,
      jitter: k.jitter ?? 0,
      stretch: k.stretch ?? 0,
      feet: k.feet ?? null,
      ease: k.ease ?? 'smooth',
    });
  }
  return keys;
}

const COMPILED: Record<string, Key[]> = {};
for (const [name, spec] of Object.entries(SPECS)) COMPILED[name] = compile(spec);

// ACTIONS 是每个动作的时长和出手前的时间（毫秒），按技能的 fx 名查。
export const ACTIONS: Record<string, { ms: number; lead: number }> = {};
for (const [name, spec] of Object.entries(SPECS)) {
  ACTIONS[name] = { ms: spec.ms, lead: Math.round(spec.ms * spec.release) };
}

const easeOf: Record<Ease, (t: number) => number> = {
  out: (t) => 1 - (1 - t) * (1 - t),
  in: (t) => t * t,
  smooth: (t) => t * t * (3 - 2 * t),
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];

// actionPose 返回动作 name 在进度 k 时的姿势；不是专属动作（普通攻击）返回 null。
export function actionPose(name: string | undefined, k: number): ActionPose | null {
  if (!name || k < 0 || k >= 1) return null;
  const keys = COMPILED[name];
  const spec = SPECS[name];
  if (!keys) return null;
  let i = 0;
  while (i < keys.length - 2 && k >= keys[i + 1].t) i++;
  const from = keys[i];
  const to = keys[i + 1];
  const linear = Math.max(0, Math.min(1, (k - from.t) / Math.max(1e-6, to.t - from.t)));
  const eased = easeOf[to.ease](linear);

  let feet: [Vec2, Vec2] | null = null;
  let feetWeight = 0;
  if (from.feet && to.feet) {
    feet = [lerp2(from.feet[0], to.feet[0], eased), lerp2(from.feet[1], to.feet[1], eased)];
    feetWeight = 1;
  } else if (from.feet || to.feet) {
    feet = (from.feet || to.feet)!;
    feetWeight = from.feet ? 1 - eased : eased;
  }

  let spin = 0;
  if (spec.spin) {
    const [s0, s1] = spec.spin;
    const sk = Math.max(0, Math.min(1, (k - s0) / (s1 - s0)));
    spin = easeOf.smooth(sk) * Math.PI * 2;
  }

  return {
    name,
    k,
    swap: spec.swap,
    slung: !!spec.slung,
    far: lerp2(from.far, to.far, eased),
    near: lerp2(from.near, to.near, eased),
    blade: lerp(from.blade, to.blade, eased),
    lean: lerp(from.lean, to.lean, eased),
    drop: lerp(from.drop, to.drop, eased),
    lift: lerp(from.lift, to.lift, eased),
    jitter: lerp(from.jitter, to.jitter, eased),
    stretch: lerp(from.stretch, to.stretch, eased),
    feet,
    feetWeight,
    spin,
  };
}

// muzzleOffset 是动作出手那一刻飞行道具的出发点（剑尖或手），模型单位，相对脚底、朝 +x。
// 没有飞行道具的动作返回 null。game/events.ts 按实体大小和朝向换成世界坐标交给特效。
export function muzzleOffset(name: string): { x: number; y: number } | null {
  const spec = SPECS[name];
  if (!spec?.muzzle) return null;
  const pose = actionPose(name, spec.release);
  if (!pose) return null;
  // 躯干坐标里的手：近侧肩 + 大臂 + 小臂
  const arm = spec.muzzle === 'hand' || !pose.swap ? pose.near : pose.far;
  const shoulderX = arm === pose.near ? SHOULDER_X : -SHOULDER_X;
  let x = shoulderX + Math.sin(arm[0]) * UPPER + Math.sin(arm[0] + arm[1]) * FORE;
  let y = Math.cos(arm[0]) * UPPER + Math.cos(arm[0] + arm[1]) * FORE;
  if (spec.muzzle === 'tip') {
    x += Math.sin(pose.blade) * SWORD_LENGTH;
    y += Math.cos(pose.blade) * SWORD_LENGTH;
  }
  // 换到模型坐标：上半身绕胯前倾 lean（和 canvas 的 rotate 一样，正数往前），再整体抬起 lift
  const hipY = HIP_Y + pose.drop;
  const aboveHip = SHOULDER_BELOW_HIP + y;
  const cos = Math.cos(pose.lean);
  const sin = Math.sin(pose.lean);
  return { x: x * cos - aboveHip * sin, y: hipY + x * sin + aboveHip * cos - pose.lift };
}
