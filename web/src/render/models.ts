// Procedural character models, drawn with the Canvas 2D API in a painted,
// hard-shaded style: every body part is a flat colour with a crisp shadow on
// the side away from the light and a thin lit edge toward it (cel shading),
// so figures read as solid shapes under the ink outline that render/pixi/inkFilter.ts adds.
//
// drawModel(ctx, model, p) draws one character with its feet at (p.x, p.y).
//   p.r       collision radius; the drawing scales with it
//   p.color   base colour from config
//   p.facing  radians, 0 = right, PI/2 = down
//   p.walk    walk-cycle phase in radians (advanced by distance travelled)
//   p.moving  whether the walk cycle should show
//   p.attack  -1, or 0..1 progress of an attack (wind up, strike, recover)
//   p.hit     -1, or 0..1 progress of a hit reaction
//   p.dead    -1, or 0..1 progress of the death animation (stays at 1)
//   p.time    ms clock for idle motion
//   p.isSelf  draw the own-player ground ring
//   p.bare    skip the ground ring and shadow (the Pixi actor view draws those itself)
//
// Models are drawn in local units facing +x with the feet at y = 0; a
// standard humanoid is about 46 units tall before scaling by r / 16.

import { actionPose, legIK } from './knightActions';

const LOOK_FIRE = 4;   // 武器着火的外观位，和 game/config.ts 的 LOOK_FIRE 一致（这个文件不引用游戏状态）

const TAU = Math.PI * 2;
const PI = Math.PI;
const OUTLINE = '#0b0710';

export const MODELS = ['knight', 'ranger', 'slime', 'wolf', 'alpha_wolf', 'wolf_king', 'skeleton_archer', 'skeleton_soldier', 'skeleton_knight', 'bone_pile', 'bone_statue', 'brazier', 'cracked_wall', 'stone_pillar', 'ogre_chief', 'guard', 'villager', 'hunter', 'bramble', 'wolf_pup', 'ember', 'sprout'];

/* ------------------------------ colour ------------------------------ */

const shadeCache = new Map();

// shade lightens (amt > 0) or darkens (amt < 0) a #rrggbb or rgb() colour,
// darkening toward a cool violet so shadows stay rich instead of muddy.
function shade(hex, amt) {
  const key = hex + amt;
  let out = shadeCache.get(key);
  if (out) return out;
  let r, g, b;
  const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(hex);
  if (m) {
    r = +m[1]; g = +m[2]; b = +m[3];
  } else {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map((ch) => ch + ch).join('');
    const n = parseInt(c, 16);
    r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
  }
  if (amt >= 0) {
    r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt;
  } else {
    const k = 1 + amt;
    r = r * k + 28 * -amt; g = g * k + 10 * -amt; b = b * k + 48 * -amt;
  }
  out = `rgb(${Math.min(255, r) | 0},${Math.min(255, g) | 0},${Math.min(255, b) | 0})`;
  shadeCache.set(key, out);
  return out;
}

function safeColor(c, fallback) {
  return typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c) ? c : fallback;
}

/* ------------------------------ easing ------------------------------ */

const clamp01 = (t) => Math.max(0, Math.min(1, t));
const ease = (t) => 1 - (1 - t) * (1 - t);
const easeIn = (t) => t * t;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

// phases splits an attack into wind-up (0..0.3), strike (0.3..0.55) and
// recovery, returning eased progress through each.
function phases(attack) {
  if (attack < 0) return null;
  return {
    wind: attack < 0.3 ? ease(attack / 0.3) : 1,
    strike: attack < 0.3 ? 0 : attack < 0.55 ? ease((attack - 0.3) / 0.25) : 1,
    back: attack < 0.55 ? 0 : smooth((attack - 0.55) / 0.45),
  };
}

// arc3 blends rest → wound → struck → rest through an attack.
function arc3(ph, rest, wound, struck) {
  if (!ph) return rest;
  if (ph.strike === 0) return lerp(rest, wound, ph.wind);
  if (ph.back === 0) return lerp(wound, struck, ph.strike);
  return lerp(struck, rest, ph.back);
}

/* --------------------------- path builders -------------------------- */
// These add sub-paths without calling beginPath, so a part can be filled,
// clipped and offset as one shape by cel().

function pEll(c, x, y, rx, ry, rot = 0) {
  rx = Math.max(0.1, rx); ry = Math.max(0.1, ry);
  c.moveTo(x + Math.cos(rot) * rx, y + Math.sin(rot) * rx);
  c.ellipse(x, y, rx, ry, rot, 0, TAU);
}

function pPoly(c, pts) {
  c.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
  c.closePath();
}

function pRrect(c, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

// pTaper is a limb segment from a (radius ra) to b (radius rb) with round ends.
function pTaper(c, ax, ay, bx, by, ra, rb) {
  const ang = Math.atan2(by - ay, bx - ax);
  c.moveTo(ax + Math.cos(ang + PI / 2) * ra, ay + Math.sin(ang + PI / 2) * ra);
  c.arc(ax, ay, ra, ang + PI / 2, ang + PI * 1.5);
  c.arc(bx, by, rb, ang - PI / 2, ang + PI / 2);
  c.closePath();
}

/* ------------------------------ shading ----------------------------- */

// The key light comes from the upper left of the screen. LX flips with the
// model's facing so the light stays put when a character turns around.
// cel 的可选参数：dark 阴影色、lit 亮边色（false 表示不画）、sd 阴影深度、hl 亮边宽度、lw 描边宽度。
interface CelOpts { dark?: string; lit?: string | false; sd?: number; hl?: number; lw?: number }

// 人形模型的上半身尺寸，humanoid() 算一次后给各部件用。
interface Body { hipY: number; sy: number; sw: number; ww: number; hr: number; hx: number; hy: number }

let LX = 1;

// cel paints the shape built by path(c): a shadow tone over all of it, the
// base tone shifted toward the light (leaving a hard shadow crescent on the
// far side), a thin lit edge on the near side, and an outline.
function cel(ctx, path, base, o: CelOpts = {}) {
  const dark = o.dark || shade(base, -0.38);
  const lit = o.lit === undefined ? shade(base, 0.3) : o.lit;
  const sd = o.sd ?? 2.2;          // shadow depth
  const hl = o.hl ?? 1.1;          // lit edge width
  ctx.beginPath();
  path(ctx);
  ctx.fillStyle = dark;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.beginPath();
  ctx.translate(-sd * 0.7 * LX, -sd);
  path(ctx);
  ctx.fillStyle = base;
  ctx.fill();
  if (lit && hl > 0) {
    // the shape minus itself shifted away from the light
    ctx.translate(sd * 0.7 * LX, sd);
    ctx.beginPath();
    ctx.rect(-400, -400, 800, 800);
    ctx.translate(hl * 0.8 * LX, hl);
    path(ctx);
    ctx.fillStyle = lit;
    ctx.fill('evenodd');
  }
  ctx.restore();
  if (o.lw !== 0) {
    ctx.beginPath();
    path(ctx);
    ctx.lineWidth = o.lw || 1.5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
  }
}

// flat fills a shape with one colour and an optional outline.
function flat(ctx, path, color, lw = 0) {
  ctx.beginPath();
  path(ctx);
  ctx.fillStyle = color;
  ctx.fill();
  if (lw) {
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
  }
}

function line(ctx, pts, color, w, cap = 'round') {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.lineCap = cap;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.stroke();
}

// inkLine draws a stroke with a dark outline around it.
function inkLine(ctx, pts, color, w) {
  line(ctx, pts, OUTLINE, w + 2.4);
  line(ctx, pts, color, w);
}

// glint is a small additive spark, for gems, eyes and metal.
function glint(ctx, x, y, r, color, a = 1) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha *= a;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// rivets 画一排小铆钉：暗色底加一个亮点，表现金属件的细节。
function rivets(ctx, pts, r = 0.6, color = '#f4e2b0') {
  for (let i = 0; i < pts.length; i += 2) {
    ctx.fillStyle = 'rgba(11,7,16,0.55)';
    ctx.beginPath(); ctx.arc(pts[i] + 0.2, pts[i + 1] + 0.25, r + 0.25, 0, TAU); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(pts[i], pts[i + 1], r, 0, TAU); ctx.fill();
  }
}

// folds 画几条衣褶 / 纹理线（半透明暗色），给大块颜色加一点质感。
function folds(ctx, lines, color = 'rgba(20,10,30,0.4)', w = 0.8) {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const l of lines) {
    ctx.moveTo(l[0], l[1]);
    if (l.length === 6) ctx.quadraticCurveTo(l[2], l[3], l[4], l[5]);
    else ctx.lineTo(l[2], l[3]);
  }
  ctx.stroke();
}

// joint follows a two-segment limb from (x, y): angles are from straight
// down, positive swings toward +x (forward).
function joint(x, y, a1, l1, a2, l2) {
  const kx = x + Math.sin(a1) * l1;
  const ky = y + Math.cos(a1) * l1;
  return { kx, ky, ex: kx + Math.sin(a2) * l2, ey: ky + Math.cos(a2) * l2 };
}

/* ------------------------------ entry ------------------------------- */

// keepsCorpse 报告这种模型倒下以后是不是一直留着、不溶解（点着的灵火盆）。
export function keepsCorpse(model: string): boolean {
  return !!SPECS[model]?.keep;
}

export function drawModel(ctx, model, p) {
  const R = p.r || 14;
  const s = R / 16;
  const dir = Math.cos(p.facing || 0) < -0.1 ? -1 : 1;
  const dead = p.dead >= 0 ? clamp01(p.dead) : -1;
  const hit = p.hit >= 0 && p.hit < 1 ? p.hit : -1;
  const spec = SPECS[model] || SPECS.blob;

  ctx.save();
  ctx.translate(p.x, p.y);

  if (p.isSelf && dead < 0 && !p.bare) {
    const pulse = 0.5 + 0.5 * Math.sin(p.time / 300);
    ctx.strokeStyle = `rgba(255,214,90,${0.45 + 0.3 * pulse})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, (R + 8) * 1.1, (R + 8) * 0.45, 0, 0, TAU);
    ctx.stroke();
  }
  if (!p.bare) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, 0, R * 1.05, R * 0.42, 0, 0, TAU);
    ctx.fill();
  }

  // hit: knocked back away from the facing, with a short shudder
  if (hit >= 0) {
    const k = (1 - hit) * (1 - hit);
    ctx.translate(-dir * 5 * k * s + Math.sin(hit * 46) * 1.2 * k, 0);
  }
  if (dead >= 0 && !spec.keep) {
    // fade out over the second half of the fall（keep 的模型倒下以后还留着，比如点着的灵火盆）
    ctx.globalAlpha *= 1 - 0.5 * clamp01((dead - 0.4) / 0.6);
    if (spec.fall) {
      // topple around the feet: buckle, tip, then hit the ground with a bounce
      const t = clamp01(dead / 0.8);
      const bounce = dead > 0.8 ? Math.sin(((dead - 0.8) / 0.2) * PI) * 0.06 : 0;
      ctx.rotate(spec.fall * dir * (easeIn(t) * PI * 0.5 - bounce));
    }
  }

  ctx.scale(dir * s, s);
  LX = dir;
  const q = { ...p, s, dir, dead, hit, ph: phases(p.attack) };
  spec.draw(ctx, q);
  ctx.restore();
}

/* ----------------------------- humanoid ----------------------------- */

// gait returns the shared body motion of a two-legged walker: per-leg thigh
// and knee angles, arm swing, body bob and lean.
function gait(q, stride = 0.62) {
  const t = q.time / 1000;
  const g = { bob: 0, lean: 0, drop: 0, legs: [], arms: [], breathe: Math.sin(t * 2.4) };
  if (q.moving && q.dead < 0) {
    const ph = q.walk || 0;
    for (let i = 0; i < 2; i++) {
      const f = ph + i * PI;
      const thigh = Math.sin(f) * stride;
      // the swinging leg bends at the knee as it comes forward
      const knee = 0.12 + Math.max(0, Math.cos(f)) * 1.0;
      g.legs.push([thigh, thigh - knee]);
      // 手臂和同侧的腿反着摆；肘只能往前弯（小臂角度比大臂大），往前摆时弯得多一些
      g.arms.push([-Math.sin(f) * 0.55, 0.35 + Math.max(0, -Math.sin(f)) * 0.55]);
    }
    g.bob = Math.abs(Math.cos(ph)) * 1.8 - 0.6;
    g.lean = 0.1;
  } else {
    g.legs.push([-0.12, -0.16], [0.14, 0.08]);
    g.arms.push([0.12 + g.breathe * 0.03, 0.3], [-0.08 - g.breathe * 0.03, 0.25]);
    g.bob = g.breathe * 0.5;
  }
  if (q.hit >= 0) g.lean -= 0.35 * (1 - q.hit) * (1 - q.hit);
  if (q.dead >= 0) {
    // go limp: knees buckle, arms fly up as the body tips back
    const d = q.dead;
    g.legs = [[-0.1 + d * 0.3, -0.1 + d * 0.9], [0.2 + d * 0.2, 0.2 + d * 0.7]];
    g.arms = [[-0.6 - d * 1.6, -0.2], [-0.4 - d * 2.0, -0.5]];
    g.bob = -d * 3;
  }
  return g;
}

// humanoid draws a two-legged figure. o supplies the palette (skin, legs,
// boots, body), proportions and part painters:
//   back(ctx, q, B)            behind everything (capes, quivers)
//   offhand(ctx, q, B, hand)   far arm's hand (shields, bows)
//   swapHands(q)               true: weapon in the far hand (behind the body), offhand in the near hand
//                              (a right-hander seen from the left: shield toward the viewer)
//   torso(ctx, q, B)           over the torso
//   head(ctx, q, B)            head and headgear, drawn at (B.hx, B.hy)
//   arms(q, g)                 override [far, near] arm angles, e.g. for attacks
//   weapon(ctx, q, B, hand)    near arm's hand
//   lean(q, g)                 extra body lean (attacks)
//   adjust(q, g)               改写这一帧的步态（技能动作的站姿：腿的角度 g.legs、胯下沉 g.drop）
function humanoid(ctx, q, o) {
  const g = gait(q, o.stride);
  if (o.adjust) o.adjust(q, g);
  const hipY = -(o.hip ?? 17) - g.bob * 0.5 + (g.drop ?? 0);
  const lean = g.lean + (o.lean ? o.lean(q, g) : 0);
  const thigh = o.thigh ?? 8.5;
  const shin = o.shin ?? 8.5;
  const legW = o.legW ?? 3.3;

  // legs from the hip, far one first and darker
  const far = shade(o.legs, -0.22);
  const legAt = (i, x) => joint(x, hipY, g.legs[i][0], thigh, g.legs[i][1], shin);
  const L0 = legAt(0, -2.2);
  const L1 = legAt(1, 2.2);

  ctx.save();
  // upper body pivots at the hip for lean
  const B = {} as Body;
  B.hipY = hipY;
  B.sy = hipY - (o.torso ?? 14) - g.bob * 0.5 + g.breathe * 0.3;  // shoulder line
  B.sw = o.shoulder ?? 8.5;                                      // half shoulder width
  B.ww = o.waist ?? 6;                                           // half waist width
  B.hr = o.headR ?? 7.2;
  B.hx = 1 + (o.headX ?? 0);
  B.hy = B.sy - B.hr + 1.5;

  const drawLeg = (L, x, color, boot) => {
    cel(ctx, (c) => pTaper(c, x, hipY, L.kx, L.ky, legW, legW * 0.85), color, { sd: 1.4, lw: 1.3 });
    cel(ctx, (c) => pTaper(c, L.kx, L.ky, L.ex, L.ey, legW * 0.85, legW * 0.7), color, { sd: 1.4, lw: 1.3 });
    // boot pointing forward
    cel(ctx, (c) => {
      c.moveTo(L.ex - 2.6, L.ey - 3.4);
      c.lineTo(L.ex + 1.8, L.ey - 3.4);
      c.quadraticCurveTo(L.ex + 5.6, L.ey - 1.8, L.ex + 5.2, L.ey + 0.6);
      c.lineTo(L.ex - 3, L.ey + 0.6);
      c.closePath();
    }, boot, { sd: 1.2, lw: 1.3 });
  };

  if (o.back) {
    ctx.save();
    ctx.translate(0, hipY);
    ctx.rotate(lean);
    ctx.translate(0, -hipY);
    o.back(ctx, q, B);
    ctx.restore();
  }
  drawLeg(L0, -2.2, far, shade(o.boots, -0.2));

  ctx.translate(0, hipY);
  ctx.rotate(lean);
  ctx.translate(0, -hipY);

  // far arm
  const arms = o.arms ? o.arms(q, g) : g.arms;
  const upper = o.upper ?? 7.2;
  const fore = o.fore ?? 6.8;
  const armW = o.armW ?? 2.8;
  const A0 = joint(-B.sw + 2.5, B.sy + 2, arms[0][0], upper, arms[0][0] + arms[0][1], fore);
  const swap = !!o.swapHands?.(q);
  const sleeve0 = shade(o.sleeve || o.body, -0.25);
  if (swap && o.weapon && o.weaponBehindHand) o.weapon(ctx, q, B, { x: A0.ex, y: A0.ey, a: arms[0][0] + arms[0][1], far: true });
  cel(ctx, (c) => pTaper(c, -B.sw + 2.5, B.sy + 2, A0.kx, A0.ky, armW, armW * 0.85), sleeve0, { sd: 1.2, lw: 1.3 });
  cel(ctx, (c) => pTaper(c, A0.kx, A0.ky, A0.ex, A0.ey, armW * 0.85, armW * 0.8), shade(o.forearm || o.skin, -0.2), { sd: 1.2, lw: 1.3 });
  flat(ctx, (c) => pEll(c, A0.ex, A0.ey, 2.4, 2.4), shade(o.hand || o.skin, -0.2), 1.2);
  if (swap && o.weapon && !o.weaponBehindHand) o.weapon(ctx, q, B, { x: A0.ex, y: A0.ey, a: arms[0][0] + arms[0][1], far: true });
  if (!swap && o.offhand) o.offhand(ctx, q, B, { x: A0.ex, y: A0.ey, a: arms[0][0] + arms[0][1] });

  ctx.restore();
  drawLeg(L1, 2.2, o.legs, o.boots);
  ctx.save();
  ctx.translate(0, hipY);
  ctx.rotate(lean);
  ctx.translate(0, -hipY);

  // torso: broad shoulders tapering to the waist
  cel(ctx, (c) => {
    c.moveTo(-B.sw, B.sy + 1);
    c.quadraticCurveTo(0, B.sy - 2.2, B.sw, B.sy + 1);
    c.quadraticCurveTo(B.sw + 0.8, B.sy + 6, B.ww, hipY + 1);
    c.lineTo(-B.ww, hipY + 1);
    c.quadraticCurveTo(-B.sw - 0.8, B.sy + 6, -B.sw, B.sy + 1);
    c.closePath();
  }, o.body, { sd: 2.6 });
  if (o.torsoDetail) o.torsoDetail(ctx, q, B);

  // head
  if (o.neck !== false) flat(ctx, (c) => pRrect(c, -1.6, B.sy - 3, 4.4, 4, 1.5), shade(o.skin, -0.3));
  ctx.save();
  ctx.translate(B.hx, B.hy);
  ctx.rotate(-lean * 0.4 + (q.hit >= 0 ? -0.2 * (1 - q.hit) : 0));
  ctx.translate(-B.hx, -B.hy);
  if (o.face !== false) {
    cel(ctx, (c) => {
      // rounded skull with a slightly squared jaw toward the front
      c.moveTo(B.hx - B.hr, B.hy);
      c.arc(B.hx, B.hy, B.hr, PI, TAU);
      c.quadraticCurveTo(B.hx + B.hr + 0.6, B.hy + B.hr * 0.8, B.hx + B.hr * 0.45, B.hy + B.hr);
      c.lineTo(B.hx - B.hr * 0.5, B.hy + B.hr * 0.95);
      c.quadraticCurveTo(B.hx - B.hr, B.hy + B.hr * 0.6, B.hx - B.hr, B.hy);
      c.closePath();
    }, o.skin, { sd: 2 });
  }
  o.head(ctx, q, B);
  ctx.restore();

  // near arm and weapon
  const A1 = joint(B.sw - 2.5, B.sy + 2, arms[1][0], upper, arms[1][0] + arms[1][1], fore);
  cel(ctx, (c) => pTaper(c, B.sw - 2.5, B.sy + 2, A1.kx, A1.ky, armW + 0.3, armW * 0.9), o.sleeve || o.body, { sd: 1.4, lw: 1.3 });
  cel(ctx, (c) => pTaper(c, A1.kx, A1.ky, A1.ex, A1.ey, armW * 0.9, armW * 0.85), o.forearm || o.skin, { sd: 1.3, lw: 1.3 });
  if (!swap && o.weaponBehindHand && o.weapon) o.weapon(ctx, q, B, { x: A1.ex, y: A1.ey, a: arms[1][0] + arms[1][1] });
  cel(ctx, (c) => pEll(c, A1.ex, A1.ey, 2.6, 2.6), o.hand || o.skin, { sd: 1, lw: 1.2 });
  if (!swap && !o.weaponBehindHand && o.weapon) o.weapon(ctx, q, B, { x: A1.ex, y: A1.ey, a: arms[1][0] + arms[1][1] });
  // 换手时盾在近侧手上，绑在小臂上、挡住手
  if (swap && o.offhand) o.offhand(ctx, q, B, { x: A1.ex, y: A1.ey, a: arms[1][0] + arms[1][1], near: true });
  ctx.restore();
}

// eyes draws a pair of eyes looking forward.
function eyes(ctx, x, y, color = '#16101c', h = 1.8) {
  ctx.fillStyle = color;
  ctx.beginPath();
  pEll(ctx, x, y, 1.1, h);
  pEll(ctx, x + 3.8, y, 1, h * 0.95);
  ctx.fill();
}

/* ------------------------------ knight ------------------------------ */
// The player: a crested champion in steel and a coloured tunic, with a
// flowing cape, a gilded round shield and a broad sword.

// the sword goes up behind the head and comes over the top in a chop
const KNIGHT_WOUND = 3.55;
const KNIGHT_STRUCK = 1.25;

// knightBrokenLean 是破防时身体的后仰：一下仰过去，晃一晃，最后站直。
function knightBrokenLean(k) {
  const back = k < 0.1 ? smooth(k / 0.1) : 1 - smooth(clamp01((k - 0.55) / 0.45));
  return -0.32 * back + 0.05 * Math.sin(k * 14) * back;
}

function knightArms(q, g) {
  if (q.act) return [q.act.far, q.act.near];
  const ph = q.ph;
  if (!ph && q.dead >= 0) return [g.arms[0], [g.arms[1][0] * 0.6 + 0.5, -0.9 + g.arms[1][1] * 0.3]];
  if (!ph && q.broken >= 0) {
    // 破防：盾被砸得甩到身后、手臂张开，剑也垂下来；后三成慢慢收回站姿
    const back = q.broken < 0.12 ? smooth(q.broken / 0.12) : 1 - smooth(clamp01((q.broken - 0.7) / 0.3));
    const idle = [[0.9, 1.3], [0.35, 0.6]];
    const open = [[0.25, 0.35], [-0.95, 0.25]];
    return idle.map((joint, side) => joint.map((angle, i) => angle + (open[side][i] - angle) * back));
  }
  if (!ph && q.blocking && q.parry >= 0) {
    // 完美格挡：盾猛地往前一顶（手臂几乎伸直），再收回格挡架势
    const push = q.parry < 0.2 ? smooth(q.parry / 0.2) : 1 - smooth((q.parry - 0.2) / 0.8);
    return [[-1.9 + 0.3 * push, -0.4], [0.8 + 0.6 * push, 2.1 - 1.4 * push]];
  }
  if (!ph && q.blocking) {
    // 格挡：中世纪骑士的架势。近侧手把盾竖在身前护住胸口和下巴，
    // 远侧手把剑举过肩、剑尖斜向后上方，随时能劈下来（剑和盾分开，不会叠在一起）
    const k = Math.sin(q.time / 200) * 0.04;
    return [[-1.9 + k, -0.4], [0.8, 2.1 - k * 0.5]];
  }
  if (!ph) {
    // 盾举在身前、剑尖朝前：一眼就能看出朝哪边（盾和剑都在身后时容易看成背对）
    const sw = q.moving ? Math.sin(q.walk || 0) * 0.12 : g.breathe * 0.03;
    // [远侧=持剑, 近侧=持盾]
    return [[0.9 + sw, 1.3], [0.35 - sw, 0.6]];
  }
  // overhead wind-up, a wide downward cut, then settle
  const up = arc3(ph, 0.5, KNIGHT_WOUND, KNIGHT_STRUCK);
  const el = arc3(ph, -0.9, -0.6, -0.15);
  return [[arc3(ph, 0.2, 0.7, -0.4), -0.5], [up, el]];
}

// envelope 是一段淡入、保持、淡出的强度：riseFrom..riseTo 从 0 升到 1，保持到 fallFrom，到 fallTo 降回 0。
function envelope(k, riseFrom, riseTo, fallFrom, fallTo) {
  if (k <= riseFrom || k >= fallTo) return 0;
  if (k < riseTo) return smooth((k - riseFrom) / (riseTo - riseFrom));
  if (k <= fallFrom) return 1;
  return 1 - smooth((k - fallFrom) / (fallTo - fallFrom));
}

// sparkle 画一颗四角星（圣光、护盾上的闪光）。
function sparkle(ctx, x, y, r, color) {
  if (r <= 0.2) return;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x + r * 0.18, y - r * 0.18, x + r, y);
  ctx.quadraticCurveTo(x + r * 0.18, y + r * 0.18, x, y + r);
  ctx.quadraticCurveTo(x - r * 0.18, y + r * 0.18, x - r, y);
  ctx.quadraticCurveTo(x - r * 0.18, y - r * 0.18, x, y - r);
  ctx.fillStyle = color;
  ctx.fill();
}

// flame 画一簇往上窜的火苗：外层橙红，里层金黄，高度随时间跳动。
function flame(ctx, x, y, size, time, seed) {
  const height = size * (2 + 0.6 * Math.sin(time * 0.021 + seed * 2.3) + 0.3 * Math.sin(time * 0.047 + seed));
  const sway = Math.sin(time * 0.017 + seed * 1.7) * size * 0.5;
  const tongue = (halfWidth, tall, color) => {
    ctx.beginPath();
    ctx.moveTo(x - halfWidth, y);
    ctx.quadraticCurveTo(x - halfWidth * 1.1, y - tall * 0.55, x + sway, y - tall);
    ctx.quadraticCurveTo(x + halfWidth * 1.1, y - tall * 0.55, x + halfWidth, y);
    ctx.quadraticCurveTo(x, y + halfWidth * 0.9, x - halfWidth, y);
    ctx.fillStyle = color;
    ctx.fill();
  };
  tongue(size, height, '#ff6a24');
  tongue(size * 0.55, height * 0.62, '#ffd27a');
}

// 技能动作里武器 / 手划过的光痕：from..to 是动作进度里画痕的那一段，hand 为 true 跟着空着的近侧手，否则跟着剑尖
const TRAILS = {
  projectile: { from: 0.18, to: 0.34, hand: false, color: '255,170,90' },
  buff: { from: 0.14, to: 0.28, hand: false, color: '255,140,150' },
  holy: { from: 0.08, to: 0.22, hand: false, color: '255,226,140' },
  axe: { from: 0.17, to: 0.36, hand: true, color: '235,240,255' },
  frost: { from: 0.14, to: 0.27, hand: false, color: '190,235,255' },
};

// knightTrail 按动作关键帧往回采样几帧，连成一条由细到粗的光痕（画在当前躯干坐标里）。
function knightTrail(ctx, act, B, what) {
  const trail = TRAILS[act.name];
  if (!trail || trail.hand !== (what === 'hand')) return;
  const k = act.k;
  const tail = 0.12;
  if (k < trail.from || k > trail.to + tail) return;
  const fade = k > trail.to ? 1 - (k - trail.to) / tail : 1;
  const k0 = Math.max(trail.from, k - tail);
  const k1 = Math.min(k, trail.to);
  if (k1 - k0 < 0.01) return;
  const N = 12;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const pose = actionPose(act.name, lerp(k0, k1, i / N));
    if (!pose) continue;
    const useFar = !trail.hand && pose.swap;
    const arm = useFar ? pose.far : pose.near;
    const sx = useFar ? -B.sw + 2.5 : B.sw - 2.5;
    const elbowX = sx + Math.sin(arm[0]) * 7.2;
    const elbowY = B.sy + 2 + Math.cos(arm[0]) * 7.2;
    let x = elbowX + Math.sin(arm[0] + arm[1]) * 6.8;
    let y = elbowY + Math.cos(arm[0] + arm[1]) * 6.8;
    if (!trail.hand) { x += Math.sin(pose.blade) * 19; y += Math.cos(pose.blade) * 19; }
    pts.push([x, y]);
  }
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 1; i < pts.length; i++) {
    const w = i / (pts.length - 1);
    ctx.strokeStyle = `rgba(${trail.color},${0.75 * w * fade})`;
    ctx.lineWidth = 0.5 + 3.2 * w * fade;
    ctx.beginPath();
    ctx.moveTo(pts[i - 1][0], pts[i - 1][1]);
    ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }
  ctx.restore();
}

// knightHandProp 画空着的近侧手上的东西：飞斧出手前攥着的手斧、附魔时掌心的火。
function knightHandProp(ctx, act, B, hand) {
  if (act.name === 'axe') {
    knightTrail(ctx, act, B, 'hand');
    if (act.k >= 0.28) return;
    // 斧柄顺着小臂往外伸，斧刃朝前（举到脑后时刃口朝上）
    const dx = Math.sin(hand.a);
    const dy = Math.cos(hand.a);
    const ex = hand.x + dx * 12;
    const ey = hand.y + dy * 12;
    inkLine(ctx, [hand.x - dx * 2, hand.y - dy * 2, ex, ey], '#8a5a2c', 1.6);
    const nx = -dy;
    const ny = dx;
    cel(ctx, (c) => {
      c.moveTo(ex - dx * 1.5, ey - dy * 1.5);
      c.quadraticCurveTo(ex + nx * 3 - dx * 3, ey + ny * 3 - dy * 3, ex + nx * 6 - dx * 3.5, ey + ny * 6 - dy * 3.5);
      c.quadraticCurveTo(ex + nx * 4.5 + dx * 1, ey + ny * 4.5 + dy * 1, ex + nx * 6 + dx * 4, ey + ny * 6 + dy * 4);
      c.quadraticCurveTo(ex + nx * 3 + dx * 2.5, ey + ny * 3 + dy * 2.5, ex + dx * 1.5, ey + dy * 1.5);
      c.closePath();
    }, '#e9eef6', { dark: '#8e9bb0', lit: '#ffffff', sd: 0.8, hl: 0.7, lw: 1.2 });
  }
  if (act.name === 'zone') {
    // 托在掌心的一团绿光：实心的圆加白芯，几颗绕着转的小星；按进地里后熄灭
    const hold = envelope(act.k, 0.08, 0.2, 0.5, 0.6);
    if (hold > 0) {
      const r = 2.6 * hold * (1 + 0.08 * Math.sin(act.k * 60));
      const cx = hand.x;
      const cy = hand.y - 3.2 * hold;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.fillStyle = '#5cf08f';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx - r * 0.2, cy - r * 0.2, r * 0.55, 0, TAU);
      ctx.fillStyle = '#eafff0';
      ctx.fill();
      for (let i = 0; i < 3; i++) {
        const angle = act.k * 14 + (i * TAU) / 3;
        sparkle(ctx, cx + Math.cos(angle) * r * 2, cy + Math.sin(angle) * r * 0.9 - r * 0.4, 1.3 * hold, '#c9ffd8');
      }
    }
  }
  if (act.name === 'enchant') {
    const burn = envelope(act.k, 0.1, 0.18, 0.56, 0.68);
    if (burn > 0) flame(ctx, hand.x, hand.y - 1, 1.6 * burn, act.k * 720, 7);
  }
}

// knightBladeFx 画技能动作和外观在剑身上的效果：火苗、霜刺、染色、剑尖的火球。
// 都画成实心的小形状（不画柔和的光晕：模型外面一圈半透明会被描边描出黑边），亮的地方交给后期泛光。
// geo 是剑的几何：剑格位置、剑身方向 (dx, dy)、法线 (nx, ny)、长度 L。
function knightBladeFx(ctx, q, act, geo) {
  const { x, y, dx, dy, nx, ny, L } = geo;
  const at = (s) => [x + dx * s, y + dy * s];
  const time = q.time;
  // tint 把剑身的 s0..s1 一段染色，只染在剑身形状里，不改变剪影
  const tint = (s0, s1, color, core = '') => {
    if (s1 <= s0) return;
    ctx.save();
    ctx.beginPath();
    pPoly(ctx, [x + nx * 1.9, y + ny * 1.9, x + dx * (L - 2.6) + nx * 1.4, y + dy * (L - 2.6) + ny * 1.4,
      x + dx * L, y + dy * L, x + dx * (L - 2.6) - nx * 1.4, y + dy * (L - 2.6) - ny * 1.4, x - nx * 1.9, y - ny * 1.9]);
    ctx.clip();
    const [ax, ay] = at(s0);
    const [bx, by] = at(s1);
    line(ctx, [ax, ay, bx, by], color, 5);
    if (core) line(ctx, [ax, ay, bx, by], core, 0.9);
    ctx.restore();
  };
  const name = act?.name;
  const k = act ? act.k : 0;

  // 烈焰附魔的外观（looks 里的 LOOK_FIRE）：剑身一路小火苗；附魔动作里火跟着手从剑格烧到剑尖
  let burnTo = q.looks & LOOK_FIRE ? 1 : 0;
  if (name === 'enchant') burnTo = Math.max(burnTo, k < 0.16 ? 0 : clamp01((k - 0.16) / 0.4));
  if (burnTo > 0) {
    tint(2, L * burnTo, 'rgba(255,150,60,0.55)', 'rgba(255,240,200,0.9)');
    const n = 5;
    for (let i = 0; i < n; i++) {
      const s = 3 + ((i + 0.5) / n) * (L - 5);
      if (s > L * burnTo) break;
      const [fx, fy] = at(s);
      flame(ctx, fx, fy, 1.5 - i * 0.12, time, i);
    }
  }
  if (!act) return;
  switch (name) {
    case 'projectile': {
      // 剑尖蓄起一团火，出手时一闪
      const grow = clamp01((k - 0.03) / 0.23);
      if (k > 0.03 && k < 0.3) {
        const r = 1.2 + 2.6 * grow;
        const [tx, ty] = at(L + r * 0.4);
        flame(ctx, tx, ty - r * 0.5, r * 0.7, time, 3);
        flat(ctx, (c) => pEll(c, tx, ty, r, r), '#ff6a24');
        flat(ctx, (c) => pEll(c, tx - r * 0.15, ty - r * 0.15, r * 0.6, r * 0.6), '#ffd27a');
        flat(ctx, (c) => pEll(c, tx - r * 0.2, ty - r * 0.25, r * 0.28, r * 0.28), '#fff6dc');
      }
      const flash = envelope(k, 0.26, 0.3, 0.32, 0.42);
      if (flash > 0) {
        const [tx, ty] = at(L + 2);
        sparkle(ctx, tx, ty, 6 * flash, '#fff0c0');
      }
      tint(L * 0.4, L, `rgba(255,140,60,${0.5 * envelope(k, 0.05, 0.25, 0.34, 0.5)})`);
      break;
    }
    case 'heal': {
      // 绿光从剑格顺着剑身爬到剑尖，然后整把剑亮着，最后熄掉
      const glow = envelope(k, 0.16, 0.22, 0.82, 0.98);
      const climb = clamp01((k - 0.16) / 0.26);
      if (glow > 0) {
        tint(1, L * climb, `rgba(120,255,160,${0.6 * glow})`, `rgba(230,255,235,${glow})`);
        if (climb >= 1) {
          const [tx, ty] = at(L + 1.5);
          sparkle(ctx, tx, ty, (2.6 + Math.sin(time / 90) * 0.8) * glow, '#e8ffe8');
        }
      }
      break;
    }
    case 'holy': {
      // 剑插进地里那一下剑尖迸出金光，跪着的时候整把剑泛金，剑身上闪几颗星
      const glow = envelope(k, 0.16, 0.22, 0.8, 0.96);
      if (glow > 0) {
        tint(1, L, `rgba(255,220,120,${0.6 * glow})`, `rgba(255,250,225,${glow})`);
        for (let i = 0; i < 3; i++) {
          const blink = Math.max(0, Math.sin(time / 110 + i * 2.1));
          const [sx, sy] = at(5 + i * 5.5);
          sparkle(ctx, sx + nx * (i % 2 ? 2.4 : -2.4), sy + ny * (i % 2 ? 2.4 : -2.4), 2.2 * blink * glow, '#fff6c9');
        }
      }
      const burst = envelope(k, 0.18, 0.21, 0.24, 0.36);
      if (burst > 0) {
        const [tx, ty] = at(L - 1);
        sparkle(ctx, tx, ty, 8 * burst, '#fff3c0');
      }
      break;
    }
    case 'buff': {
      // 剑举到天上时剑尖一闪红光
      const flash = envelope(k, 0.22, 0.27, 0.32, 0.5);
      if (flash > 0) {
        const [tx, ty] = at(L + 1);
        sparkle(ctx, tx, ty, 6 * flash, '#ffd0d6');
        tint(L * 0.3, L, `rgba(255,90,110,${0.5 * flash})`);
      }
      break;
    }
    case 'frost': {
      // 跺脚那一下剑身结霜：泛冰蓝，两边长出一排冰刺
      const glow = envelope(k, 0.2, 0.26, 0.7, 0.92);
      if (glow > 0) {
        tint(1, L, `rgba(150,220,255,${0.6 * glow})`, `rgba(240,250,255,${glow})`);
        for (let i = 0; i < 4; i++) {
          const s = 5 + i * 4;
          const side = i % 2 ? 1 : -1;
          const [bx, by] = at(s);
          const spike = (2.2 + (i % 2) * 0.8) * glow;
          ctx.beginPath();
          ctx.moveTo(bx + nx * side * 1.4 - dx * 1.2, by + ny * side * 1.4 - dy * 1.2);
          ctx.lineTo(bx + nx * side * (1.4 + spike) + dx * 0.8, by + ny * side * (1.4 + spike) + dy * 0.8);
          ctx.lineTo(bx + nx * side * 1.4 + dx * 1.2, by + ny * side * 1.4 + dy * 1.2);
          ctx.closePath();
          ctx.fillStyle = '#e4f6ff';
          ctx.fill();
        }
      }
      break;
    }
    case 'blink': {
      tint(1, L, `rgba(190,140,255,${0.6 * (1 - clamp01(k / 0.4))})`, `rgba(245,235,255,${1 - clamp01(k / 0.4)})`);
      break;
    }
  }
}

// knightStance 是技能动作的站姿：按关键帧里的落脚点用 IK 算腿，和平常的步态按权重混合。
function knightStance(q, g) {
  const act = q.act;
  if (!act) return;
  g.drop = act.drop;
  if (!act.feet) return;
  const weight = act.feetWeight;
  g.bob *= 1 - weight;
  const hipY = -17 + act.drop;
  for (let i = 0; i < 2; i++) {
    // 落脚点相对这条腿站直时的位置；脚踝离地 0.6（靴底在脚踝下面）
    const [footX, footY] = act.feet[i];
    const [thigh, shin] = legIK(footX, -0.6 + footY - hipY, 8.5, 8.5);
    const base = g.legs[i] || [0, 0];
    g.legs[i] = [lerp(base[0], thigh, weight), lerp(base[1], shin, weight)];
  }
}

// knightSweep 画旋风斩时剑尖扫出的一圈光：front 为 true 画身前那半圈（在身体之后画），否则画身后那半圈。
function knightSweep(ctx, act, front) {
  const turn = act.spin;
  if (turn <= 0.05 || turn >= TAU - 0.05) return;
  const fade = Math.min(1, turn / 0.8, (TAU - turn) / 0.8);
  const cy = -21 + act.drop;
  const rx = 36;
  const ry = 9;
  const span = 2.2;
  const N = 18;
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < N; i++) {
    const a0 = turn - span * (1 - i / N);
    const a1 = turn - span * (1 - (i + 1) / N);
    const mid = (a0 + a1) / 2;
    if (Math.sin(mid) > 0 !== front) continue;
    const k = (i + 1) / N;
    ctx.globalAlpha = 0.75 * k * fade;
    ctx.strokeStyle = k > 0.8 ? '#ffffff' : 'rgba(235,240,255,1)';
    ctx.lineWidth = 0.6 + 2.6 * k;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a0) * rx, cy + Math.sin(a0) * ry);
    ctx.lineTo(Math.cos(a1) * rx, cy + Math.sin(a1) * ry);
    ctx.stroke();
  }
  ctx.restore();
}

// 骑士的皮肤：同一套骨骼和动作，只换配色和部件。没写的颜色用玩家颜色（paladin 全用玩家颜色）。
//   steel 盔甲、trim 镶边、legs/boots 腿和靴、hand 手套、cloth 外袍和袖子、cape 披风、
//   plume 盔顶羽饰（false 不画）、helm 头盔样式、shield 盾面、emblem 盾徽、eye 面甲缝里的眼光
const KNIGHT_SKINS = {
  paladin: { steel: '#c3cbd6', trim: '#e2b04a', legs: '#4a5160', boots: '#2b2f3a', hand: '#8a6a4c', helm: 'open', emblem: 'sun' },
  obsidian: {
    steel: '#4a4a58', trim: '#c8343a', legs: '#26262e', boots: '#18181e', hand: '#2e2e36',
    cloth: '#7a1622', cape: '#5c0f18', plume: false, helm: 'horned', shield: '#23232b', emblem: 'cross', eye: '#ff4a3a',
  },
  gilded: {
    steel: '#e6c46c', trim: '#fff1c2', legs: '#8a7656', boots: '#5a4630', hand: '#b0905a',
    cloth: '#f2efe6', cape: '#efe9da', plume: false, helm: 'winged', shield: '#f4f0e4', emblem: 'sun',
  },
  // 骸骨守卫（首次通关亡者地穴解锁）：骨白色的甲，深青灰的布，骷髅面盔，盾上灵火色的十字
  boneguard: {
    steel: '#d8d0b8', trim: '#5fd8ff', legs: '#34363e', boots: '#202128', hand: '#b8ae96',
    cloth: '#2a3440', cape: '#1e2a36', plume: false, helm: 'skull', shield: '#2a3038', emblem: 'cross', eye: '#7fe8ff',
  },
};

// drawSkullHelm 是骸骨守卫的骷髅面盔：骨白的圆颅、深陷的眼窝里燃着灵火、颧骨和一排牙，额头一道裂纹。
function drawSkullHelm(ctx, q, B, skin) {
  const { hx, hy, hr } = B;
  const bone = skin.steel;
  // 颅顶和后脑
  cel(ctx, (c) => {
    c.moveTo(hx - hr - 0.6, hy + 3.5);
    c.arc(hx, hy - 0.6, hr + 1.1, PI * 0.95, TAU + 0.1);
    c.lineTo(hx + hr + 0.9, hy + 2.6);
    c.lineTo(hx + 5.6, hy + 4.2);
    c.lineTo(hx + 1, hy + 4.6);
    c.lineTo(hx - hr + 0.4, hy + 6);
    c.closePath();
  }, bone, { sd: 2 });
  // 下颌和牙
  cel(ctx, (c) => {
    c.moveTo(hx + 0.4, hy + 4.4);
    c.lineTo(hx + hr + 0.4, hy + 3.4);
    c.quadraticCurveTo(hx + hr + 0.6, hy + 7, hx + 4.4, hy + 7.6);
    c.lineTo(hx - 0.6, hy + 7.2);
    c.closePath();
  }, shade(bone, -0.08), { sd: 1, lw: 1.1 });
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  for (let x = hx + 1.6; x <= hx + hr; x += 1.5) { ctx.moveTo(x, hy + 4.2); ctx.lineTo(x, hy + 5.8); }
  ctx.stroke();
  // 眼窝（近大远小）和里面的灵火
  flat(ctx, (c) => { pEll(c, hx + 3.6, hy + 0.4, 1.9, 2.1); pEll(c, hx + 7, hy + 0.5, 1.3, 1.8); }, '#0b0710');
  const flicker = 0.75 + 0.25 * Math.sin(q.time / 90);
  flat(ctx, (c) => { pEll(c, hx + 3.7, hy + 0.7, 0.9 * flicker, 1.1); pEll(c, hx + 7, hy + 0.8, 0.6 * flicker, 0.9); }, skin.eye);
  glint(ctx, hx + 3.7, hy + 0.6, 4.5, 'rgba(120,230,255,0.45)');
  // 鼻孔、颧骨、额头的裂纹
  flat(ctx, (c) => pPoly(c, [hx + 6.8, hy + 2.2, hx + 7.8, hy + 3.6, hx + 6.2, hy + 3.6]), '#1a1418');
  line(ctx, [hx + 1.6, hy + 2.6, hx + 4.6, hy + 3.2], shade(bone, -0.35), 0.7);
  line(ctx, [hx - 1.5, hy - hr - 0.2, hx - 0.4, hy - 4, hx + 1.4, hy - 3.2, hx + 1, hy - 1.6], 'rgba(40,30,24,0.75)', 0.8);
  glint(ctx, hx - 2.5, hy - 5, 2.6, 'rgba(255,255,255,0.35)');
}

// drawHornedHelm 是黑曜骑士的全封闭头盔：圆顶、只留一道眼缝（缝里透出红光），两侧一对往前弯的角。
function drawHornedHelm(ctx, q, B, skin) {
  const { hx, hy, hr } = B;
  // 远侧的角先画（在头盔后面）
  const horn = (side, color) => {
    const bx = hx + (side < 0 ? -3.5 : 1.5);
    const by = hy - hr + 2;
    cel(ctx, (c) => {
      c.moveTo(bx - 1.6, by + 1);
      c.quadraticCurveTo(bx - 6, by - 4, bx - 2, by - 10);
      c.quadraticCurveTo(bx - 3.2, by - 4.5, bx + 2, by - 0.5);
      c.closePath();
    }, color, { sd: 1, lw: 1.1 });
  };
  horn(-1, '#b8ac94');
  cel(ctx, (c) => {
    c.moveTo(hx - hr - 0.8, hy + 4);
    c.arc(hx, hy - 0.4, hr + 1, PI * 0.95, TAU + 0.12);
    c.lineTo(hx + hr + 1, hy + 4.6);
    c.quadraticCurveTo(hx + 3, hy + 7.4, hx - 2, hy + 7);
    c.lineTo(hx - hr, hy + 6.4);
    c.closePath();
  }, skin.steel, { sd: 2 });
  // 眼缝和透出来的红光
  flat(ctx, (c) => pRrect(c, hx + 0.5, hy - 0.2, hr + 0.4, 1.8, 0.6), '#0b0710');
  flat(ctx, (c) => { pEll(c, hx + 3.4, hy + 0.7, 1.1, 0.6); pEll(c, hx + 6.6, hy + 0.7, 0.9, 0.5); }, skin.eye);
  // 透气孔和中脊
  line(ctx, [hx - 1, hy - hr - 0.2, hx + 2, hy - hr + 1, hx + hr - 0.5, hy - 2], shade(skin.steel, 0.35), 0.8);
  horn(1, '#ddd2bc');
  glint(ctx, hx - 2.5, hy - 5, 2.6, 'rgba(255,255,255,0.35)');
}

// 骑士的剑（装备的武器外观 gear）：L 剑身长、width 剑身半宽、blade/dark/lit 剑身三色、guard 护手、gem 宝石、edge 刃上的光
const KNIGHT_SWORDS = {
  knight_sword: { L: 20, width: 1.9, blade: '#e8eef5', dark: '#8e9bb0', lit: '#ffffff', guard: '', gem: '#ff4a3a', edge: '' },
  blood_blade: { L: 21, width: 1.8, blade: '#7a1c26', dark: '#3a0a12', lit: '#a8303c', guard: '#2a2228', gem: '#ff2a3a', edge: '#ff5a64' },
  flame_greatsword: { L: 25, width: 2.6, blade: '#4a2a22', dark: '#24120e', lit: '#8a4a30', guard: '#e2802a', gem: '#ffd27a', edge: '#ff8a2a' },
};

function drawKnight(ctx, q) {
  // 技能的专属动作（见 knightActions.ts）；没有时是普通斩击（q.ph）或站立、走路
  const act = q.dead >= 0 ? null : actionPose(q.action, q.attack);
  if (act) q = { ...q, ph: null, act };
  ctx.save();
  if (act) {
    // 跳起、发力颤动、闪现到达时的拉伸、旋风斩的转身
    const shake = act.jitter ? Math.sin(q.time * 0.09) * act.jitter * 0.7 : 0;
    ctx.translate(shake, -act.lift);
    if (act.stretch > 0) ctx.scale(1 + 0.22 * act.stretch, 1 - 0.12 * act.stretch);
    if (act.spin > 0) {
      knightSweep(ctx, act, false);
      let sx = Math.cos(act.spin);
      if (Math.abs(sx) < 0.3) sx = sx < 0 ? -0.3 : 0.3;
      ctx.scale(sx, 1);
      // 转到背对时光照方向也跟着翻过来，亮面始终在左上
      if (sx < 0) LX = -q.dir;
    }
  }
  drawKnightBody(ctx, q);
  LX = q.dir;
  if (act && act.spin > 0) {
    ctx.restore();
    ctx.save();
    ctx.translate(0, -act.lift);
    knightSweep(ctx, act, true);
  }
  ctx.restore();
}

function drawKnightBody(ctx, q) {
  const color = safeColor(q.color, '#4da3ff');
  const skin = KNIGHT_SKINS[q.skin] || KNIGHT_SKINS.paladin;
  const steel = skin.steel;
  const gold = skin.trim;
  const cloth = skin.cloth || color;
  const capeColor = skin.cape || color;
  const shieldColor = skin.shield || shade(color, -0.3);
  const sword = KNIGHT_SWORDS[q.gear] || KNIGHT_SWORDS.knight_sword;
  const act = q.act;
  humanoid(ctx, q, {
    legs: skin.legs, boots: skin.boots, body: steel, sleeve: cloth, forearm: steel, hand: skin.hand,
    skin: '#f0c8a0', shoulder: 9, waist: 6, headR: 7.4,
    lean: (q) => (act ? act.lean + (act.jitter ? Math.sin(q.time * 0.07) * act.jitter * 0.03 : 0)
      : q.ph ? arc3(q.ph, 0, -0.22, 0.28) : q.dead >= 0 ? 0
        : q.broken >= 0 ? knightBrokenLean(q.broken)
          : q.blocking ? 0.14 + (q.parry >= 0 ? 0.16 * Math.sin(Math.min(1, q.parry / 0.4) * Math.PI) : 0) : 0),
    arms: knightArms,
    adjust: knightStance,
    back(ctx, q, B) {
      // cape: flows back with speed and ripples（转圈、冲刺、闪现到达时也扬起来）
      const sway = Math.sin(q.time / 230 + (q.walk || 0)) * 2;
      const flare = act && (act.spin > 0 || act.stretch > 0 || act.name === 'haste');
      const run = q.moving || flare ? 7 : 0;
      cel(ctx, (c) => {
        c.moveTo(-B.sw + 1, B.sy);
        c.quadraticCurveTo(-B.sw - 6 - run, B.sy + 10, -B.sw - 5 - run - sway, B.hipY + 12);
        c.lineTo(-B.sw - 1 - run * 0.6 - sway * 0.5, B.hipY + 9);
        c.lineTo(-B.sw + 2 - run * 0.4, B.hipY + 13);
        c.quadraticCurveTo(-2, B.hipY + 2, B.sw - 3, B.sy + 2);
        c.closePath();
      }, shade(capeColor, -0.42), { dark: shade(capeColor, -0.65), lit: shade(capeColor, -0.15), sd: 3 });
      // 披风的褶皱和金色滚边
      folds(ctx, [
        [-B.sw - 1, B.sy + 4, -B.sw - 4 - run * 0.5, B.sy + 12, -B.sw - 3 - run * 0.8 - sway, B.hipY + 9],
        [-B.sw + 2, B.sy + 6, -B.sw - 0.5 - run * 0.3, B.hipY + 2, -B.sw - run * 0.4 - sway * 0.5, B.hipY + 9],
      ], 'rgba(10,6,24,0.45)', 0.9);
      line(ctx, [-B.sw - 5 - run - sway, B.hipY + 12, -B.sw - 1 - run * 0.6 - sway * 0.5, B.hipY + 9, -B.sw + 2 - run * 0.4, B.hipY + 13], gold, 0.9);
      if (act?.slung) {
        // 盾背在背上：从侧面看是窄窄的一条，露出身后的边
        const x = -B.sw - 1.5;
        const y = B.sy + 8;
        cel(ctx, (c) => pEll(c, x, y, 3.4, 9, -0.12), shieldColor, { sd: 1.4 });
        line(ctx, [x - 1.2, y - 7.6, x - 2.4, y, x - 1.4, y + 7.6], gold, 1.1);
      }
    },
    // 站立和走路时：盾在朝向我们的近侧手上挡在身前，剑在远侧手上从身后指向前方
    // （右手持剑的人从左侧看过去就是这样）；攻击时换回近侧手挥剑，劈砍才看得清
    swapHands: (q) => (act ? act.swap : !q.ph && !(q.dead >= 0)),
    offhand(ctx, q, B, hand) {
      if (act?.slung) {
        // 盾背到背上了，这只手空着：飞斧出手前手里攥着斧头，附魔时手心冒火
        if (hand.near) knightHandProp(ctx, act, B, hand);
        return;
      }
      // round shield with a gold sunburst boss
      const x = hand.near ? hand.x + 0.5 : hand.x - 2.5;
      const y = hand.near ? hand.y - 2 : hand.y - 5;
      cel(ctx, (c) => pEll(c, x, y, 7.2, 9), shieldColor, { sd: 2.2 });
      ctx.strokeStyle = gold;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(x, y, 5.6, 7.3, 0, 0, TAU);
      ctx.stroke();
      if (skin.emblem === 'cross') {
        // 黑曜骑士：盾面一个血红的十字
        flat(ctx, (c) => { pRrect(c, x - 0.6, y - 6, 2.4, 12, 0.5); pRrect(c, x - 3.6, y - 2.2, 8.4, 2.4, 0.5); }, gold, 0.9);
      } else {
        // 盾面上的放射纹
        ctx.strokeStyle = shade(gold, -0.25);
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU + 0.2;
          ctx.moveTo(x + 0.5 + Math.cos(a) * 3, y + Math.sin(a) * 3.8);
          ctx.lineTo(x + 0.5 + Math.cos(a) * 5, y + Math.sin(a) * 6.4);
        }
        ctx.stroke();
      }
      const rv = [];
      for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU + 0.5; rv.push(x + Math.cos(a) * 6.4, y + Math.sin(a) * 8.2); }
      rivets(ctx, rv, 0.55);
      if (skin.emblem !== 'cross') cel(ctx, (c) => pEll(c, x + 0.5, y, 2.4, 3), gold, { sd: 1, lw: 1 });
      glint(ctx, x - 0.3, y - 1.2, 2.2, 'rgba(255,240,200,0.8)');
      // 格挡、举盾放护盾时盾沿亮一圈冷光（举盾那下更亮，盾面也泛白）
      const raise = act?.name === 'shield' ? envelope(act.k, 0.12, 0.26, 0.7, 0.95) : 0;
      if ((q.blocking || raise > 0) && hand.near) {
        ctx.strokeStyle = `rgba(160,220,255,${0.85 * Math.max(q.blocking ? 1 : 0, raise)})`;
        ctx.lineWidth = 1.2 + raise * 0.8;
        ctx.beginPath();
        ctx.ellipse(x, y, 7.9, 9.7, 0, 0, TAU);
        ctx.stroke();
      }
      if (raise > 0 && hand.near) {
        ctx.save();
        ctx.beginPath();
        pEll(ctx, x, y, 7.2, 9);
        ctx.clip();
        ctx.fillStyle = `rgba(200,240,255,${0.45 * raise})`;
        ctx.fillRect(x - 8, y - 10, 16, 20);
        ctx.restore();
        sparkle(ctx, x - 2.5, y - 5, 2.6 * raise, '#ffffff');
      }
    },
    torsoDetail(ctx, q, B) {
      // tunic skirt under the cuirass, then a gold-trimmed belt
      cel(ctx, (c) => pPoly(c, [-B.ww - 0.5, B.hipY - 1, B.ww + 0.5, B.hipY - 1, B.ww + 2, B.hipY + 6, -B.ww - 2, B.hipY + 6]), cloth, { sd: 1.6 });
      ctx.strokeStyle = shade(cloth, -0.45);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const x of [-3, 0.5, 4]) { ctx.moveTo(x, B.hipY + 1); ctx.lineTo(x * 1.2, B.hipY + 5.6); }
      ctx.stroke();
      flat(ctx, (c) => pRrect(c, -B.ww - 0.8, B.hipY - 2.6, B.ww * 2 + 1.6, 3, 1), '#4a2c18', 1.1);
      flat(ctx, (c) => pRrect(c, -1.2, B.hipY - 3, 3.4, 3.8, 0.8), gold, 1);
      // pectoral line and a lion emblem glint
      ctx.strokeStyle = 'rgba(40,40,60,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-4, B.sy + 5);
      ctx.quadraticCurveTo(0.5, B.sy + 8, 5, B.sy + 4.5);
      ctx.stroke();
      // 腹甲的分片和胸口的亮光
      folds(ctx, [[-B.ww + 0.5, B.hipY - 6, 0.5, B.hipY - 4.6, B.ww - 0.5, B.hipY - 6.2], [-B.ww + 1, B.hipY - 9.5, 0.5, B.hipY - 8.2, B.ww - 1, B.hipY - 9.6]], 'rgba(40,40,70,0.45)', 0.8);
      line(ctx, [-2.5, B.sy + 3.2, 1.5, B.sy + 2.6], 'rgba(255,255,255,0.7)', 0.9);
      if (skin.helm === 'skull') {
        // 骸骨守卫：胸甲铸成一副肋骨，中间一道胸骨，肋缝里透出灵火的光
        const ribs = [];
        for (let i = 0; i < 3; i++) {
          const y = B.sy + 5.5 + i * 2.6;
          ribs.push([-B.ww + 0.8, y + 1.2, -1, y - 0.4, 0.5, y], [0.5, y, 2, y - 0.4, B.ww - 0.4, y + 1.2]);
        }
        folds(ctx, ribs, 'rgba(30,26,36,0.75)', 0.9);
        line(ctx, [0.5, B.sy + 4, 0.5, B.sy + 12.5], 'rgba(30,26,36,0.75)', 1.1);
        flat(ctx, (c) => pEll(c, -2, B.sy + 9.4, 1.4, 0.5), 'rgba(127,232,255,0.55)');
      }
      // pauldron
      cel(ctx, (c) => {
        c.moveTo(B.sw - 6, B.sy - 1);
        c.quadraticCurveTo(B.sw + 3, B.sy - 3, B.sw + 3.4, B.sy + 4);
        c.lineTo(B.sw - 4.5, B.sy + 5);
        c.closePath();
      }, steel, { sd: 1.6 });
      ctx.strokeStyle = gold;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(B.sw - 4.2, B.sy + 4.4);
      ctx.lineTo(B.sw + 3, B.sy + 3.6);
      ctx.stroke();
    },
    head(ctx, q, B) {
      const { hx, hy, hr } = B;
      // eye and cheek under the open-faced helm
      eyes(ctx, hx + 2.6, hy + 1, '#16101c', 1.7);
      if (skin.helm === 'horned') {
        drawHornedHelm(ctx, q, B, skin);
        return;
      }
      if (skin.helm === 'skull') {
        drawSkullHelm(ctx, q, B, skin);
        return;
      }
      if (act?.name === 'buff') {
        // 战吼：张大嘴吼出来
        const open = envelope(act.k, 0.18, 0.28, 0.72, 0.9);
        if (open > 0) flat(ctx, (c) => pEll(c, hx + 5, hy + 4.6, 1.3, 0.4 + 1.6 * open), '#3a1018', 0.8);
      }
      // helm: dome, cheek guard, nasal
      cel(ctx, (c) => {
        c.moveTo(hx - hr - 0.8, hy + 2.5);
        c.arc(hx, hy - 0.5, hr + 0.9, PI * 0.98, TAU + 0.05);
        c.lineTo(hx + hr + 0.6, hy - 0.6);
        c.lineTo(hx + 1.6, hy - 0.6);
        c.lineTo(hx + 0.6, hy + 4);
        c.lineTo(hx - 2.6, hy + 5.8);
        c.lineTo(hx - hr - 0.2, hy + 5.4);
        c.closePath();
      }, steel, { sd: 2 });
      line(ctx, [hx - hr + 1, hy - 1.6, hx + hr - 1, hy - 1.6], gold, 1.3);
      rivets(ctx, [hx - hr + 2.2, hy + 1.8, hx - 3.4, hy + 3.4], 0.5);
      if (skin.helm === 'winged') {
        // 金辉卫士：头盔侧面一只往后上方扬起的金翼（三层羽毛），远侧那只露出一点在后面
        const wing = (ox, oy, scale, color) => {
          const bx = hx - 1.5 + ox;
          const by = hy - 1.5 + oy;
          // 翅膀往脑后平伸：上沿一道弧线到翼尖，下沿是三片往后的羽毛尖
          cel(ctx, (c) => {
            c.moveTo(bx + 1, by - 1);
            c.quadraticCurveTo(bx - 3 * scale, by - 10 * scale, bx - 15 * scale, by - 9 * scale);
            c.lineTo(bx - 11 * scale, by - 5.6 * scale);
            c.lineTo(bx - 14 * scale, by - 4.4 * scale);
            c.lineTo(bx - 9.5 * scale, by - 2.6 * scale);
            c.lineTo(bx - 11.5 * scale, by - 0.6 * scale);
            c.quadraticCurveTo(bx - 5 * scale, by + 0.4 * scale, bx + 1, by + 2);
            c.closePath();
          }, color, { sd: 1.4, lw: 1.1 });
          folds(ctx, [
            [bx - 1, by - 1.5, bx - 5 * scale, by - 5.5 * scale, bx - 11 * scale, by - 6 * scale],
            [bx - 1, by, bx - 5 * scale, by - 2.5 * scale, bx - 9 * scale, by - 2.8 * scale],
          ], 'rgba(120,80,20,0.6)', 0.7);
        };
        wing(-2.5, -1, 0.8, shade(gold, -0.35));
        wing(0, 0, 1, '#f2d27a');
      }
      if (skin.plume === false) return;
      const plume = skin.plume || shade(color, 0.05);
      // crest plume sweeping back, in the player's colour
      const sway = Math.sin(q.time / 240) * 1.2 + (q.moving ? -1.8 : 0);
      cel(ctx, (c) => {
        c.moveTo(hx + 2.4, hy - hr - 0.5);
        c.quadraticCurveTo(hx - 1, hy - hr - 6.5, hx - hr - 4 + sway, hy - hr - 2.5);
        c.quadraticCurveTo(hx - hr - 1 + sway * 0.5, hy - hr + 1, hx - hr - 6 + sway, hy - 1);
        c.quadraticCurveTo(hx - 4, hy - hr - 1, hx - 1.2, hy - hr + 0.2);
        c.closePath();
      }, plume, { sd: 1.6 });
      // 羽饰的发丝
      folds(ctx, [
        [hx + 0.5, hy - hr - 2.5, hx - 4, hy - hr - 4, hx - hr - 2 + sway, hy - hr - 1.5],
        [hx - 1, hy - hr - 0.8, hx - 5, hy - hr - 1, hx - hr - 3.5 + sway, hy - 2],
      ], shade(plume, -0.35), 0.7);
      glint(ctx, hx - 2.5, hy - 5, 3, 'rgba(255,255,255,0.55)');
    },
    weaponBehindHand: true,
    weapon(ctx, q, B, h) {
      // broad sword along the forearm（技能动作里剑的角度单独给）
      if (act) knightTrail(ctx, act, B, 'tip');
      const a = act ? act.blade : h.a;
      const dx = Math.sin(a);
      const dy = Math.cos(a);
      const L = sword.L;
      const width = sword.width;
      const tipX = h.x + dx * L;
      const tipY = h.y + dy * L;
      const nx = dy;
      const ny = -dx;
      cel(ctx, (c) => pPoly(c, [
        h.x + nx * width, h.y + ny * width, tipX + nx * width * 0.74 - dx * 2.6, tipY + ny * width * 0.74 - dy * 2.6,
        tipX, tipY, tipX - nx * width * 0.74 - dx * 2.6, tipY - ny * width * 0.74 - dy * 2.6, h.x - nx * width, h.y - ny * width,
      ]), sword.blade, { dark: sword.dark, lit: sword.lit, sd: 1, hl: 0.8, lw: 1.3 });
      line(ctx, [h.x + dx * 2, h.y + dy * 2, tipX - dx * 4, tipY - dy * 4], 'rgba(120,140,170,0.6)', 0.7);
      if (sword.edge) {
        // 渴血之刃、炎魔巨剑：刃口一道发光的细线
        line(ctx, [h.x + dx * 3 + nx * width * 0.8, h.y + dy * 3 + ny * width * 0.8, tipX - dx * 2.4 + nx * width * 0.6, tipY - dy * 2.4 + ny * width * 0.6], sword.edge, 0.8);
        line(ctx, [h.x + dx * 3 - nx * width * 0.8, h.y + dy * 3 - ny * width * 0.8, tipX - dx * 2.4 - nx * width * 0.6, tipY - dy * 2.4 - ny * width * 0.6], sword.edge, 0.8);
      }
      if (q.gear === 'flame_greatsword') {
        // 炎魔巨剑：剑身上几道熔岩裂纹，剑尖冒一小簇火
        line(ctx, [h.x + dx * 7, h.y + dy * 7, h.x + dx * 9 + nx * 1.2, h.y + dy * 9 + ny * 1.2, h.x + dx * 12 - nx * 0.6, h.y + dy * 12 - ny * 0.6, h.x + dx * 15 + nx * 0.8, h.y + dy * 15 + ny * 0.8], '#ffb050', 0.6);
        flame(ctx, tipX - dx * 2, tipY - dy * 2, 1.1, q.time, 7);
      }
      // crossguard and pommel（巨剑的护手更宽）
      const guard = sword.guard || gold;
      const guardWidth = 4.2 + (width - 1.9) * 2;
      inkLine(ctx, [h.x - nx * guardWidth + dx * 0.6, h.y - ny * guardWidth + dy * 0.6, h.x + nx * guardWidth + dx * 0.6, h.y + ny * guardWidth + dy * 0.6], guard, 1.8);
      flat(ctx, (c) => pEll(c, h.x - dx * 3.4, h.y - dy * 3.4, 1.5, 1.5), guard, 1);
      // 护手中央的宝石，剑身上一道高光
      flat(ctx, (c) => pEll(c, h.x + dx * 0.6, h.y + dy * 0.6, 0.9, 0.9), sword.gem);
      glint(ctx, h.x + dx * 0.6, h.y + dy * 0.6, 1.8, 'rgba(255,90,60,0.7)');
      line(ctx, [h.x + dx * 5 + nx * 0.6, h.y + dy * 5 + ny * 0.6, h.x + dx * 11 + nx * 0.6, h.y + dy * 11 + ny * 0.6], sword.edge ? 'rgba(255,200,180,0.5)' : 'rgba(255,255,255,0.85)', 0.6);
      knightBladeFx(ctx, q, act, { x: h.x, y: h.y, dx, dy, nx, ny, L });
      if (q.ph && q.ph.strike > 0 && q.ph.back < 0.4) {
        // a crisp crescent trailing the blade: thick at the edge, tapering
        // to nothing behind it, shrinking into the blade on the follow-through
        const cur = lerp(KNIGHT_WOUND, KNIGHT_STRUCK, q.ph.strike);
        const span = -Math.min(KNIGHT_WOUND - cur, 2) * (q.ph.back > 0 ? 1 - q.ph.back / 0.4 : 1);
        const cx = B.sw - 2.5;
        const cy = B.sy + 2;
        const at = (a, r) => [cx + Math.sin(a) * r, cy + Math.cos(a) * r];
        const N = 14;
        ctx.save();
        ctx.globalAlpha *= 0.8;
        ctx.beginPath();
        for (let i = 0; i <= N; i++) {
          const [x, y] = at(cur - span * (1 - i / N), 29);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        for (let i = N; i >= 0; i--) {
          const t = i / N;
          const [x, y] = at(cur - span * (1 - t), 29 - 7 * t * t);
          ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(255,236,170,0.7)';
        ctx.fill();
        ctx.beginPath();
        for (let i = N / 2; i <= N; i++) {
          const [x, y] = at(cur - span * (1 - i / N), 28.6);
          i > N / 2 ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.3;
        ctx.stroke();
        ctx.restore();
      }
    },
  });
}

/* ------------------------------ ranger ------------------------------ */
// 远程职业游侠：玩家颜色的兜帽和短披风，皮甲、亚麻袖子，背上斜挎箭袋，
// 近侧手（朝向我们的那只）握一把反曲长弓。动作见 knightActions.ts 里 "ranger:" 开头的那些。

const RANGER_ARROW = 22;    // 箭长
const RANGER_IDLE_AIM = 1.15;
const LEATHER = '#7b5434';

// 游侠的皮肤：同一套骨骼和动作，只换配色和部件。hood 不写就用玩家颜色（woodland）。
//   mask 蒙面的围巾、fur 兜帽和披肩边上的毛、eyeGlow 眼里的光
const RANGER_SKINS = {
  woodland: { leather: LEATHER, sleeve: '#cdbb8e', forearm: '#6a4428', legs: '#4d4232', boots: '#3a2616', quiver: '#5e3a1e', hair: '#6a3f22' },
  nightshade: {
    hood: '#4a3a66', leather: '#2e2a36', sleeve: '#4a4258', forearm: '#24202c', legs: '#25222c', boots: '#17151c',
    quiver: '#2a2230', hair: '#1c1824', mask: '#2a2236', eyeGlow: '#c89aff',
  },
  snowfield: {
    hood: '#dfe6ec', leather: '#8a6a4a', sleeve: '#b8c8d6', forearm: '#6a5040', legs: '#5a5650', boots: '#4a3a2c',
    quiver: '#7a5a3c', hair: '#c8a070', fur: '#f6f4ef',
  },
  // 守墓人（首次通关亡者地穴解锁）：灰青的兜帽和面罩，骨白镶边，面罩后一对灵火般的眼睛，白发
  gravewarden: {
    hood: '#3a4a4e', leather: '#3a3430', sleeve: '#4a5458', forearm: '#2a2a2e', legs: '#2a2c30', boots: '#1a1a1e',
    quiver: '#2a2a30', hair: '#d8d0c0', mask: '#2e3a3e', eyeGlow: '#7fe8ff', fur: '#e8e0c8',
  },
};

// 游侠的弓（装备的武器外观 gear）：wood 弓身、tip 弓梢、grip 握把、length 弓臂长、bulge 往前鼓多少、
// tassel 弓梢挂的羽毛穗、crystal 弓梢的冰晶
const RANGER_BOWS = {
  default: { wood: '#8a5a2e', tip: '#efe6cc', grip: '#3c2412', length: 13, bulge: 4.6 },
  hunter_bow: { wood: '#a87a48', tip: '#d8c8a0', grip: '#5a3a1e', length: 12, bulge: 3.2 },
  wind_bow: { wood: '#dfe8cf', tip: '#7fe0c8', grip: '#2f6a5a', length: 14, bulge: 4.2, tassel: '#7fe0c8' },
  frost_bow: { wood: '#9fd8f0', tip: '#eef9ff', grip: '#3a6a8a', length: 13.5, bulge: 4.8, crystal: true },
};

// rangerArms 返回 [远侧, 近侧] 手臂角度：技能动作给的，或站立 / 走路时把弓斜提在身前。
function rangerArms(q, g) {
  if (q.act) return [q.act.far, q.act.near];
  if (q.dead >= 0) return g.arms;
  const sw = q.moving ? Math.sin(q.walk || 0) * 0.1 : g.breathe * 0.03;
  return [g.arms[0], [0.5 - sw, 0.5]];
}

// farHand 是远侧手在模型坐标（上半身已旋转）里的位置，和 humanoid 里的算法一样。
function farHand(B, arm) {
  return joint(-B.sw + 2.5, B.sy + 2, arm[0], 7.2, arm[0] + arm[1], 6.8);
}

// furTrim 沿折线 pts 画一道蓬松的毛边（雪原猎人的兜帽和披肩边）：先描一道粗的带墨线的白条，
// 再沿着它点一串不描边的毛团，让边缘起伏。
function furTrim(ctx, pts, color) {
  inkLine(ctx, pts, color, 2.6);
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const [ax, ay, bx, by] = [pts[i], pts[i + 1], pts[i + 2], pts[i + 3]];
    const n = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) / 2.4));
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      flat(ctx, (c) => pEll(c, x, y, 1.5, 1.5), j % 2 ? color : shade(color, -0.06));
    }
  }
}

function drawRanger(ctx, q) {
  // 没有专属动作的攻击（比如别的代码路径触发的普通攻击）也按射击来画
  const name = q.action || (q.attack >= 0 ? 'ranger:arrow' : '');
  const act = q.dead >= 0 ? null : actionPose(name, q.attack);
  if (act) q = { ...q, ph: null, act };
  ctx.save();
  if (act) {
    const shake = act.jitter ? Math.sin(q.time * 0.09) * act.jitter * 0.7 : 0;
    ctx.translate(shake, -act.lift);
    if (act.tumble) {
      // 翻滚：绕抱成一团的身体中心往前转
      // 倒过来时头离地最远，整团往上抬一点，不让头扎进地里
      const pivotY = -13 - Math.sin(act.tumble / 2) * 3;
      ctx.translate(0, pivotY);
      ctx.rotate(act.tumble);
      ctx.translate(0, -pivotY);
    }
  }
  drawRangerBody(ctx, q);
  ctx.restore();
}

function drawRangerBody(ctx, q) {
  const skin = RANGER_SKINS[q.skin] || RANGER_SKINS.woodland;
  const color = skin.hood || safeColor(q.color, '#8fd17a');
  const hood = shade(color, -0.28);
  const leather = skin.leather;
  const act = q.act;
  const kind = act ? act.name.slice(7) : '';   // 去掉 "ranger:"
  humanoid(ctx, q, {
    legs: skin.legs, boots: skin.boots, body: leather, sleeve: skin.sleeve, forearm: skin.forearm, hand: '#e0b48c',
    skin: '#ecc39c', shoulder: 9, waist: 5.6, headR: 7.1, stride: 0.66,
    lean: (q) => (act ? act.lean + (act.jitter ? Math.sin(q.time * 0.07) * act.jitter * 0.03 : 0) : 0),
    arms: rangerArms,
    adjust: knightStance,
    back(ctx, q, B) {
      // 箭袋：从近侧肩斜挎到远侧胯后面，口朝上，露出一把箭羽
      const qx = -B.sw - 0.5;
      const qy = B.sy + 1;
      ctx.save();
      ctx.translate(qx, qy);
      ctx.rotate(-0.42);
      for (const [x, col] of [[-1.6, '#e8e0c8'], [0, '#c8402c'], [1.6, '#e8e0c8'], [0.8, '#2f6a3a']] as [number, string][]) {
        inkLine(ctx, [x, 0, x + 0.3, -5.5], '#9a7a50', 0.9);
        flat(ctx, (c) => pPoly(c, [x - 1, -4, x + 0.3, -8.4, x + 1.5, -4]), col, 0.9);
      }
      cel(ctx, (c) => pRrect(c, -3, -1.5, 6, 15, 2), skin.quiver, { sd: 1.4 });
      line(ctx, [-3, 1.5, 3, 1.5], '#c79a4a', 1);
      line(ctx, [-3, 10.5, 3, 10.5], '#c79a4a', 1);
      ctx.restore();
      // 短披风：在身后飘，下摆剪成叶子的形状
      const sway = Math.sin(q.time / 210 + (q.walk || 0)) * 1.8;
      const flare = act && (act.tumble > 0 || kind === 'haste');
      const run = q.moving || flare ? 6 : 0;
      cel(ctx, (c) => {
        c.moveTo(-B.sw + 2, B.sy - 1);
        c.quadraticCurveTo(-B.sw - 5 - run, B.sy + 6, -B.sw - 6 - run - sway, B.sy + 13);
        c.lineTo(-B.sw - 3 - run * 0.7 - sway * 0.6, B.sy + 11);
        c.lineTo(-B.sw - 2.5 - run * 0.5 - sway * 0.5, B.sy + 15);
        c.lineTo(-B.sw + 0.5 - run * 0.3, B.sy + 12);
        c.lineTo(-B.sw + 2 - run * 0.2, B.sy + 15.5);
        c.quadraticCurveTo(-1, B.sy + 9, B.sw - 4, B.sy + 1);
        c.closePath();
      }, hood, { dark: shade(color, -0.55), lit: shade(color, -0.08), sd: 2.6 });
      folds(ctx, [[-B.sw, B.sy + 3, -B.sw - 3 - run * 0.5, B.sy + 8, -B.sw - 4 - run * 0.8 - sway, B.sy + 12]], 'rgba(10,20,6,0.45)', 0.8);
    },
    torsoDetail(ctx, q, B) {
      // 皮甲的缝线、箭袋的斜挎带、腰带和小皮囊
      folds(ctx, [[0.5, B.sy + 3, 0.8, B.hipY - 2]], 'rgba(40,20,8,0.55)', 0.8);
      ctx.save();
      ctx.setLineDash([0.8, 1.2]);
      line(ctx, [-B.ww + 1, B.sy + 5, -B.ww + 1.4, B.hipY - 2.5], 'rgba(240,210,160,0.55)', 0.5);
      ctx.restore();
      inkLine(ctx, [B.sw - 3, B.sy + 0.5, -B.ww + 0.5, B.hipY - 2], '#4a2c16', 1.6);
      flat(ctx, (c) => pRrect(c, -1.4, B.sy + 6, 2.6, 2.2, 0.6), '#c79a4a', 0.9);
      // 皮甲下摆
      cel(ctx, (c) => pPoly(c, [-B.ww - 0.5, B.hipY - 1, B.ww + 0.5, B.hipY - 1, B.ww + 2.2, B.hipY + 5, 1, B.hipY + 4, -B.ww - 1.8, B.hipY + 5.4]), shade(leather, -0.1), { sd: 1.4 });
      flat(ctx, (c) => pRrect(c, -B.ww - 0.8, B.hipY - 2.6, B.ww * 2 + 1.6, 2.8, 1), '#3c2412', 1.1);
      flat(ctx, (c) => pRrect(c, -0.8, B.hipY - 2.9, 2.6, 3.4, 0.7), '#c79a4a', 1);
      cel(ctx, (c) => pRrect(c, B.ww - 1.2, B.hipY - 1.2, 3.6, 4, 1.2), skin.quiver, { sd: 1, lw: 1.1 });
      // 兜帽连着的披肩：盖住两肩，边上剪成叶尖
      cel(ctx, (c) => {
        c.moveTo(-B.sw - 0.5, B.sy + 1);
        c.quadraticCurveTo(0, B.sy - 3.4, B.sw + 1, B.sy + 0.5);
        c.lineTo(B.sw + 1.6, B.sy + 4.5);
        c.lineTo(B.sw - 1.2, B.sy + 3.6);
        c.lineTo(B.sw - 2.6, B.sy + 6.6);
        c.lineTo(B.sw - 4.6, B.sy + 4);
        c.lineTo(B.sw - 7, B.sy + 7);
        c.lineTo(B.sw - 8.6, B.sy + 4);
        c.lineTo(-B.sw + 2, B.sy + 6);
        c.lineTo(-B.sw + 0.5, B.sy + 3.6);
        c.closePath();
      }, color, { dark: shade(color, -0.4), sd: 1.8 });
      line(ctx, [B.sw - 1.2, B.sy + 3.6, B.sw - 2.6, B.sy + 6.6, B.sw - 4.6, B.sy + 4, B.sw - 7, B.sy + 7], shade(color, 0.35), 0.6);
      if (skin.fur) furTrim(ctx, [B.sw + 1.4, B.sy + 4.2, B.sw - 2.6, B.sy + 6.4, B.sw - 7, B.sy + 6.6, -B.sw + 2, B.sy + 5.8], skin.fur);
    },
    head(ctx, q, B) {
      const { hx, hy, hr } = B;
      // 额前一绺头发、眼睛；鹰眼专注时眼里闪金光
      flat(ctx, (c) => pPoly(c, [hx - 1, hy - 4, hx + hr - 0.5, hy - 3.6, hx + 4.5, hy - 1.6, hx + 2.2, hy - 2.6, hx + 0.6, hy - 1]), skin.hair, 0.9);
      eyes(ctx, hx + 2.8, hy + 1, '#16101c', 1.6);
      flat(ctx, (c) => pPoly(c, [hx + 1.4, hy - 1.4, hx + 4.4, hy - 1.8, hx + 4.2, hy - 1.2]), shade(skin.hair, -0.3));
      if (skin.eyeGlow) flat(ctx, (c) => { pEll(c, hx + 3.1, hy + 0.6, 0.5, 0.6); pEll(c, hx + 6.8, hy + 0.6, 0.45, 0.55); }, skin.eyeGlow);
      if (skin.mask) {
        // 夜影猎手：围巾蒙住口鼻，在脑后打个结
        cel(ctx, (c) => {
          c.moveTo(hx - 1.5, hy + 2.2);
          c.lineTo(hx + hr + 0.8, hy + 2.4);
          c.quadraticCurveTo(hx + hr + 0.4, hy + hr - 0.5, hx + 3, hy + hr + 0.6);
          c.lineTo(hx - 2.4, hy + hr);
          c.closePath();
        }, skin.mask, { sd: 1.2 });
        folds(ctx, [[hx, hy + 4.2, hx + 3.5, hy + 4.6, hx + hr, hy + 4.2]], 'rgba(0,0,0,0.45)', 0.6);
      }
      if (kind === 'focus') {
        const eye = envelope(act.k, 0.2, 0.32, 0.7, 0.9);
        if (eye > 0) {
          flat(ctx, (c) => pEll(c, hx + 6.6, hy + 1, 1.1, 1.6), '#ffe27a');
          sparkle(ctx, hx + 6.8, hy + 0.6, 4.5 * eye, '#fff6c8');
        }
      }
      // 兜帽：罩住头顶和后脑，帽尖垂在脑后
      const sway = Math.sin(q.time / 260) * 0.8 + (q.moving ? -1.2 : 0);
      cel(ctx, (c) => {
        c.moveTo(hx + hr + 0.4, hy - 0.8);
        c.quadraticCurveTo(hx + hr + 0.6, hy - hr - 2.2, hx - 0.5, hy - hr - 1.4);
        c.quadraticCurveTo(hx - hr - 3, hy - hr + 0.5, hx - hr - 5 + sway, hy - 1.5);
        c.lineTo(hx - hr - 1.5 + sway * 0.4, hy + 0.2);
        c.quadraticCurveTo(hx - hr - 1.6, hy + 4, hx - hr + 0.4, hy + 6.5);
        c.lineTo(hx - 2.8, hy + 6.2);
        c.quadraticCurveTo(hx - 1, hy + 1, hx - 0.6, hy - 2.6);
        c.quadraticCurveTo(hx + 3, hy - hr + 0.6, hx + hr - 1.2, hy - 1.6);
        c.closePath();
      }, color, { dark: shade(color, -0.42), sd: 2 });
      folds(ctx, [[hx + 1, hy - hr - 0.6, hx - 3, hy - hr - 0.2, hx - hr - 3 + sway, hy - 1.2]], shade(color, -0.45), 0.7);
      line(ctx, [hx + hr - 1, hy - 1.4, hx - 0.4, hy - 2.4], shade(color, 0.3), 0.6);
      // 雪原猎人：兜帽沿着脸一圈白毛
      if (skin.fur) furTrim(ctx, [hx + hr + 0.4, hy - 1, hx + 3, hy - hr + 0.4, hx - 0.6, hy - 2.6, hx - 1, hy + 2, hx - 2.6, hy + 6], skin.fur);
    },
    weaponBehindHand: true,
    weapon(ctx, q, B, h) {
      drawBow(ctx, q, B, h, act, kind);
    },
  });
}

// drawBow 画近侧手里的弓、弦、搭在弦上的箭和拉弦的手指。弓身和箭的方向 aim 垂直。
function drawBow(ctx, q, B, h, act, kind) {
  const look = RANGER_BOWS[q.gear] || RANGER_BOWS.default;
  const aim = act ? act.aim : q.dead >= 0 ? h.a + 0.6 : RANGER_IDLE_AIM;
  const draw = act ? act.draw : 0;
  const dx = Math.sin(aim);
  const dy = Math.cos(aim);
  // 弓梢方向：aim 水平向前时朝正上方
  const ux = dy;
  const uy = -dx;
  const at = (along, side) => [h.x + ux * along + dx * side, h.y + uy * along + dy * side];
  const back = -draw * 2.6;   // 拉满时弓梢往后弯
  const [tx, ty] = at(look.length, back - 0.6);
  const [bx, by] = at(-look.length, back - 0.6);
  const [c1x, c1y] = at(look.length * 0.58, look.bulge + draw * 0.8);
  const [c2x, c2y] = at(-look.length * 0.58, look.bulge + draw * 0.8);
  const [gx, gy] = at(0, 1.4);
  // 弦：搭箭时拉到远侧手，否则绷直；刚松手时弦还在抖
  let nock = null;
  if (act && act.nocked) {
    const hand = farHand(B, act.far);
    nock = [hand.ex, hand.ey];
  }
  const pluck = act && act.release > 0 && act.k >= act.release ? Math.max(0, 1 - (act.k - act.release) * 7) : 0;
  const mid = nock || (() => {
    const wobble = pluck * Math.sin(q.time * 0.6) * 1.6;
    return [(tx + bx) / 2 + dx * wobble, (ty + by) / 2 + dy * wobble];
  })();
  line(ctx, [tx, ty, mid[0], mid[1], bx, by], 'rgba(238,232,210,0.95)', 0.7);

  // 搭在弦上的箭
  if (nock) {
    const [nx, ny] = nock;
    const ex = nx + dx * RANGER_ARROW;
    const ey = ny + dy * RANGER_ARROW;
    inkLine(ctx, [nx, ny, ex - dx * 2, ey - dy * 2], '#c9a46a', 1.1);
    // 箭羽
    for (const side of [-1, 1]) {
      flat(ctx, (c) => pPoly(c, [nx + dx * 0.5, ny + dy * 0.5, nx + dx * 4.5, ny + dy * 4.5,
        nx + dx * 1.5 + ux * side * 2, ny + dy * 1.5 + uy * side * 2]), side > 0 ? '#c8402c' : '#efe6cc', 0.8);
    }
    const head = kind === 'frostarrow' ? '#bfeaff' : kind === 'pierce' ? '#fff3c4' : '#d6dde6';
    const P = (f, s) => [ex + dx * f + ux * s, ey + dy * f + uy * s];
    if (kind === 'pierce') {
      // 憋住的那一下箭头越来越亮，箭身上缠一圈金光
      const charge = clamp01((act.k - 0.2) / 0.4);
      flat(ctx, (c) => pPoly(c, [...P(-4, 2.8 + charge * 1.4), ...P(4 + charge * 2, 0), ...P(-4, -2.8 - charge * 1.4), ...P(-2, 0)]), '#ffd45a', 0.9);
      glint(ctx, ex + dx * 1, ey + dy * 1, 6 + charge * 6, 'rgba(255,220,120,0.7)', charge);
      line(ctx, [nx + dx * 6, ny + dy * 6, ex - dx * 3, ey - dy * 3], `rgba(255,240,180,${0.8 * charge})`, 0.6);
    }
    if (kind === 'frostarrow') {
      // 冰晶包住箭头
      flat(ctx, (c) => pPoly(c, [...P(-5, 2.6), ...P(-1, 3.6), ...P(3.5, 0), ...P(-1, -3.6), ...P(-5, -2.6)]), '#8fd8ff', 0.9);
      glint(ctx, ex, ey, 6, 'rgba(160,230,255,0.6)');
    }
    flat(ctx, (c) => pPoly(c, [...P(-3, 1.8), ...P(2.4, 0), ...P(-3, -1.8), ...P(-1.6, 0)]), head, 1);
    // 拉弦的两根手指
    flat(ctx, (c) => { pEll(c, nx + 0.3, ny - 0.9, 1.5, 1.1); pEll(c, nx + 0.3, ny + 1, 1.5, 1.1); }, '#d8a880', 1);
  }

  // 弓身：两段往前鼓、弓梢往回翘的反曲弓，握把缠着皮
  const bow = (c) => {
    c.moveTo(tx, ty);
    c.quadraticCurveTo(c1x, c1y, gx, gy);
    c.quadraticCurveTo(c2x, c2y, bx, by);
  };
  ctx.lineCap = 'round';
  ctx.beginPath(); bow(ctx);
  ctx.strokeStyle = OUTLINE; ctx.lineWidth = 3.8; ctx.stroke();
  ctx.beginPath(); bow(ctx);
  ctx.strokeStyle = look.wood; ctx.lineWidth = 2.1; ctx.stroke();
  ctx.beginPath(); bow(ctx);
  ctx.strokeStyle = 'rgba(255,220,160,0.45)'; ctx.lineWidth = 0.6; ctx.stroke();
  // 弓梢的骨片
  flat(ctx, (c) => { pEll(c, tx, ty, 1.2, 1.2); pEll(c, bx, by, 1.2, 1.2); }, look.tip, 0.9);
  inkLine(ctx, [...at(-2.2, 1.3), ...at(2.2, 1.3)], look.grip, 2.4);
  if (look.tassel) {
    // 风语长弓：两头弓梢各挂一串羽毛穗，随风飘
    for (const [px, py] of [[tx, ty], [bx, by]]) {
      const sway = Math.sin(q.time / 180 + px) * 1.2;
      flat(ctx, (c) => pPoly(c, [px, py, px - 2.4 + sway, py + 3.4, px - 0.6 + sway, py + 5.6, px + 0.8, py + 2.4]), look.tassel, 0.8);
    }
  }
  if (look.crystal) {
    // 霜心长弓：弓梢和握把上长着冰晶
    for (const [px, py, size] of [[tx, ty, 1], [bx, by, 1], [...at(0, -0.6), 0.7]] as [number, number, number][]) {
      flat(ctx, (c) => pPoly(c, [px, py - 3 * size, px + 1.5 * size, py, px, py + 2.4 * size, px - 1.5 * size, py]), '#d8f4ff', 0.8);
    }
    line(ctx, [...at(look.length * 0.3, look.bulge * 0.7), ...at(-look.length * 0.3, look.bulge * 0.7)], 'rgba(220,250,255,0.8)', 0.5);
  }

  // 治愈之泉：举起的弓臂间聚起一团绿光，跪下时顺着下弓梢落进地里
  if (kind === 'zone') {
    const orb = envelope(act.k, 0.12, 0.3, 0.5, 0.6);
    if (orb > 0) {
      const [ox, oy] = at(0, 5);
      flat(ctx, (c) => pEll(c, ox, oy, 2.8 * orb, 2.8 * orb), '#a8ffb8', 0.8);
      sparkle(ctx, ox, oy, 6 * orb, '#e8fff0');
    }
    const land = envelope(act.k, 0.54, 0.58, 0.66, 0.84);
    if (land > 0) sparkle(ctx, bx, by, 7 * land, '#c8ffd4');
  }
}

/* ------------------------------ guard ------------------------------- */
// A hoplite: crested bronze helm, big round aspis, spear thrust from the
// shoulder.

function drawGuard(ctx, q) {
  const color = safeColor(q.color, '#3b82f6');
  const bronze = '#c8913e';
  const crest = '#b8282a';
  const ph = q.ph;
  // spear: drawn back with the tip raised during the wind-up, then a hard
  // straight thrust with the arm locked out
  const tilt = q.dead >= 0 ? lerp(PI / 2, PI * 0.97, q.dead) : PI / 2 + arc3(ph, 0, 0.22, -0.04);
  humanoid(ctx, q, {
    legs: '#d9b98a', boots: '#5a3a22', body: bronze, sleeve: color, skin: '#d9a77a',
    shoulder: 9, waist: 6.2, headR: 7,
    stride: 0.5,
    lean: () => (ph ? arc3(ph, 0, -0.12, 0.2) : 0),
    arms(q, g) {
      if (q.dead >= 0) return g.arms;
      return [[0.9, -0.9], [arc3(ph, 1.2, 0.5, 1.7), arc3(ph, -1.05, -1.8, -0.1)]];
    },
    back(ctx, q, B) {
      // short red cloak
      cel(ctx, (c) => {
        c.moveTo(-B.sw + 1, B.sy);
        c.quadraticCurveTo(-B.sw - 5, B.sy + 9, -B.sw - 3, B.hipY + 6);
        c.lineTo(-1, B.hipY + 4);
        c.lineTo(B.sw - 3, B.sy + 1);
        c.closePath();
      }, crest, { sd: 2.4 });
      folds(ctx, [[-B.sw - 0.5, B.sy + 3, -B.sw - 3, B.sy + 9, -B.sw - 2, B.hipY + 4]], 'rgba(40,0,10,0.5)', 0.9);
    },
    offhand(ctx, q, B, hand) {
      // aspis: a big bronze round shield with a painted emblem
      const x = hand.x + 1;
      const y = hand.y - 4;
      cel(ctx, (c) => pEll(c, x, y, 10.5, 12.5), bronze, { sd: 2.8 });
      cel(ctx, (c) => pEll(c, x + 0.6, y, 8, 9.8), color, { sd: 2, lw: 1.1 });
      // a gold owl-eye emblem
      ctx.strokeStyle = '#f2d27a';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(x + 0.6, y - 1, 3.2, 0, TAU);
      ctx.moveTo(x - 3.4, y + 4.5);
      ctx.lineTo(x + 0.6, y + 2);
      ctx.lineTo(x + 4.6, y + 4.5);
      ctx.stroke();
      // 盾沿一圈铆钉
      const rv = [];
      for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU; rv.push(x + Math.cos(a) * 9.3, y + Math.sin(a) * 11.2); }
      rivets(ctx, rv, 0.5, '#ffe2a0');
      glint(ctx, x - 4, y - 6, 3.5, 'rgba(255,230,170,0.5)');
    },
    torsoDetail(ctx, q, B) {
      // muscled bronze cuirass lines, pteruges skirt strips
      ctx.strokeStyle = 'rgba(70,40,10,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-4, B.sy + 5); ctx.quadraticCurveTo(-0.5, B.sy + 8, 0.5, B.sy + 5);
      ctx.moveTo(1.5, B.sy + 5); ctx.quadraticCurveTo(3, B.sy + 8, 6, B.sy + 4.6);
      ctx.moveTo(0.5, B.sy + 9); ctx.lineTo(0.5, B.hipY - 1);
      ctx.stroke();
      for (let i = 0; i < 5; i++) {
        const x = -B.ww + 0.4 + i * (B.ww * 2 / 5);
        cel(ctx, (c) => pRrect(c, x, B.hipY - 1, 2.5, 6.5, 0.8), i % 2 ? shade(color, -0.1) : '#e8dcc2', { sd: 0.8, lw: 1 });
      }
    },
    head(ctx, q, B) {
      const { hx, hy, hr } = B;
      eyes(ctx, hx + 3, hy + 0.8, '#16101c', 1.6);
      // Corinthian helm: covers the face but for an eye slit
      cel(ctx, (c) => {
        c.moveTo(hx - hr - 1, hy + 4);
        c.arc(hx, hy - 0.4, hr + 1, PI * 0.95, TAU + 0.1);
        c.lineTo(hx + hr + 0.8, hy + 0.4);
        c.lineTo(hx + 2, hy + 0.4);
        c.lineTo(hx + 1.2, hy + 2.6);
        c.lineTo(hx + hr + 0.4, hy + 3);
        c.lineTo(hx + hr - 1, hy + 7);
        c.lineTo(hx - hr + 1, hy + 7);
        c.closePath();
      }, bronze, { sd: 2 });
      // horsehair crest over the top
      const sway = Math.sin(q.time / 300) * 0.8;
      cel(ctx, (c) => {
        c.moveTo(hx + hr + 1.5, hy - hr + 1);
        c.quadraticCurveTo(hx + 1, hy - hr - 8.5, hx - hr - 3 + sway, hy - hr + 0.5);
        c.quadraticCurveTo(hx - hr - 2 + sway, hy - 1, hx - hr - 4 + sway, hy + 3);
        c.quadraticCurveTo(hx - 2, hy - hr - 1.5, hx + hr - 0.5, hy - hr + 2.5);
        c.closePath();
      }, crest, { sd: 1.8 });
      // 马鬃的发丝、护颊的边线
      folds(ctx, [
        [hx + hr - 1, hy - hr - 1, hx, hy - hr - 6, hx - hr - 1.5 + sway, hy - hr + 0.5],
        [hx + 2, hy - hr - 0.5, hx - 3, hy - hr - 2.5, hx - hr - 2.5 + sway, hy + 1],
      ], 'rgba(60,0,10,0.55)', 0.7);
      folds(ctx, [[hx + hr - 1.2, hy + 3.4, hx + hr - 2.2, hy + 6.4]], 'rgba(70,40,10,0.7)', 0.8);
      glint(ctx, hx - 2, hy - 4.5, 3, 'rgba(255,240,200,0.55)');
    },
    weaponBehindHand: true,
    weapon(ctx, q, B, h) {
      const dx = Math.sin(tilt);
      const dy = Math.cos(tilt);
      // the shaft also slides through the grip for extra reach
      const slide = arc3(ph, 0, -4, 7);
      h = { x: h.x + dx * slide, y: h.y + dy * slide };
      const x0 = h.x - dx * 16;
      const y0 = h.y - dy * 16;
      const x1 = h.x + dx * 20;
      const y1 = h.y + dy * 20;
      inkLine(ctx, [x0, y0, x1, y1], '#8a5a2b', 2);
      // 枪尾的铜尖和握把缠绳
      flat(ctx, (c) => pPoly(c, [x0 + dy * 1.4, y0 - dx * 1.4, x0 - dx * 4, y0 - dy * 4, x0 - dy * 1.4, y0 + dx * 1.4]), bronze, 1);
      folds(ctx, [[h.x - dx * 3 + dy * 1.1, h.y - dy * 3 - dx * 1.1, h.x - dx * 1.8 - dy * 1.1, h.y - dy * 1.8 + dx * 1.1],
        [h.x + dx * 3 + dy * 1.1, h.y + dy * 3 - dx * 1.1, h.x + dx * 4.2 - dy * 1.1, h.y + dy * 4.2 + dx * 1.1]], '#e8dcc2', 0.8);
      // leaf-shaped head
      const nx = dy;
      const ny = -dx;
      const P = (f, n) => [x1 + dx * f + nx * n, y1 + dy * f + ny * n];
      cel(ctx, (c) => pPoly(c, [...P(-1, 2.8), ...P(9.5, 0), ...P(-1, -2.8), ...P(1.2, 0)]), '#e6ecf2', { dark: '#98a4b4', sd: 0.9, lw: 1.2 });
      if (ph && ph.strike > 0.3 && ph.back < 0.5) {
        ctx.save();
        ctx.globalAlpha *= 0.7 * (1 - ph.back * 2);
        line(ctx, [...P(-14, 0), ...P(18, 0)], 'rgba(255,245,210,0.9)', 2.4);
        ctx.restore();
      }
    },
  });
}

/* ----------------------------- villager ----------------------------- */
// A shade of the Asphodel village: wide straw hat, rough tunic, a satchel,
// and a gentle shuffle.

function drawVillager(ctx, q) {
  const color = safeColor(q.color, '#f4c27a');
  const cloth = shade(color, -0.12);
  const t = q.time / 1000;
  humanoid(ctx, q, {
    legs: '#6b5440', boots: '#3e2a1c', body: cloth, skin: '#f0c49a',
    shoulder: 7.6, waist: 6.6, headR: 7.3, stride: 0.45,
    arms(q, g) {
      if (q.moving) return g.arms;
      // idle: one hand on the satchel strap, the other gesturing now and then
      const talk = Math.max(0, Math.sin(t * 0.9)) ** 3;
      return [[0.15, 0.5], [0.35 + talk * 0.9, 0.6 + talk * 0.9]];
    },
    back(ctx, q, B) {
      // satchel on the far hip
      cel(ctx, (c) => pRrect(c, -B.sw - 1.5, B.hipY - 7, 6, 7, 2), '#8a5a32', { sd: 1.6 });
      // 包盖和铜扣
      flat(ctx, (c) => pRrect(c, -B.sw - 1.5, B.hipY - 7, 6, 3, 1.5), '#6a4224', 1);
      flat(ctx, (c) => pEll(c, -B.sw + 1.5, B.hipY - 4.2, 0.8, 0.8), '#e2b04a');
    },
    torsoDetail(ctx, q, B) {
      // rope belt, apron and strap
      cel(ctx, (c) => pPoly(c, [-B.ww + 1, B.sy + 6, B.ww - 0.5, B.sy + 6, B.ww + 1.4, B.hipY + 5, -B.ww + 0.4, B.hipY + 5]), '#efe6d2', { sd: 1.4, lw: 1.1 });
      line(ctx, [-B.ww, B.hipY - 1, B.ww + 0.6, B.hipY - 1.6], '#7a4a24', 1.6);
      line(ctx, [B.sw - 2, B.sy, -B.ww + 0.5, B.hipY - 2], '#6a4022', 1.4);
      // 围裙上的补丁和衣褶
      flat(ctx, (c) => pRrect(c, 0.5, B.hipY - 4.5, 3.2, 3, 0.5), '#c9b896');
      folds(ctx, [[0.8, B.hipY - 4.2, 3.4, B.hipY - 1.8], [-B.ww + 1.5, B.sy + 8, -B.ww + 1, B.hipY + 4], [2.5, B.sy + 9, 3.5, B.hipY + 4]], 'rgba(80,60,40,0.4)', 0.7);
    },
    head(ctx, q, B) {
      const { hx, hy, hr } = B;
      // hair under the hat, eyes, rosy cheek
      flat(ctx, (c) => { c.moveTo(hx - hr, hy + 1); c.arc(hx, hy, hr, PI, PI * 1.8); c.lineTo(hx - 2, hy - 1); c.closePath(); }, '#6a3c1e');
      eyes(ctx, hx + 2.4, hy + 1.2);
      ctx.fillStyle = 'rgba(230,110,110,0.55)';
      ctx.beginPath();
      pEll(ctx, hx + 6, hy + 3.6, 1.6, 1.1);
      ctx.fill();
      // straw hat: wide brim and a red band
      cel(ctx, (c) => pEll(c, hx + 0.5, hy - 4.4, hr + 4.6, 2.8), '#e6c264', { sd: 1.2 });
      cel(ctx, (c) => { c.moveTo(hx - 5.5, hy - 4.6); c.quadraticCurveTo(hx - 5, hy - 11.5, hx + 0.5, hy - 11.5); c.quadraticCurveTo(hx + 6, hy - 11.5, hx + 6.5, hy - 4.6); c.closePath(); }, '#ddb554', { sd: 1.6 });
      line(ctx, [hx - 5.4, hy - 6.4, hx + 6.4, hy - 6.4], '#b8402c', 1.6, 'butt');
      // 帽带上插一朵日光兰
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU;
        flat(ctx, (c) => pEll(c, hx - 4 + Math.cos(a) * 1.2, hy - 7.6 + Math.sin(a) * 1.2, 0.9, 0.9), '#f8f0dc');
      }
      flat(ctx, (c) => pEll(c, hx - 4, hy - 7.6, 0.7, 0.7), '#e09a2a');
      ctx.strokeStyle = 'rgba(120,80,20,0.5)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (let i = -3; i <= 3; i += 2) { ctx.moveTo(hx + i, hy - 10.6); ctx.lineTo(hx + i * 1.3, hy - 7.2); }
      ctx.stroke();
    },
  });
}

/* ------------------------------- slime ------------------------------ */
// A jelly blob: squash and stretch, a darker core with floating bubbles, a
// glossy highlight and drips at the base.

function drawSlime(ctx, q) {
  const color = safeColor(q.color, '#6ccf6c');
  const t = q.time / 1000;
  let hop = 0;
  let sx = 1 + Math.sin(t * 3.2) * 0.05;
  let sy = 1 - Math.sin(t * 3.2) * 0.05;
  let lean = Math.sin(t * 1.6) * 0.04;
  if (q.moving && q.dead < 0) {
    // crouch, leap, land
    const ph = (q.walk || 0) % TAU;
    const air = Math.max(0, Math.sin(ph));
    const land = Math.max(0, -Math.sin(ph));
    hop = air * 9;
    sx = 1 - air * 0.14 + land * 0.2;
    sy = 1 + air * 0.18 - land * 0.18;
    lean = 0.12;
  }
  let lunge = 0;
  const ph = q.ph;
  if (ph) {
    // gather back, then pounce forward with a big stretch
    const gather = ph.strike === 0 ? ph.wind : 1 - ph.strike;
    const pounce = ph.strike * (1 - ph.back);
    lunge = -3 * gather + 12 * pounce;
    sx *= 1 + gather * 0.18 + pounce * 0.3;
    sy *= 1 - gather * 0.2 + pounce * 0.05;
    hop += pounce * 4;
    lean = -0.15 * gather + 0.3 * pounce;
  }
  if (q.hit >= 0) {
    const k = 1 - q.hit;
    sx *= 1 + 0.25 * k * Math.cos(q.hit * 18);
    sy *= 1 - 0.2 * k * Math.cos(q.hit * 18);
  }
  if (q.dead >= 0) {
    // collapse into a puddle
    const d = ease(q.dead);
    sx = 1 + d * 0.8;
    sy = Math.max(0.2, 1 - d * 0.8);
    hop = 0;
    lean = 0;
  }
  const w = 15 * sx;
  const h = 26 * sy;
  ctx.save();
  ctx.translate(lunge, -hop);
  ctx.transform(1, 0, -lean, 1, 0, 0);

  const body = (c) => {
    c.moveTo(-w, 0);
    c.bezierCurveTo(-w * 1.08, -h * 0.55, -w * 0.62, -h, 0, -h);
    c.bezierCurveTo(w * 0.7, -h, w * 1.1, -h * 0.5, w, 0);
    // a wobbly underside with drips
    c.quadraticCurveTo(w * 0.6, 2.4, w * 0.25, 1);
    c.quadraticCurveTo(0, 3, -w * 0.3, 1.2);
    c.quadraticCurveTo(-w * 0.7, 2.6, -w, 0);
    c.closePath();
  };
  ctx.save();
  ctx.globalAlpha *= 0.94;
  cel(ctx, body, color, { dark: shade(color, -0.42), lit: shade(color, 0.45), sd: 4, hl: 1.6 });
  ctx.restore();
  // inner core and bubbles drifting up
  ctx.save();
  ctx.beginPath();
  body(ctx);
  ctx.clip();
  ctx.fillStyle = shade(color, -0.3);
  ctx.globalAlpha *= 0.4;
  ctx.beginPath();
  pEll(ctx, 1.5, -h * 0.35, w * 0.42, h * 0.24);
  ctx.fill();
  ctx.globalAlpha /= 0.4;
  // 肚子里没消化完的小骷髅，随身体一起晃
  if (q.dead < 0) {
    ctx.save();
    ctx.globalAlpha *= 0.35;
    ctx.translate(-w * 0.25, -h * 0.28 + Math.sin(t * 1.3) * 1.2);
    ctx.rotate(0.5 + Math.sin(t * 0.8) * 0.2);
    ctx.fillStyle = shade(color, -0.55);
    ctx.beginPath(); pEll(ctx, 0, 0, 3.2, 2.8); pRrect(ctx, -1.6, 1.6, 3.2, 2, 0.6); ctx.fill();
    ctx.fillStyle = shade(color, 0.1);
    ctx.beginPath(); pEll(ctx, -1, -0.2, 0.8, 0.9); pEll(ctx, 1.1, -0.2, 0.8, 0.9); ctx.fill();
    ctx.restore();
  }
  for (let i = 0; i < 4; i++) {
    const k = (t * 0.35 + i * 0.27) % 1;
    const bx = Math.sin(i * 2.3 + t) * w * 0.4;
    const by = -h * (0.15 + k * 0.65);
    ctx.strokeStyle = `rgba(255,255,255,${0.5 * Math.sin(k * PI)})`;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(bx, by, 1 + i * 0.4, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
  // gloss highlight
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.beginPath();
  pEll(ctx, -w * 0.42, -h * 0.68, w * 0.2, h * 0.08, -0.6);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  pEll(ctx, -w * 0.62, -h * 0.47, 1.3, 1.6);
  ctx.fill();
  // 底部一圈反光（透明果冻贴地的那一圈更亮）
  ctx.strokeStyle = `${shade(color, 0.5)}`;
  ctx.globalAlpha *= 0.6;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-w * 0.8, -1.5);
  ctx.quadraticCurveTo(0, 0.5, w * 0.8, -1.5);
  ctx.stroke();
  ctx.globalAlpha /= 0.6;

  // face
  const fy = -h * 0.48;
  if (q.dead < 0) {
    const angry = !!ph;
    const blink = Math.sin(t * 0.7) > 0.985;
    for (const ex of [w * 0.18, w * 0.58]) {
      ctx.fillStyle = '#142014';
      ctx.beginPath();
      pEll(ctx, ex, fy, 2, blink ? 0.4 : 3);
      ctx.fill();
      if (!blink) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        pEll(ctx, ex + 0.7, fy - 1.2, 0.8, 0.9);
        ctx.fill();
      }
    }
    if (angry) {
      line(ctx, [w * 0.05, fy - 4.6, w * 0.32, fy - 3.2], '#142014', 1.3);
      line(ctx, [w * 0.72, fy - 4.6, w * 0.46, fy - 3.2], '#142014', 1.3);
      flat(ctx, (c) => pEll(c, w * 0.4, fy + 4.5, 3, 2.6), '#3a1020', 1);
      flat(ctx, (c) => pPoly(c, [w * 0.28, fy + 2.6, w * 0.34, fy + 4.2, w * 0.4, fy + 2.6]), '#ffffff');
    } else {
      ctx.strokeStyle = '#142014';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(w * 0.38, fy + 3, 2.2, 0.25, PI - 0.25);
      ctx.stroke();
    }
  } else {
    ctx.strokeStyle = '#142014';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (const ex of [w * 0.18, w * 0.58]) {
      ctx.moveTo(ex - 1.8, fy - 1.8); ctx.lineTo(ex + 1.8, fy + 1.8);
      ctx.moveTo(ex + 1.8, fy - 1.8); ctx.lineTo(ex - 1.8, fy + 1.8);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/* ------------------------------- wolf ------------------------------- */
// A lean hellhound: jointed legs that gallop, a spiky mane, a snapping jaw
// and ember eyes.

// 狼的几种长相：普通灰狼、头狼（颈毛 + 额头白斑 + 一道伤疤）、灰鬃狼王（大圈银色鬃毛、
// 背上一排高鬃、身上三道爪痕、撕裂的耳朵、颈上一串狼牙、冰蓝色的眼睛）。体型由碰撞半径决定。
interface WolfStyle { ruff: number; ridge: number; blaze: boolean; scars: number; tornEar: boolean; fangs: boolean; eye: string; rage: string; vein: [number, number, number] }
const WOLF_STYLES: Record<string, WolfStyle> = {
  wolf: { ruff: 0, ridge: 1, blaze: false, scars: 0, tornEar: false, fangs: false, eye: '#ffb02a', rage: '#ff3b20', vein: [255, 90, 20] },
  alpha_wolf: { ruff: 0.65, ridge: 1.25, blaze: true, scars: 1, tornEar: false, fangs: false, eye: '#ffd24a', rage: '#ff3b20', vein: [255, 90, 20] },
  wolf_king: { ruff: 1, ridge: 1.7, blaze: false, scars: 3, tornEar: true, fangs: true, eye: '#9fe8ff', rage: '#ff4a3a', vein: [80, 190, 255] },
};

function drawWolf(ctx, q, style: WolfStyle = WOLF_STYLES.wolf) {
  const color = safeColor(q.color, '#9a9a9a');
  const dark = shade(color, -0.4);
  const light = shade(color, 0.35);
  const t = q.time / 1000;
  const moving = q.moving && q.dead < 0;
  const ph = q.walk || 0;
  const ap = q.ph;
  let lunge = 0;
  let jaw = 0.08;
  let crouch = 0;
  let bite = 0;
  if (ap) {
    crouch = ap.strike === 0 ? ap.wind : 1 - ap.strike;
    bite = ap.strike * (1 - ap.back);
    lunge = -3 * crouch + 11 * bite;
    jaw = 0.1 + crouch * 0.6 + (ap.strike > 0 && ap.strike < 1 ? 0.2 : 0) - bite * 0.5;
  }
  const deadK = q.dead >= 0 ? ease(q.dead) : 0;
  const bob = moving ? Math.sin(ph * 2) * 1.6 : Math.sin(t * 2) * 0.5;
  const by = -16 - bob + crouch * 3 + deadK * 9;        // body line
  const pitch = moving ? Math.sin(ph) * 0.06 : 0;

  ctx.save();
  // the whole wolf springs forward on the bite
  ctx.translate(lunge * 0.6, 0);
  if (q.dead >= 0) {
    // roll onto the side: flatten and tip
    ctx.translate(0, -deadK * 2);
    ctx.rotate(-0.12 * deadK);
  }

  // leg: thigh then a backward-bent lower leg and paw; front legs bend the
  // other way
  const leg = (x, a, rear, color, w) => {
    const knee = rear ? -0.6 - Math.max(0, Math.cos(a * 3)) * 0.2 : 0.35;
    const j = joint(x, by + 3, a, 7, a + (rear ? 0.9 : -0.3) + knee * 0.3, 7);
    cel(ctx, (c) => pTaper(c, x, by + 2, j.kx, j.ky, w + 1.2, w * 0.8), color, { sd: 1.2, lw: 1.3 });
    cel(ctx, (c) => pTaper(c, j.kx, j.ky, j.ex, j.ey, w * 0.8, w * 0.65), color, { sd: 1, lw: 1.3 });
    flat(ctx, (c) => pEll(c, j.ex + 1.6, j.ey - 0.6, 2.6, 1.6), shade(color, -0.1), 1.2);
    // 爪子
    line(ctx, [j.ex + 3.4, j.ey - 0.4, j.ex + 4.6, j.ey + 0.6, j.ex + 2.6, j.ey + 0.2, j.ex + 3.6, j.ey + 1.2], '#e8e0cc', 0.6);
  };
  const g = moving ? Math.sin(ph) : 0;
  const gl = moving ? 0.7 : 0;
  const deadLegs = q.dead >= 0 ? 1 - deadK : 1;
  // pounce: rear legs drive back, front legs reach for the target
  const rearK = 0.2 * crouch - 0.55 * bite;
  const frontK = -0.25 * crouch + 0.85 * bite;

  // tail: bushy, wagging or streaming back when running
  const wag = moving ? Math.sin(ph * 2) * 0.15 - 0.2 : Math.sin(t * 5.5) * 0.35;
  ctx.save();
  ctx.translate(-13, by - 3);
  ctx.rotate(-0.55 + wag);
  cel(ctx, (c) => {
    c.moveTo(0, -2.6);
    c.quadraticCurveTo(-8, -6, -15, -2);
    c.lineTo(-12, -0.4);
    c.lineTo(-16, 1.6);
    c.quadraticCurveTo(-8, 4.5, 0, 2.6);
    c.closePath();
  }, color, { sd: 1.6 });
  ctx.restore();

  leg(-9, (g * gl + 0.1 + rearK) * deadLegs + deadK * 1.2, true, dark, 2.4);
  leg(9, (-g * gl - 0.1 + frontK) * deadLegs + deadK * 1.1, false, dark, 2.2);

  // body: deep chest, tucked belly, mane ridge along the back
  ctx.save();
  ctx.rotate(pitch);
  cel(ctx, (c) => {
    c.moveTo(-14, by - 2);
    c.quadraticCurveTo(-12, by - 9, -2, by - 8.5);
    c.quadraticCurveTo(8, by - 10, 13, by - 6);
    c.quadraticCurveTo(15, by + 2, 9, by + 6);
    c.quadraticCurveTo(0, by + 3, -6, by + 4.5);
    c.quadraticCurveTo(-14, by + 4, -14, by - 2);
    c.closePath();
  }, color, { sd: 3 });
  // belly fur and mane spikes
  flat(ctx, (c) => { c.moveTo(-6, by + 3.6); c.quadraticCurveTo(2, by + 1.2, 9, by + 5.4); c.quadraticCurveTo(2, by + 5.2, -6, by + 3.6); c.closePath(); }, light);
  const ridge = style.ridge;
  const ridgeColor = style.ruff >= 1 ? shade(color, 0.25) : dark;
  cel(ctx, (c) => {
    c.moveTo(-8, by - 7.5);
    for (let i = 0; i < 5; i++) {
      const x = -8 + i * 4.4;
      const tall = (4.6 + (i === 3 ? 2 : 0) + i * 0.3 * (ridge - 1)) * ridge;
      c.lineTo(x + 1.6, by - 8 - tall + Math.sin(t * 3 + i) * 0.4 * ridge);
      c.lineTo(x + 4.4, by - 8.6 - i * 0.3);
    }
    c.lineTo(12, by - 6);
    c.closePath();
  }, ridgeColor, { sd: 1.4, lw: 1.3 });
  // 身上的旧爪痕（头狼一道，狼王三道）：浅色的疤，两边一圈暗色
  for (let i = 0; i < style.scars; i++) {
    const sx = -7 + i * 3.2;
    line(ctx, [sx, by - 5.6, sx + 3.4, by + 1.6], shade(color, -0.35), 1.6);
    line(ctx, [sx, by - 5.6, sx + 3.4, by + 1.6], 'rgba(255,225,210,0.8)', 0.7);
  }
  // 冥犬身上的裂纹：随呼吸明暗，扑咬时更亮
  if (q.dead < 0) {
    const pulse = 0.55 + 0.3 * Math.sin(t * 3.2) + (ap ? 0.3 : 0);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const veins = [[-10, by - 3, -6, by - 5, -3, by - 2.5, 1, by - 4.5], [3, by - 1, 6, by - 4, 9, by - 2.2], [-8, by + 1.5, -4, by + 0.5]];
    // 狼王的裂纹是冰蓝色的（和眼睛一样），其他狼是熔岩色
    const [vr, vg, vb] = style.vein;
    const core = `rgba(${Math.min(255, vr + 60)},${Math.min(255, vg + 100)},${Math.min(255, vb + 70)},${pulse})`;
    for (const [wd, col] of [[2.6, `rgba(${vr},${vg},${vb},${0.35 * pulse})`], [1, core]] as [number, string][]) {
      for (const v of veins) line(ctx, v, col, wd);
    }
    ctx.restore();
  }
  // 毛的走向
  folds(ctx, [[-11, by - 4, -8.5, by - 2.8], [-6, by - 6.4, -3.6, by - 5.2], [5, by - 7.4, 7.6, by - 6], [10, by - 3.6, 12, by - 1.8]], shade(color, -0.45), 0.8);
  ctx.restore();

  leg(-6, (-g * gl + 0.05 + rearK) * deadLegs + deadK * 1.4, true, color, 2.6);
  leg(11, (g * gl - 0.15 + frontK) * deadLegs + deadK * 1.3, false, color, 2.4);

  // 颈毛：脖子一圈炸开的鬃毛，压在身体上、头的后面；狼王的又大又亮，挂一串狼牙
  if (style.ruff > 0) {
    const ruffK = style.ruff;
    const ruffColor = ruffK >= 1 ? shade(color, 0.3) : shade(color, 0.12);
    const cx = 9 + lunge * 0.3;
    const cy = by - 3.5 - bite;
    const spikes = 9;
    cel(ctx, (c) => {
      for (let i = 0; i <= spikes; i++) {
        const a = -PI * 0.95 + (i / spikes) * PI * 1.55;
        const ripple = Math.sin(t * 4 + i * 1.7) * 0.5 + (ap ? crouch * 1.2 : 0);
        const outer = (7.4 + (i % 2) * 2.4 + ripple) * (0.75 + ruffK * 0.45);
        const inner = 4.2 * (0.8 + ruffK * 0.3);
        const mid = a + (PI * 1.55) / spikes / 2;
        if (i === 0) c.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
        c.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
        if (i < spikes) c.lineTo(cx + Math.cos(mid) * inner * 1.25, cy + Math.sin(mid) * inner * 1.25);
      }
      c.closePath();
    }, ruffColor, { sd: 2.2, lw: 1.4 });
    // 鬃毛的走向
    const strands = [];
    for (let i = 1; i < spikes; i += 2) {
      const a = -PI * 0.95 + (i / spikes) * PI * 1.55;
      strands.push([cx + Math.cos(a) * 4, cy + Math.sin(a) * 4, cx + Math.cos(a) * 7.5 * ruffK, cy + Math.sin(a) * 7.5 * ruffK]);
    }
    folds(ctx, strands, shade(ruffColor, -0.35), 0.7);
    if (style.fangs && q.dead < 0) {
      // 一串狼牙：皮绳挂在颈毛下沿
      line(ctx, [cx - 5, cy + 4.5, cx, cy + 7, cx + 5.5, cy + 5], '#3a2618', 0.9);
      for (let i = 0; i < 4; i++) {
        const fx = cx - 3.6 + i * 2.6;
        const fy = cy + 5.8 + Math.sin(i * 1.3) * 0.6;
        flat(ctx, (c) => pPoly(c, [fx - 0.8, fy, fx + 0.8, fy, fx, fy + 2.8]), '#efe6cf', 0.9);
      }
    }
  }

  // head
  ctx.save();
  ctx.translate(13 + lunge * 0.4, by - 6 - crouch * 1.5 - bite * 1.5);
  ctx.rotate(pitch * 1.5 + (ap ? -0.15 * crouch : 0) + deadK * 0.4);
  // ears pinned back when attacking
  const earA = ap ? -0.5 : 0;
  for (const [ex, c] of [[-3.2, dark], [0.6, color]] as [number, string][]) {
    ctx.save();
    ctx.translate(ex, -4);
    ctx.rotate(earA);
    // 狼王近处那只耳朵缺了一个口子
    const torn = style.tornEar && ex > 0;
    cel(ctx, (cc) => pPoly(cc, torn ? [-2.4, 0, -0.6, -5.4, 0.8, -4.4, 0.4, -8.5, 2.8, 0] : [-2.4, 0, 0.4, -8.5, 2.8, 0]), c, { sd: 1, lw: 1.2 });
    ctx.restore();
  }
  cel(ctx, (c) => {
    c.moveTo(-6, 0);
    c.quadraticCurveTo(-5.5, -6.4, 1, -6);
    c.quadraticCurveTo(5, -5.5, 6.5, -2.6);
    c.lineTo(13, -1.4);
    c.quadraticCurveTo(14.6, 0.6, 12.6, 1.8);
    c.lineTo(5, 2.6);
    c.quadraticCurveTo(-2, 5.8, -6, 0);
    c.closePath();
  }, color, { sd: 2 });
  // lower jaw, opening on the bite
  ctx.save();
  ctx.translate(4.5, 2);
  ctx.rotate(jaw);
  cel(ctx, (c) => pPoly(c, [0, -0.6, 8.6, 0.4, 7.8, 2.4, 0, 2.6]), light, { sd: 0.8, lw: 1.2 });
  if (jaw > 0.25) flat(ctx, (c) => pPoly(c, [2, -0.4, 3, 1.4, 4, -0.2, 5, 1.4, 6, -0.1]), '#ffffff');
  ctx.restore();
  flat(ctx, (c) => pEll(c, 13, -0.6, 1.5, 1.2), '#14101a');
  // ember eye with a slanted brow
  const eye = q.dead >= 0 ? '#5a4a40' : ap ? style.rage : style.eye;
  flat(ctx, (c) => pPoly(c, [-0.4, -3.6, 4, -3.4, 3.6, -1.6, 0.2, -2]), eye, 1);
  if (q.dead < 0) glint(ctx, 2, -2.8, 4, ap ? 'rgba(255,80,40,0.8)' : style.eye === '#9fe8ff' ? 'rgba(150,230,255,0.6)' : 'rgba(255,170,60,0.5)');
  line(ctx, [-1, -4.8, 4.6, -3.4], OUTLINE, 1.3);
  // 脸颊的毛和眼角的旧伤疤
  flat(ctx, (c) => pPoly(c, [-5.6, 0.6, -8, 2.6, -5, 2, -6.6, 4, -3, 2.6]), color, 1);
  line(ctx, [1.6, -6, 3.2, -1.2], 'rgba(255,220,200,0.55)', 0.6);
  if (style.blaze) {
    // 头狼额头到鼻梁的一道白斑
    flat(ctx, (c) => pPoly(c, [-1.6, -5.6, 2.6, -5.4, 9, -1.8, 4.6, -2.4]), '#ece6da', 1);
  }
  if (style.scars >= 3) {
    // 狼王一道从额头划过眼睛的长疤
    line(ctx, [-0.6, -6.4, 5.2, 0.6], shade(color, -0.4), 1.5);
    line(ctx, [-0.6, -6.4, 5.2, 0.6], 'rgba(255,225,210,0.85)', 0.6);
  }
  ctx.restore();
  ctx.restore();
}

/* ------------------------------ hunter ------------------------------ */
// 猎人老陈：黑松林里的老猎人。皮袄加一圈毛领、护耳皮帽、背着弓和箭袋，手里一杆猎叉。

function drawHunter(ctx, q) {
  const color = safeColor(q.color, '#8a6a3a');
  const leather = shade(color, -0.1);
  const fur = '#d8c8a8';
  const ph = q.ph;
  const tilt = q.dead >= 0 ? lerp(PI / 2, PI * 0.97, q.dead) : PI / 2 + arc3(ph, 0.05, 0.25, -0.02);
  humanoid(ctx, q, {
    legs: '#5a4a36', boots: '#2e2016', body: leather, sleeve: shade(color, -0.2), skin: '#d6a27a',
    shoulder: 8.4, waist: 6.6, headR: 7, stride: 0.5,
    lean: () => (ph ? arc3(ph, 0, -0.1, 0.18) : 0),
    arms(q, g) {
      if (q.dead >= 0) return g.arms;
      return [[0.5, -0.6], [arc3(ph, 1.1, 0.5, 1.6), arc3(ph, -1, -1.7, -0.1)]];
    },
    back(ctx, q, B) {
      // 背上斜挎的长弓和箭袋
      inkLine(ctx, [-B.sw - 2, B.sy - 6, -B.sw + 5, B.hipY + 6], '#6a4424', 1.8);
      ctx.save();
      ctx.strokeStyle = 'rgba(240,230,210,0.7)';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(-B.sw - 1.4, B.sy - 5);
      ctx.lineTo(-B.sw + 5.4, B.hipY + 4.6);
      ctx.stroke();
      ctx.restore();
      cel(ctx, (c) => pRrect(c, -B.sw - 3, B.sy - 1, 5, 12, 1.6), '#5a3a20', { sd: 1.4 });
      for (let i = 0; i < 3; i++) {
        const fx = -B.sw - 2 + i * 1.6;
        line(ctx, [fx, B.sy - 1, fx - 0.4, B.sy - 5], '#d8cdb8', 0.8);
        flat(ctx, (c) => pPoly(c, [fx - 1.2, B.sy - 5, fx + 0.6, B.sy - 5.4, fx - 0.4, B.sy - 7.4]), i === 1 ? '#c8402c' : '#efe6d2', 0.8);
      }
    },
    torsoDetail(ctx, q, B) {
      // 毛领、皮带和挂在腰上的小刀
      cel(ctx, (c) => {
        c.moveTo(-B.sw + 0.5, B.sy + 1);
        for (let i = 0; i <= 6; i++) {
          const x = -B.sw + 0.5 + i * ((B.sw * 2 - 1) / 6);
          c.lineTo(x, B.sy + (i % 2 ? 4.4 : 2.6));
        }
        c.lineTo(B.sw - 0.5, B.sy - 1);
        c.closePath();
      }, fur, { sd: 1.2, lw: 1.1 });
      line(ctx, [-B.ww, B.hipY - 1.6, B.ww + 0.6, B.hipY - 2], '#2a1a10', 1.8);
      flat(ctx, (c) => pRrect(c, -0.6, B.hipY - 2.8, 2.2, 2, 0.4), '#c8a24a');
      inkLine(ctx, [B.ww - 1, B.hipY - 1, B.ww + 1, B.hipY + 5], '#3a2a1c', 1.4);
      folds(ctx, [[-B.ww + 1.5, B.sy + 7, -B.ww + 1, B.hipY - 3], [2.5, B.sy + 8, 3.2, B.hipY - 3]], 'rgba(40,24,10,0.5)', 0.7);
    },
    head(ctx, q, B) {
      const { hx, hy, hr } = B;
      // 灰白的络腮胡、眼睛和护耳皮帽
      flat(ctx, (c) => { c.moveTo(hx - 1, hy + 2); c.quadraticCurveTo(hx + 3, hy + 9, hx + hr, hy + 3); c.quadraticCurveTo(hx + 3, hy + 4.6, hx - 1, hy + 2); c.closePath(); }, '#cfc6b8', 1);
      eyes(ctx, hx + 2.6, hy + 0.8);
      line(ctx, [hx + 0.6, hy - 1.6, hx + 4.4, hy - 1.2], '#5a4a3a', 1);
      cel(ctx, (c) => {
        c.moveTo(hx - hr - 1, hy + 1);
        c.arc(hx, hy - 0.6, hr + 1, PI, TAU);
        c.lineTo(hx + hr + 1, hy - 1.4);
        c.lineTo(hx - hr - 1, hy - 1.4);
        c.closePath();
      }, '#6a4a2a', { sd: 1.6 });
      cel(ctx, (c) => pRrect(c, hx - hr - 1.5, hy - 2.6, hr * 2 + 3, 2.8, 1.2), fur, { sd: 0.8, lw: 1.1 });
      cel(ctx, (c) => pRrect(c, hx - hr - 1.6, hy - 1.4, 3.4, 6.4, 1.4), fur, { sd: 0.8, lw: 1.1 });
      glint(ctx, hx - 1.5, hy - 5.5, 2.4, 'rgba(255,230,190,0.45)');
    },
    weaponBehindHand: true,
    weapon(ctx, q, B, h) {
      const dx = Math.sin(tilt);
      const dy = Math.cos(tilt);
      const slide = arc3(ph, 0, -3, 6);
      h = { x: h.x + dx * slide, y: h.y + dy * slide };
      const x0 = h.x - dx * 13;
      const y0 = h.y - dy * 13;
      const x1 = h.x + dx * 17;
      const y1 = h.y + dy * 17;
      inkLine(ctx, [x0, y0, x1, y1], '#7a5230', 1.8);
      // 两股叉头
      const nx = dy;
      const ny = -dx;
      for (const side of [-1, 1]) {
        const bx = x1 + nx * side * 1.6;
        const by = y1 + ny * side * 1.6;
        cel(ctx, (c) => pPoly(c, [bx - nx * 0.9, by - ny * 0.9, bx + dx * 7 + nx * side * 0.6, by + dy * 7 + ny * side * 0.6, bx + nx * 0.9, by + ny * 0.9]), '#d8dde4', { dark: '#8a94a2', sd: 0.6, lw: 1 });
      }
      line(ctx, [x1 - nx * 2.4, y1 - ny * 2.4, x1 + nx * 2.4, y1 + ny * 2.4], '#4a4a52', 1.4);
    },
  });
}

/* ------------------------------ bramble ----------------------------- */
// 荆棘丛：挡在秘密房门口的一团带刺的藤，被打时抖，砍断后瘪下去只剩几截断茎。

function drawBramble(ctx, q) {
  const color = safeColor(q.color, '#4a6a2e');
  const dark = shade(color, -0.4);
  const t = q.time / 1000;
  const deadK = q.dead >= 0 ? ease(q.dead) : 0;
  const shiver = q.hit >= 0 && q.hit < 1 ? Math.sin(q.hit * 40) * (1 - q.hit) * 2 : 0;
  ctx.save();
  ctx.translate(shiver, 0);
  ctx.scale(1, 1 - deadK * 0.7);
  // 一团团叶子：后面暗、前面亮
  const clumps = [[-10, -12, 9, dark], [9, -13, 9, dark], [0, -19, 10, color], [-8, -6, 8, color], [8, -6, 8.5, color], [0, -8, 9, shade(color, 0.1)]] as [number, number, number, string][];
  for (const [x, y, r, c] of clumps) {
    const sway = Math.sin(t * 1.3 + x) * 0.6;
    cel(ctx, (cc) => {
      for (let i = 0; i <= 10; i++) {
        const a = (i / 10) * TAU;
        const rr = r * (i % 2 ? 0.82 : 1);
        if (i === 0) cc.moveTo(x + sway + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.85);
        else cc.lineTo(x + sway + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.85);
      }
      cc.closePath();
    }, c, { sd: 2, lw: 1.3 });
  }
  // 交错的藤条和尖刺
  const vines = [[-15, -4, -4, -20, 8, -24], [14, -3, 4, -17, -9, -22], [-12, -14, 0, -10, 13, -16]];
  for (const v of vines) {
    inkLine(ctx, v, '#5a3a24', 1.6);
    for (let i = 0; i < v.length - 2; i += 2) {
      const mx = (v[i] + v[i + 2]) / 2;
      const my = (v[i + 1] + v[i + 3]) / 2;
      flat(ctx, (c) => pPoly(c, [mx - 1, my, mx + 1, my, mx + 0.2, my - 3.2]), '#e8d8b8', 0.8);
    }
  }
  // 几颗暗红的浆果
  if (q.dead < 0) {
    for (const [x, y] of [[-5, -14], [6, -10], [2, -20]]) flat(ctx, (c) => pEll(c, x, y, 1.6, 1.6), '#8a1a2a', 1);
  }
  ctx.restore();
}

/* ------------------------------ skeleton ---------------------------- */
// A hooded skeleton archer with a tattered cloak, glowing sockets and a
// recurve bow drawn to the cheek.

function drawSkeleton(ctx, q) {
  const bone = '#ece4cc';
  const cloak = '#3a3352';
  const t = q.time / 1000;
  const moving = q.moving && q.dead < 0;
  const ph = q.walk || 0;
  const ap = q.ph;
  const draw = ap ? (ap.strike === 0 ? ap.wind : ap.back === 0 ? 1 - ap.strike : 0) : 0;
  const release = ap && ap.strike > 0 && ap.back < 0.5 ? 1 - ap.back * 2 : 0;

  if (q.dead >= 0) {
    drawBonePile(ctx, q, bone, cloak);
    return;
  }
  const swingLeg = moving ? Math.sin(ph) * 0.5 : 0;
  const bob = moving ? Math.abs(Math.cos(ph)) * 1.4 : Math.sin(t * 2) * 0.5;
  const rattle = moving ? Math.sin(ph * 4) * 0.4 : 0;
  const hipY = -15 - bob * 0.5;
  const sy = -28 - bob;

  // tattered cloak behind
  const sway = Math.sin(t * 2.4 + ph) * 1.5;
  cel(ctx, (c) => {
    c.moveTo(-5, sy - 3);
    c.quadraticCurveTo(-11, sy + 6, -10 - sway, hipY + 7);
    c.lineTo(-7 - sway, hipY + 4);
    c.lineTo(-5.5 - sway, hipY + 8.5);
    c.lineTo(-3, hipY + 4);
    c.lineTo(-1, hipY + 7);
    c.lineTo(3, sy + 4);
    c.closePath();
  }, cloak, { sd: 2.4 });
  // 斗篷上的破洞和褶
  flat(ctx, (c) => { pEll(c, -7.5 - sway * 0.6, hipY - 2, 0.9, 1.4); pEll(c, -5.5, sy + 8, 0.7, 1); }, 'rgba(10,6,20,0.85)');
  folds(ctx, [[-4, sy, -8, sy + 8, -8 - sway, hipY + 3]], 'rgba(10,6,20,0.5)', 0.8);
  // quiver
  cel(ctx, (c) => pRrect(c, -7.5, sy - 2, 4.2, 12, 1.5), '#6a4224', { sd: 1.2 });
  for (const [x, col] of [[-6.6, '#c8402c'], [-4.8, '#e8d8b0']] as [number, string][]) inkLine(ctx, [x, sy - 2, x - 0.8, sy - 6], col, 1);

  // legs: thin bones with knobby joints
  for (const [x, a, col] of [[-2, -swingLeg, '#b8af96'], [2.2, swingLeg, bone]] as [number, number, string][]) {
    const j = joint(x, hipY, a, 7.5, a - Math.max(0, a) * 0.8, 7.5);
    inkLine(ctx, [x, hipY, j.kx, j.ky, j.ex, j.ey], col, 1.8);
    flat(ctx, (c) => pEll(c, j.kx, j.ky, 1.6, 1.6), col, 1);
    flat(ctx, (c) => pPoly(c, [j.ex - 2, j.ey - 1.4, j.ex + 3.6, j.ey - 0.6, j.ex + 3.4, j.ey + 0.4, j.ex - 2, j.ey + 0.4]), col, 1.1);
  }
  // 胸腔里燃着一团幽蓝的魂火（画在肋骨后面）
  {
    const f = 0.7 + 0.3 * Math.sin(t * 6.3) + 0.15 * Math.sin(t * 17);
    glint(ctx, 1, sy + 7, 7 * f, 'rgba(70,200,255,0.55)');
    flat(ctx, (c) => {
      c.moveTo(-1.6, sy + 10);
      c.quadraticCurveTo(-2.2, sy + 6, 0.6, sy + 3.2 - f * 1.5);
      c.quadraticCurveTo(1.2, sy + 6, 3.2, sy + 6.4);
      c.quadraticCurveTo(3.4, sy + 9.4, 0.8, sy + 10.4);
      c.closePath();
    }, `rgba(170,240,255,${0.75 * f})`);
  }
  // pelvis, spine, ribs
  cel(ctx, (c) => { c.moveTo(-4.5, hipY - 1); c.lineTo(4.5, hipY - 1); c.lineTo(3, hipY + 2.6); c.lineTo(-3, hipY + 2.6); c.closePath(); }, bone, { sd: 1, lw: 1.2 });
  inkLine(ctx, [0.4, sy + 1, 0, hipY - 1], bone, 1.8);
  for (let i = 0; i < 4; i++) {
    const y = sy + 2.4 + i * 2.6 + rattle * (i % 2 ? 1 : -1) * 0.3;
    const wdt = 5.6 - i * 0.6;
    ctx.beginPath();
    ctx.moveTo(-wdt + 1, y + 0.8);
    ctx.quadraticCurveTo(0.5, y - 1.2, wdt + 1, y + 0.8);
    ctx.lineCap = 'round';
    ctx.strokeStyle = OUTLINE; ctx.lineWidth = 3.2; ctx.stroke();
    ctx.strokeStyle = i % 2 ? '#d8cfb4' : bone; ctx.lineWidth = 1.4; ctx.stroke();
  }
  // far arm holds the bow out front; near arm draws the string to the cheek
  const bowX = 13;
  const bowY = sy + 3;
  inkLine(ctx, [-2, sy + 1, 5, sy + 3, bowX - 1, bowY], '#b8af96', 1.6);
  // hood and skull
  const hy = sy - 6;
  cel(ctx, (c) => {
    c.moveTo(-6.5, hy + 6);
    c.quadraticCurveTo(-8.5, hy - 6, 0, hy - 9);
    c.quadraticCurveTo(8, hy - 9, 8.6, hy - 1);
    c.lineTo(6, hy + 1);
    c.quadraticCurveTo(-1, hy + 2, -2, hy + 7);
    c.closePath();
  }, cloak, { sd: 2 });
  cel(ctx, (c) => {
    c.moveTo(-1.5, hy + 1);
    c.quadraticCurveTo(-1, hy - 5, 4, hy - 4.6);
    c.quadraticCurveTo(8.4, hy - 4, 8.2, hy + 1);
    c.lineTo(7.6, hy + 4.4);
    c.lineTo(2, hy + 5);
    c.closePath();
  }, bone, { sd: 1.4, lw: 1.3 });
  // sockets with a cold fire inside, and teeth
  flat(ctx, (c) => { pEll(c, 3.3, hy - 0.5, 1.6, 1.9); pEll(c, 6.9, hy - 0.4, 1.3, 1.7); }, '#120e18');
  // 头骨上的裂纹
  line(ctx, [2.2, hy - 4.2, 3, hy - 2.8, 2.4, hy - 2], 'rgba(60,50,40,0.7)', 0.6);
  const glow = 0.65 + 0.35 * Math.sin(t * 5);
  glint(ctx, 3.4, hy - 0.4, 3.4, `rgba(90,230,255,${glow})`);
  glint(ctx, 6.9, hy - 0.3, 2.8, `rgba(90,230,255,${glow})`);
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let x = 3; x <= 7.5; x += 1.5) { ctx.moveTo(x, hy + 3); ctx.lineTo(x, hy + 4.8); }
  ctx.stroke();

  // recurve bow
  const bend = 1 - draw * 0.25;
  ctx.save();
  ctx.translate(bowX, bowY);
  const top = { x: -2.5 * bend, y: -12 };
  const bot = { x: -2.5 * bend, y: 12 };
  const bow = [top.x, top.y, 2 + draw, -7, 3.4, 0, 2 + draw, 7, bot.x, bot.y];
  ctx.beginPath();
  ctx.moveTo(top.x, top.y);
  ctx.quadraticCurveTo(3 + draw * 1.5, -8, 3.4, 0);
  ctx.quadraticCurveTo(3 + draw * 1.5, 8, bot.x, bot.y);
  ctx.lineCap = 'round';
  ctx.strokeStyle = OUTLINE; ctx.lineWidth = 4; ctx.stroke();
  ctx.strokeStyle = '#7a4a26'; ctx.lineWidth = 2.2; ctx.stroke();
  void bow;
  // string pulled to the hand
  const pull = -2 - draw * 11;
  line(ctx, [top.x, top.y, pull, 0, bot.x, bot.y], 'rgba(235,235,220,0.95)', 0.8);
  // drawing hand on the string
  inkLine(ctx, [-12, -2, pull - 0.5, 0], bone, 1.6);
  flat(ctx, (c) => pEll(c, pull, 0, 1.7, 1.7), bone, 1);
  if (!release) {
    // arrow on the string
    line(ctx, [pull, 0, pull + 17, 0], '#d8c8a0', 1.3);
    flat(ctx, (c) => pPoly(c, [pull + 16, -2.2, pull + 21, 0, pull + 16, 2.2]), '#d0d8e2', 1);
    flat(ctx, (c) => pPoly(c, [pull - 0.5, 0, pull + 3, -2, pull + 3.5, 0, pull + 3, 2]), '#c8402c');
  } else {
    // string still quivering
    ctx.globalAlpha *= release;
    line(ctx, [top.x, top.y, -1 + Math.sin(t * 90) * 1.5, 0, bot.x, bot.y], 'rgba(255,255,255,0.7)', 0.7);
  }
  ctx.restore();
}

// drawBonePile: a slain skeleton falls apart into a heap of bones.
// dropped 画掉在骨堆旁边的武器（默认是弓手的弓），参数是倒下的进度和高度插值。
function drawBonePile(ctx, q, bone, cloak, dropped = drawDroppedBow) {
  const d = ease(q.dead);
  const drop = (y0, y1) => lerp(y0, y1, easeIn(clamp01(d * 1.3)));
  // the hood and cloak settle into a heap
  cel(ctx, (c) => {
    c.moveTo(-13, 0);
    c.quadraticCurveTo(-11, drop(-26, -7), -3, drop(-30, -8));
    c.quadraticCurveTo(4, drop(-24, -6), 9, 0);
    c.closePath();
  }, cloak, { sd: 2 });
  dropped(ctx, d, drop);
  // ribs, then long bones with knobbed ends
  ctx.save();
  ctx.translate(lerp(0, -4, d), drop(-18, -5));
  ctx.rotate(lerp(0, -1.2, d));
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.ellipse(0, i * 2.6, 4.4 - i * 0.5, 1.6, 0, PI * 0.1, PI * 0.9);
    ctx.lineWidth = 3.6; ctx.strokeStyle = OUTLINE; ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = bone; ctx.stroke();
  }
  ctx.restore();
  const pieces = [[-8, -10, 0.5, 10], [5, -12, -0.6, 9], [-1, -6, 1.4, 8], [9, -22, 0.3, 7], [-11, -4, -0.3, 6]];
  for (const [x, y, a, l] of pieces) {
    ctx.save();
    ctx.translate(x * (1 + d * 0.35), drop(y, -1.6));
    ctx.rotate(lerp(0, a + PI / 2, d));
    inkLine(ctx, [-l / 2, 0, l / 2, 0], bone, 2);
    flat(ctx, (c) => { pEll(c, -l / 2, -0.8, 1.4, 1.4); pEll(c, -l / 2, 0.8, 1.4, 1.4); pEll(c, l / 2, -0.8, 1.4, 1.4); pEll(c, l / 2, 0.8, 1.4, 1.4); }, bone, 1);
    ctx.restore();
  }
  // the skull rolls away and comes to rest grinning
  ctx.save();
  ctx.translate(lerp(2, 13, d), drop(-34, -4.6));
  ctx.rotate(d * 1.3);
  cel(ctx, (c) => { pEll(c, 0, -0.6, 5.4, 4.8); pRrect(c, -2.4, 2.2, 5.6, 3.2, 1); }, bone, { sd: 1.4, lw: 1.3 });
  flat(ctx, (c) => { pEll(c, 0.8, -0.8, 1.4, 1.6); pEll(c, 3.6, -0.6, 1.1, 1.5); }, '#120e18');
  line(ctx, [-1, 3.8, 2.6, 3.8], '#120e18', 0.8);
  if (d < 0.9) glint(ctx, 2, -0.8, 4, `rgba(120,220,255,${0.7 * (1 - d)})`);
  ctx.restore();
}

// drawDroppedBow：弓手倒下时弓掉在骨堆旁边。
function drawDroppedBow(ctx, d, drop) {
  ctx.save();
  ctx.translate(lerp(8, 4, d), drop(-18, -2));
  ctx.rotate(lerp(0, 1.45, d));
  ctx.beginPath();
  ctx.arc(-4, 0, 10, -1.1, 1.1);
  ctx.lineWidth = 4.2; ctx.strokeStyle = OUTLINE; ctx.lineCap = 'round'; ctx.stroke();
  ctx.lineWidth = 2; ctx.strokeStyle = '#8a5230'; ctx.stroke();
  ctx.restore();
}

/* -------------------------------- ogre ------------------------------ */
// The chieftain: hunched mass, tusked underbite, horned iron helm, spiked
// shoulder plate, war paint, and a studded club brought down two-handed.

function drawOgre(ctx, q) {
  const accent = safeColor(q.color, '#c0392b');
  const skin = '#7f9a4c';
  const iron = '#666b78';
  const t = q.time / 1000;
  const moving = q.moving && q.dead < 0;
  const ph = q.walk || 0;
  const ap = q.ph;
  const bob = moving ? Math.abs(Math.cos(ph)) * 2 : Math.sin(t * 1.7) * 0.9;
  const lean = (moving ? 0.12 : 0.06) + (ap ? arc3(ap, 0, -0.3, 0.32) : 0) - (q.hit >= 0 ? 0.25 * (1 - q.hit) : 0);
  const hipY = -14 - bob * 0.4;
  const sy = -31 - bob + (ap ? arc3(ap, 0, -2, 2.5) : 0);

  // thick legs
  const legs = moving ? [Math.sin(ph) * 0.42, -Math.sin(ph) * 0.42] : [-0.12, 0.14];
  const drawLeg = (x, a, color) => {
    const j = joint(x, hipY, a, 7, a - Math.max(0, a) * 0.6, 7);
    cel(ctx, (c) => pTaper(c, x, hipY, j.kx, j.ky, 5.4, 4.4), color, { sd: 1.8, lw: 1.4 });
    cel(ctx, (c) => pTaper(c, j.kx, j.ky, j.ex, j.ey - 1, 4.4, 3.8), color, { sd: 1.6, lw: 1.4 });
    // fur-wrapped foot
    cel(ctx, (c) => pRrect(c, j.ex - 4.6, j.ey - 3.6, 10, 4.2, 2), '#5a4030', { sd: 1.2, lw: 1.3 });
  };
  drawLeg(-4.2, legs[0], shade(skin, -0.2));

  ctx.save();
  ctx.translate(0, hipY);
  ctx.rotate(lean);
  ctx.translate(0, -hipY);

  // club: two-handed overhead swing smashing into the ground
  const ang = arc3(ap, 1.05, 3.4, 1.5);
  const shX = 7;
  const shY = sy + 4;
  const arm = joint(shX, shY, ang, 8, ang + arc3(ap, -0.5, -0.2, -0.1), 7.5);

  // far arm reaches for the club handle during the swing
  const farA = ap ? ang + 0.25 : 0.25 - legs[0] * 0.6;
  const farArm = joint(-9, sy + 4, farA, 8, farA - 0.4, 7.5);
  cel(ctx, (c) => pTaper(c, -9, sy + 4, farArm.kx, farArm.ky, 4.6, 3.8), shade(skin, -0.22), { sd: 1.6, lw: 1.4 });
  cel(ctx, (c) => pTaper(c, farArm.kx, farArm.ky, farArm.ex, farArm.ey, 3.8, 3.6), shade(skin, -0.22), { sd: 1.4, lw: 1.4 });

  // hunched body with a round belly
  cel(ctx, (c) => {
    c.moveTo(-13, sy + 2);
    c.quadraticCurveTo(-12, sy - 7, 1, sy - 6);
    c.quadraticCurveTo(13, sy - 5, 13.5, sy + 6);
    c.quadraticCurveTo(15, hipY + 1, 6, hipY + 3);
    c.lineTo(-8, hipY + 3);
    c.quadraticCurveTo(-15, hipY - 4, -13, sy + 2);
    c.closePath();
  }, skin, { sd: 3.4 });
  // belly and war paint
  flat(ctx, (c) => pEll(c, 4.5, hipY - 7, 7, 6.4), shade(skin, 0.18));
  // 旧伤疤（淡色缝线）
  line(ctx, [-9, sy + 8, -4, sy + 12], shade(skin, 0.35), 0.8);
  folds(ctx, [[-8.2, sy + 8.6, -7.4, sy + 8], [-6.6, sy + 10, -5.8, sy + 9.4], [-5, sy + 11.2, -4.2, sy + 10.6]], shade(skin, 0.4), 0.6);
  // 肚脐和肚皮的褶
  folds(ctx, [[1, hipY - 4.4, 4.5, hipY - 3.6, 8, hipY - 4.8]], shade(skin, -0.3), 0.8);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < 3; i++) { ctx.moveTo(-6 + i * 3, sy + 1); ctx.lineTo(-7 + i * 3, sy + 6); }
  ctx.stroke();
  // belt, skull buckle and loincloth
  cel(ctx, (c) => pPoly(c, [-9, hipY - 1, 9, hipY - 1, 6, hipY + 8, 1, hipY + 6, -4, hipY + 8.5, -8, hipY + 6]), accent, { sd: 1.8 });
  flat(ctx, (c) => pRrect(c, -11, hipY - 3.5, 22, 3.6, 1.2), '#3e2616', 1.2);
  rivets(ctx, [-8.5, hipY - 1.7, -5, hipY - 1.7, 5.5, hipY - 1.7, 9, hipY - 1.7], 0.6, '#c8ccd6');
  cel(ctx, (c) => pEll(c, 1.2, hipY - 1.8, 2.6, 2.4), '#ece4cc', { sd: 0.8, lw: 1 });
  flat(ctx, (c) => { pEll(c, 0.4, -0.4 + hipY - 2, 0.6, 0.7); pEll(c, 2, hipY - 2.4, 0.6, 0.7); }, '#2a1a10');
  // spiked shoulder plate on the near shoulder
  cel(ctx, (c) => {
    c.moveTo(1, sy - 3);
    c.quadraticCurveTo(10, sy - 9, 15, sy - 1);
    c.lineTo(13.5, sy + 5);
    c.quadraticCurveTo(7, sy + 3, 1.5, sy + 4);
    c.closePath();
  }, iron, { sd: 2 });
  // 肩甲后面的一圈兽毛领
  flat(ctx, (c) => {
    c.moveTo(-12, sy + 1);
    for (let i = 0; i <= 8; i++) {
      const x = -12 + i * 2;
      c.lineTo(x + 1, sy - 4.5 - (i % 2) * 1.6 + Math.sin(t * 2 + i) * 0.3);
      c.lineTo(x + 2, sy - 1.5);
    }
    c.lineTo(4, sy + 2);
    c.closePath();
  }, '#4a3326', 1.2);
  rivets(ctx, [4.5, sy - 1, 9.5, sy - 2.5, 12.6, sy + 1.6], 0.55, '#c8ccd6');
  for (const [x, y, a] of [[5, sy - 5.5, -0.4], [10, sy - 5.6, 0.2], [14, sy - 1.5, 0.9]]) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    cel(ctx, (c) => pPoly(c, [-1.7, 0, 0, -5.5, 1.7, 0]), '#d8dce2', { sd: 0.6, lw: 1 });
    ctx.restore();
  }

  // head sits low and forward between the shoulders
  const hx = 8;
  const hy = sy - 3.5 + (q.hit >= 0 ? -1 : 0);
  cel(ctx, (c) => {
    c.moveTo(hx - 6, hy + 2);
    c.quadraticCurveTo(hx - 6.5, hy - 6, hx + 1, hy - 6);
    c.quadraticCurveTo(hx + 7.5, hy - 5.5, hx + 7.5, hy + 1);
    c.quadraticCurveTo(hx + 8, hy + 5.5, hx + 2, hy + 6);
    c.quadraticCurveTo(hx - 5, hy + 6, hx - 6, hy + 2);
    c.closePath();
  }, skin, { sd: 2.2 });
  // underbite with tusks
  cel(ctx, (c) => { c.moveTo(hx - 1, hy + 3); c.lineTo(hx + 8, hy + 2); c.quadraticCurveTo(hx + 8.5, hy + 6.5, hx + 2, hy + 6.5); c.closePath(); }, shade(skin, -0.08), { sd: 1, lw: 1.2 });
  for (const tx of [hx + 2.4, hx + 6.4]) cel(ctx, (c) => pPoly(c, [tx - 1.2, hy + 3, tx + 0.2, hy - 1.6, tx + 1.2, hy + 3]), '#f2ead6', { sd: 0.5, lw: 1 });
  // 金鼻环
  ctx.strokeStyle = '#e2b04a';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.arc(hx + 7.2, hy + 1.6, 1.2, -0.5, PI + 0.8);
  ctx.stroke();
  // brow and burning eyes
  flat(ctx, (c) => pPoly(c, [hx - 1, hy - 2.6, hx + 8, hy - 2, hx + 7.6, hy - 0.2, hx - 0.6, hy - 1]), shade(skin, -0.35));
  const eye = q.dead >= 0 ? '#555' : '#ffd23a';
  flat(ctx, (c) => { pEll(c, hx + 2.6, hy - 0.4, 1.1, 0.9); pEll(c, hx + 6, hy - 0.2, 1, 0.8); }, eye);
  if (q.dead < 0) glint(ctx, hx + 4.4, hy - 0.4, 5, ap ? 'rgba(255,90,30,0.85)' : 'rgba(255,200,60,0.45)');
  // horned iron helm
  cel(ctx, (c) => { c.moveTo(hx - 6.4, hy - 1); c.quadraticCurveTo(hx - 6, hy - 8.5, hx + 1, hy - 8.4); c.quadraticCurveTo(hx + 7.4, hy - 8, hx + 7.6, hy - 2); c.lineTo(hx - 6.4, hy - 1); c.closePath(); }, iron, { sd: 1.8 });
  line(ctx, [hx - 6, hy - 1.8, hx + 7.4, hy - 2.6], '#9aa0ae', 1.4);
  // thick bull horns curling up and forward, dark at the root
  for (const [bx, d, k] of [[hx - 4, -1, 0.85], [hx + 5.5, 1, 1]]) {
    cel(ctx, (c) => {
      c.moveTo(bx - 2.4 * d, hy - 5);
      c.quadraticCurveTo(bx + d * 8 * k, hy - 5.5, bx + d * 6.5 * k, hy - 13 * k);
      c.quadraticCurveTo(bx + d * 4 * k, hy - 8.5, bx + d * 0.6, hy - 7.8);
      c.closePath();
    }, '#efe6cf', { sd: 1.2, lw: 1.2 });
    line(ctx, [bx - 0.6 * d, hy - 6.8, bx + d * 3.2, hy - 6.8], '#6b5a44', 1.6, 'butt');
  }

  // near arm and club
  cel(ctx, (c) => pTaper(c, shX, shY, arm.kx, arm.ky, 5, 4.2), skin, { sd: 1.8, lw: 1.4 });
  cel(ctx, (c) => pTaper(c, arm.kx, arm.ky, arm.ex, arm.ey, 4.2, 4), skin, { sd: 1.6, lw: 1.4 });
  // iron bracer
  cel(ctx, (c) => pTaper(c, lerp(arm.kx, arm.ex, 0.25), lerp(arm.ky, arm.ey, 0.25), lerp(arm.kx, arm.ex, 0.75), lerp(arm.ky, arm.ey, 0.75), 4.6, 4.4), iron, { sd: 1.2, lw: 1.2 });
  rivets(ctx, [lerp(arm.kx, arm.ex, 0.4), lerp(arm.ky, arm.ey, 0.4), lerp(arm.kx, arm.ex, 0.6), lerp(arm.ky, arm.ey, 0.6)], 0.55, '#d8dce2');
  ctx.save();
  ctx.translate(arm.ex, arm.ey);
  const clubA = ang + arc3(ap, 0, -0.2, 0.15);
  ctx.rotate(-clubA + PI);
  cel(ctx, (c) => pRrect(c, -1.8, -3, 3.6, 13, 1.6), '#5e3a1e', { sd: 0.8, lw: 1.2 });
  cel(ctx, (c) => {
    c.moveTo(-3, -3);
    c.quadraticCurveTo(-8, -14, -5, -25);
    c.quadraticCurveTo(0, -30, 5, -25);
    c.quadraticCurveTo(8, -14, 3, -3);
    c.closePath();
  }, '#8a5a2e', { sd: 2.2 });
  // 木纹和一道裂口
  folds(ctx, [[-2.5, -6, -4.5, -14, -3, -22], [1.5, -5, 2.5, -13, 1, -24], [3.6, -8, 4.6, -11]], 'rgba(50,25,10,0.55)', 0.8);
  // iron band and spikes
  line(ctx, [-6.2, -15, 6.2, -15], '#3a3a44', 2.2, 'butt');
  for (const [x, y, d] of [[-6, -10, -1], [6.4, -12, 1], [-6, -20, -1], [5.6, -21, 1], [0, -27.5, 0]]) {
    const ax = d === 0 ? 0 : d * 3.6;
    const ay = d === 0 ? -3.6 : 0;
    flat(ctx, (c) => pPoly(c, [x - (d === 0 ? 1.4 : 0), y - (d === 0 ? 0 : 1.4), x + ax, y + ay, x + (d === 0 ? 1.4 : 0), y + (d === 0 ? 0 : 1.4)]), '#e2e6ec', 1);
  }
  ctx.restore();
  ctx.restore();

  drawLeg(4.2, legs[1], skin);

  if (ap && ap.strike > 0.85 && ap.back < 0.5) {
    // the ground cracks where the club lands
    const k = ap.back / 0.5;
    const gx = arm.ex + 18;
    ctx.save();
    ctx.globalAlpha *= 1 - k;
    ctx.strokeStyle = '#ffd27a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(gx, -1, 6 + k * 18, 2 + k * 5, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
}

/* ------------------------------ fallback ---------------------------- */

/* ------------------------------- pets ------------------------------- */
// 宠物：比怪物小一圈、圆一点、表情友好，脖子上都有一样东西表明是有主人的（项圈 / 铃铛 / 花环）。
// 动作名就是宠物技能的 fx（见 config/skills.yaml）：攻击走 q.ph，其他技能走 q.action。

// 宠物的碰撞半径比人小，但按半径画出来太小看不清，画的时候再放大这么多（MODEL_BOX 里的框也相应放大）
const PET_DRAW_SCALE = 1.35;

// petCast 返回施放类动作（嚎叫、治疗）的进度：举起 → 保持 → 放下，没有动作时是 0。
function petCast(q) {
  if (!q.ph || !['buff', 'circle', 'heal'].includes(q.action)) return 0;
  return q.ph.strike === 0 ? q.ph.wind * 0.6 : 0.6 + 0.4 * q.ph.strike * (1 - q.ph.back) - 0.6 * q.ph.back;
}

// petAttack 返回普通攻击的蓄力和出手（施放类动作时都是 0）。
function petAttack(q) {
  if (!q.ph || petCast(q) > 0) return { gather: 0, strike: 0 };
  return {
    gather: q.ph.strike === 0 ? q.ph.wind : 1 - q.ph.strike,
    strike: q.ph.strike * (1 - q.ph.back),
  };
}

// 小狼：圆滚滚的幼崽，大脑袋短腿，红色项圈挂一个金铃铛。攻击是扑咬，嚎叫时仰头张嘴。
function drawWolfPup(ctx, q) {
  ctx.save();
  ctx.scale(PET_DRAW_SCALE, PET_DRAW_SCALE);
  const color = safeColor(q.color, '#b5824e');
  const dark = shade(color, -0.35);
  const cream = shade(color, 0.5);
  const time = q.time / 1000;
  const moving = q.moving && q.dead < 0;
  const phase = q.walk || 0;
  const { gather, strike } = petAttack(q);
  const howl = petCast(q);
  const deadK = q.dead >= 0 ? ease(q.dead) : 0;
  const lunge = -2 * gather + 9 * strike;
  const hop = moving ? Math.abs(Math.sin(phase)) * 2.4 : 0;
  const bodyY = -11 - hop + gather * 2 + deadK * 5 - Math.sin(time * 2.2) * 0.4;

  ctx.save();
  ctx.translate(lunge * 0.7, 0);
  if (q.dead >= 0) ctx.rotate(-0.15 * deadK);

  const leg = (x, swing, legColor) => {
    const angle = swing * (1 - deadK) + deadK * 1.2;
    const footX = x + Math.sin(angle) * 6;
    const footY = bodyY + 3 + Math.cos(angle) * 6 + hop;
    cel(ctx, (c) => pTaper(c, x, bodyY + 2, footX, Math.min(footY, -1), 2.8, 2.4), legColor, { sd: 1, lw: 1.3 });
    flat(ctx, (c) => pEll(c, footX + 1, Math.min(footY, -1) + 0.4, 2.6, 1.7), shade(legColor, 0.15), 1.2);
  };
  const stride = moving ? Math.sin(phase) * 0.7 : 0;
  const pounce = -0.5 * strike + 0.3 * gather;

  // 尾巴：毛茸茸地摇
  const wag = moving ? Math.sin(phase * 2) * 0.2 : Math.sin(time * (howl ? 3 : 7)) * 0.45;
  ctx.save();
  ctx.translate(-10, bodyY - 3);
  ctx.rotate(-0.9 + wag + deadK * 0.8);
  cel(ctx, (c) => {
    c.moveTo(0, -2.4);
    c.quadraticCurveTo(-5, -6, -10, -3.5);
    c.quadraticCurveTo(-8, 0, -10.5, 1.5);
    c.quadraticCurveTo(-5, 3.5, 0, 2.4);
    c.closePath();
  }, color, { sd: 1.4 });
  flat(ctx, (c) => pEll(c, -9.4, -1, 2, 1.8), cream);
  ctx.restore();

  leg(-6, stride + pounce, dark);
  leg(6, -stride - pounce * 1.4, dark);

  // 身体：一颗圆面包
  cel(ctx, (c) => pEll(c, 0, bodyY - 1, 11, 7.5), color, { sd: 2.6 });
  flat(ctx, (c) => pEll(c, 2, bodyY + 3, 7, 3), cream);
  folds(ctx, [[-8, bodyY - 3, -6, bodyY - 1.6], [-3, bodyY - 6.4, -1, bodyY - 5.4]], shade(color, -0.4), 0.8);

  leg(-4, -stride + pounce * 0.6, color);
  leg(8, stride - pounce * 1.6, color);

  // 项圈和铃铛：脖子上一圈红带子，头会压住它的上半截
  ctx.save();
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(4.2, bodyY - 7.5);
  ctx.quadraticCurveTo(9.5, bodyY - 5, 10, bodyY - 0.6);
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 4.2;
  ctx.stroke();
  ctx.strokeStyle = '#c8323c';
  ctx.lineWidth = 2.4;
  ctx.stroke();
  ctx.restore();
  const bellSwing = moving ? Math.sin(phase * 2) * 1.2 : Math.sin(time * 3) * 0.4;
  cel(ctx, (c) => pEll(c, 10 + bellSwing * 0.3, bodyY + 1.4, 1.9, 1.9), '#f0c850', { sd: 0.7, lw: 1.1 });

  // 头：比身体还大一点，嚎叫时往上仰
  ctx.save();
  ctx.translate(9 + strike * 2, bodyY - 7 - howl * 2);
  ctx.rotate(-0.9 * howl - 0.1 * gather + deadK * 0.5 + (moving ? Math.sin(phase * 2) * 0.04 : Math.sin(time * 1.3) * 0.05));
  // 耳朵：大三角，尖上颜色深；扑咬时往后贴
  const earTilt = strike > 0 ? -0.6 : howl ? -0.3 : Math.sin(time * 1.7) * 0.08;
  for (const [earX, earColor] of [[-5, dark], [0, color]] as [number, string][]) {
    ctx.save();
    ctx.translate(earX, -7);
    ctx.rotate(earTilt - 0.15);
    cel(ctx, (c) => pPoly(c, [-3, 1, 0.2, -8, 3.2, 1]), earColor, { sd: 1, lw: 1.2 });
    flat(ctx, (c) => pPoly(c, [-1.4, 0, 0.2, -5, 1.8, 0]), '#e89a9a');
    ctx.restore();
  }
  cel(ctx, (c) => pEll(c, -1, -2, 8, 7), color, { sd: 2 });
  // 嘴筒子：短短圆圆，浅色
  const jaw = 0.1 + gather * 0.5 + howl * 0.7 - strike * 0.3;
  ctx.save();
  ctx.translate(4.5, 1.6);
  ctx.rotate(Math.max(0, jaw));
  cel(ctx, (c) => pEll(c, 2.6, 0.8, 3.6, 1.6), cream, { sd: 0.6, lw: 1.2 });
  ctx.restore();
  cel(ctx, (c) => pEll(c, 5.6, -0.2, 4.2, 2.6), cream, { sd: 0.8, lw: 1.3 });
  flat(ctx, (c) => pEll(c, 9.4, -1, 1.6, 1.2), '#1a1218');
  if (jaw > 0.3) flat(ctx, (c) => pEll(c, 6.6, 2.4, 2.4, 1.4 * jaw), '#6a1a24', 1);
  // 眼睛：大而亮，死了画叉
  if (q.dead < 0) {
    const blink = Math.sin(time * 0.9) > 0.985 || howl > 0.5;
    if (blink) {
      line(ctx, [-0.6, -3, 1.8, -2.4, 3.4, -3], OUTLINE, 1.2);
    } else {
      flat(ctx, (c) => pEll(c, 1.6, -3, 1.8, 2.3), '#1a1218');
      flat(ctx, (c) => pEll(c, 2.2, -3.9, 0.7, 0.8), '#ffffff');
    }
    flat(ctx, (c) => pEll(c, 1, 0.4, 1.4, 0.8), 'rgba(240,120,130,0.55)');
  } else {
    line(ctx, [0, -4.4, 3, -1.6], OUTLINE, 1.1);
    line(ctx, [3, -4.4, 0, -1.6], OUTLINE, 1.1);
  }
  ctx.restore();

  ctx.restore();
  ctx.restore();
}

// 火灵：飘在半空的一团火，圆脸大眼，身后拖着火舌。攻击时往前一冲吐火，爆燃时整团火胀大。
function drawEmber(ctx, q) {
  ctx.save();
  ctx.scale(PET_DRAW_SCALE, PET_DRAW_SCALE);
  const color = safeColor(q.color, '#ff7a2a');
  const core = '#ffcf4a';
  const deep = shade(color, -0.35);
  const time = q.time / 1000;
  const moving = q.moving && q.dead < 0;
  const { gather, strike } = petAttack(q);
  const flare = petCast(q);
  const deadK = q.dead >= 0 ? ease(q.dead) : 0;
  const float = -20 - Math.sin(time * 2.6) * 2 + deadK * 14;
  const lean = moving ? 0.25 : 0.05;
  const swell = 1 + flare * 0.35 + strike * 0.12 - gather * 0.08 - deadK * 0.5;
  const pushX = -2 * gather + 6 * strike;

  // 地上的小影子提示它是飘着的
  ctx.save();
  ctx.globalAlpha *= 0.25 * (1 - deadK);
  flat(ctx, (c) => pEll(c, 0, -0.5, 6, 2), '#000000');
  ctx.restore();

  ctx.save();
  ctx.translate(pushX, float);
  ctx.scale(swell, swell);
  ctx.globalAlpha *= 1 - deadK * 0.6;

  // 火舌：两条往身后飘的火苗，按时间抖动，走动时拉长
  const tongue = (offsetY, length, fill) => {
    const wave = Math.sin(time * 9 + offsetY * 3) * 1.4;
    const tipX = -5 - length;
    const tipY = -8 + offsetY - lean * 5 + wave;
    flat(ctx, (c) => {
      c.moveTo(-3, -6 + offsetY * 0.4);
      c.quadraticCurveTo(tipX * 0.6, tipY - 1, tipX, tipY);
      c.quadraticCurveTo(tipX * 0.5, tipY + 6, -2, 4);
      c.closePath();
    }, fill, 1.3);
  };
  tongue(-2, 7 + (moving ? 5 : 0), color);
  tongue(3, 5 + (moving ? 4 : 0), shade(color, 0.25));

  // 主体：上尖下圆的火苗
  const tip = Math.sin(time * 7) * 1.5;
  const body = (c) => {
    c.moveTo(0, 8);
    c.bezierCurveTo(-9, 8, -10, -1, -5, -6);
    c.quadraticCurveTo(-2, -10, -2 - lean * 4 + tip, -16);
    c.quadraticCurveTo(4, -10, 7, -5);
    c.bezierCurveTo(10, 0, 8, 8, 0, 8);
    c.closePath();
  };
  cel(ctx, body, color, { dark: deep, lit: core, sd: 2.4, hl: 1.4 });
  // 内焰
  flat(ctx, (c) => {
    c.moveTo(0, 6);
    c.bezierCurveTo(-5, 6, -5.6, 0, -2, -4);
    c.quadraticCurveTo(0, -7, 0.4 + tip * 0.5, -9);
    c.quadraticCurveTo(3, -5, 4.4, -2);
    c.bezierCurveTo(6, 2, 4, 6, 0, 6);
    c.closePath();
  }, core);

  // 脸
  if (q.dead < 0) {
    const blink = Math.sin(time * 1.1) > 0.985;
    for (const eyeX of [-0.6, 3.6]) {
      if (blink) {
        line(ctx, [eyeX - 1, 0, eyeX + 1, 0], '#5a1a08', 1.1);
      } else {
        flat(ctx, (c) => pEll(c, eyeX, 0, 1.2, 1.9), '#5a1a08');
        flat(ctx, (c) => pEll(c, eyeX + 0.4, -0.8, 0.5, 0.6), '#ffffff');
      }
    }
    if (strike > 0.2 || flare > 0.3) {
      flat(ctx, (c) => pEll(c, 1.6, 3.4, 1.6, 1.4), '#5a1a08');
    } else {
      ctx.strokeStyle = '#5a1a08';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.arc(1.6, 2.4, 1.3, 0.3, PI - 0.3);
      ctx.stroke();
    }
  } else {
    line(ctx, [-1.6, -1, 0.4, 1, 2.6, -1, 4.6, 1], '#5a1a08', 1);
  }

  // 绕着转的两颗火星（实心小块，不画柔光）
  for (let index = 0; index < 2; index++) {
    const angle = time * 3 + index * PI;
    const sparkX = Math.cos(angle) * 11;
    const sparkY = -2 + Math.sin(angle) * 3.5;
    if (Math.sin(angle) < 0 && index === 0) continue;
    flat(ctx, (c) => pPoly(c, [sparkX, sparkY - 1.6, sparkX + 1, sparkY, sparkX, sparkY + 1.6, sparkX - 1, sparkY]), core, 0.8);
  }
  // 金色小环：有主人的标记
  line(ctx, [-4.6, 6.2, 0, 7.6, 4.6, 6.2], '#f0c850', 1.2);
  ctx.restore();
  ctx.restore();
}

// 林精：一截小树桩似的木头身子，头顶冒两片嫩叶，戴一圈小花环。攻击时甩出刺，治疗时举起双手、叶子张开。
function drawSprout(ctx, q) {
  ctx.save();
  ctx.scale(PET_DRAW_SCALE, PET_DRAW_SCALE);
  const color = safeColor(q.color, '#8fd17a');
  const wood = '#a07a50';
  const woodDark = '#6e4e30';
  const time = q.time / 1000;
  const moving = q.moving && q.dead < 0;
  const phase = q.walk || 0;
  const { gather, strike } = petAttack(q);
  const mend = petCast(q);
  const deadK = q.dead >= 0 ? ease(q.dead) : 0;
  const hop = moving ? Math.abs(Math.sin(phase)) * 2 : 0;
  const bodyY = -hop + deadK * 3;
  const sway = moving ? Math.sin(phase) * 0.08 : Math.sin(time * 1.6) * 0.04;

  ctx.save();
  if (q.dead >= 0) ctx.rotate(-0.5 * deadK);
  ctx.translate(0, bodyY);
  ctx.rotate(sway - 0.1 * gather + 0.15 * strike);

  // 小短腿（两根树根）
  for (const [legX, legPhase] of [[-3, 0], [3, PI]] as [number, number][]) {
    const lift = moving ? Math.max(0, Math.sin(phase + legPhase)) * 2.4 : 0;
    cel(ctx, (c) => pTaper(c, legX, -4, legX + 1, -lift - 0.5, 2.2, 1.8), woodDark, { sd: 0.8, lw: 1.2 });
  }
  // 身子：圆肚子树桩
  cel(ctx, (c) => {
    c.moveTo(-7, -3);
    c.bezierCurveTo(-8.5, -10, -7, -17, 0, -17.5);
    c.bezierCurveTo(7, -17, 8.5, -10, 7, -3);
    c.quadraticCurveTo(0, -0.8, -7, -3);
    c.closePath();
  }, wood, { dark: woodDark, sd: 2.2 });
  // 木纹
  folds(ctx, [[-4.6, -6, -5, -12], [4.8, -5, 5.4, -11], [-1, -4, -0.6, -7]], 'rgba(60,36,18,0.55)', 0.8);
  // 手：两根小树枝，治疗时举过头顶，攻击时前手往前甩
  const arm = (shoulderX, raise, armColor, front) => {
    // 角度从水平朝外量，正的往下：平时垂在两侧，治疗时举过头顶往外张；攻击时前手往后蓄力再往前甩
    const outward = front ? 1 : -1;
    let angle = 0.7 - raise * 2.6;
    if (front) angle += -1.2 * gather + 0.9 * strike;
    const handX = shoulderX + outward * Math.cos(angle) * 8;
    const handY = -11 + Math.sin(angle) * 8;
    line(ctx, [shoulderX, -11, handX, handY], OUTLINE, 3.4);
    line(ctx, [shoulderX, -11, handX, handY], armColor, 1.8);
    cel(ctx, (c) => pEll(c, handX, handY, 2, 1.4, angle * outward), color, { sd: 0.6, lw: 1.1 });
  };
  // 脸
  if (q.dead < 0) {
    const blink = Math.sin(time * 0.8) > 0.985 || mend > 0.4;
    for (const eyeX of [0.8, 4.4]) {
      if (blink) {
        ctx.strokeStyle = '#2a1a0c';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(eyeX, -11.4, 1.1, PI + 0.3, TAU - 0.3);
        ctx.stroke();
      } else {
        flat(ctx, (c) => pEll(c, eyeX, -11, 1.1, 1.6), '#2a1a0c');
        flat(ctx, (c) => pEll(c, eyeX + 0.4, -11.7, 0.45, 0.5), '#ffffff');
      }
    }
    flat(ctx, (c) => pEll(c, -0.8, -9, 1.3, 0.7), 'rgba(240,130,120,0.6)');
    ctx.strokeStyle = '#2a1a0c';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(2.6, -8.6, 1.1, 0.3, PI - 0.3);
    ctx.stroke();
  } else {
    line(ctx, [0, -12, 1.8, -10, 3.6, -12, 5.4, -10], '#2a1a0c', 0.9);
  }
  // 花环：几朵白花一圈
  for (let index = 0; index < 4; index++) {
    const flowerX = -5 + index * 3.4;
    const flowerY = -15.8 + Math.abs(index - 1.5) * 0.6;
    flat(ctx, (c) => pEll(c, flowerX, flowerY, 1.5, 1.2), '#fff4f0', 0.9);
    flat(ctx, (c) => pEll(c, flowerX, flowerY, 0.5, 0.5), '#f0c850');
  }
  // 头顶两片叶子：治疗时张开，平时轻轻晃
  const open = 0.35 + mend * 0.6 + Math.sin(time * 2.2) * 0.06;
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(0, -17);
    ctx.rotate(side * open);
    line(ctx, [0, 0, 0, -3], '#4a7a3a', 1.2);
    cel(ctx, (c) => {
      c.moveTo(0, -2.6);
      c.quadraticCurveTo(side * 5, -4, side * 8, -10);
      c.quadraticCurveTo(side * 2, -9, 0, -2.6);
      c.closePath();
    }, color, { sd: 1, lw: 1.2 });
    line(ctx, [side * 0.6, -3.4, side * 5.6, -8.4], shade(color, -0.35), 0.6);
    ctx.restore();
  }
  // 手最后画：举起来时盖在花环和叶子前面
  arm(-5, mend, woodDark, false);
  arm(5, mend, wood, true);
  ctx.restore();
  ctx.restore();
}

function drawBlob(ctx, q) {
  const color = safeColor(q.color, '#cccccc');
  const bob = q.moving ? Math.abs(Math.sin(q.walk || 0)) * 3 : Math.sin(q.time / 400) * 0.8;
  cel(ctx, (c) => pEll(c, 0, -13 - bob, 13, 13), color, { sd: 3 });
  eyes(ctx, 3, -14 - bob);
}

/* ------------------------- crypt: skeleton warriors ------------------------- */
// 第二关「亡者地穴」的骷髅兵和精英骷髅骑士：骨架和弓手一样，近手持盾、远手持剑。
// 平时盾挡在身前，举盾（q.blocking）时盾往前顶、剑收到肩后；出手时盾让开、剑从头顶劈下来；
// 破防（q.broken）时盾被打开、人往后仰。骑士大一号，多了头盔、胸甲、肩甲、破红披风和塔盾。

interface SkeletonStyle {
  knight: boolean;
  bone: string;
  rag: string;        // 破布 / 披风
  iron: string;       // 甲片和剑
  wood: string;       // 盾面
}

const SOLDIER_STYLE: SkeletonStyle = { knight: false, bone: '#ece4cc', rag: '#3a3446', iron: '#8a8f99', wood: '#6b4a2c' };
const KNIGHT_STYLE: SkeletonStyle = { knight: true, bone: '#e4dcc4', rag: '#6a1f24', iron: '#5c6270', wood: '#3a3f4c' };

function drawSkeletonWarrior(ctx, q, st: SkeletonStyle) {
  const t = q.time / 1000;
  const moving = q.moving && q.dead < 0;
  const ph = q.walk || 0;
  if (q.dead >= 0) {
    drawBonePile(ctx, q, st.bone, st.rag, (c, d, drop) => drawDroppedArms(c, d, drop, st));
    return;
  }
  const ap = q.ph;
  const broken = q.broken >= 0 ? Math.sin(Math.min(1, q.broken / 0.5) * PI * 0.5) * (1 - Math.max(0, q.broken - 0.6) / 0.4) : 0;
  const guard = q.blocking && !ap ? 1 : 0;
  const swingLeg = moving ? Math.sin(ph) * (guard ? 0.3 : 0.5) : 0;
  const bob = moving ? Math.abs(Math.cos(ph)) * 1.4 : Math.sin(t * 2) * 0.5;
  const rattle = moving ? Math.sin(ph * 4) * 0.4 : 0;
  // 举盾时压低重心、往前探；破防时往后仰
  const crouch = guard * 1.6;
  const lean = guard * 1.5 - broken * 3 + (ap ? arc3(ap, 0, -1.5, 2.5) : 0);
  const hipY = -15 - bob * 0.5 + crouch;
  const sy = -28 - bob + crouch * 1.4;
  const sx = lean;

  // 披风（骑士）/ 破布腰带（骷髅兵），在最后面
  const sway = Math.sin(t * 2.2 + ph) * 1.5;
  if (st.knight) {
    cel(ctx, (c) => {
      c.moveTo(sx - 4, sy - 1);
      c.quadraticCurveTo(sx - 13, sy + 6, -12 - sway, hipY + 9);
      c.lineTo(-9 - sway, hipY + 6);
      c.lineTo(-7.5 - sway, hipY + 10);
      c.lineTo(-5, hipY + 6);
      c.lineTo(-3, hipY + 9);
      c.lineTo(sx + 2, sy + 4);
      c.closePath();
    }, st.rag, { sd: 2.4 });
    folds(ctx, [[sx - 5, sy + 1, -9, sy + 9, -10 - sway, hipY + 5]], 'rgba(20,4,8,0.55)', 0.9);
  }

  // 远手（剑）：手的位置和剑的角度（弧度，0 朝前，正的往下）
  const rest = { hx: sx + 3, hy: hipY - 2, a: 1.25 };
  const held = { hx: sx - 5, hy: sy - 3, a: -2.1 };      // 举盾时剑收到肩后
  const wound = { hx: sx - 4, hy: sy - 9, a: -2.5 };     // 劈之前举过头顶
  const struck = { hx: sx + 11, hy: sy + 7, a: 0.55 };   // 劈到身前
  let hand = guard ? held : rest;
  if (ap) {
    hand = {
      hx: arc3(ap, hand.hx, wound.hx, struck.hx),
      hy: arc3(ap, hand.hy, wound.hy, struck.hy),
      a: arc3(ap, hand.a, wound.a, struck.a),
    };
  }
  if (broken > 0) hand = { hx: lerp(hand.hx, sx - 9, broken), hy: lerp(hand.hy, sy - 4, broken), a: lerp(hand.a, -2.8, broken) };
  // 远手的臂骨：肩 → 肘 → 手
  const farShoulder = { x: sx - 2, y: sy + 1.5 };
  const elbow = { x: (farShoulder.x + hand.hx) / 2 - 2, y: (farShoulder.y + hand.hy) / 2 + 2 };
  inkLine(ctx, [farShoulder.x, farShoulder.y, elbow.x, elbow.y, hand.hx, hand.hy], '#b8af96', 1.6);
  drawBoneSword(ctx, hand.hx, hand.hy, hand.a, st, ap && ap.strike > 0 && ap.back < 0.4);

  // 腿
  for (const [x, a, col] of [[-2, -swingLeg - guard * 0.25, '#b8af96'], [2.2, swingLeg + guard * 0.35, st.bone]] as [number, number, string][]) {
    const j = joint(x, hipY, a, 7.5, a - Math.max(0, a) * 0.8 - guard * 0.3, 7.5 + crouch * 0.2);
    inkLine(ctx, [x, hipY, j.kx, j.ky, j.ex, Math.min(0, j.ey)], col, st.knight ? 2.2 : 1.8);
    flat(ctx, (c) => pEll(c, j.kx, j.ky, 1.6, 1.6), col, 1);
    if (st.knight) cel(ctx, (c) => pRrect(c, j.kx - 2, j.ky - 2.4, 4.4, 4.4, 1.2), st.iron, { sd: 1, lw: 1.1 });   // 护膝
    flat(ctx, (c) => pPoly(c, [j.ex - 2, Math.min(0, j.ey) - 1.4, j.ex + 3.6, Math.min(0, j.ey) - 0.6, j.ex + 3.4, Math.min(0, j.ey) + 0.4, j.ex - 2, Math.min(0, j.ey) + 0.4]), col, 1.1);
  }
  // 胸腔里的魂火
  {
    const f = 0.7 + 0.3 * Math.sin(t * 6.3) + 0.15 * Math.sin(t * 17);
    glint(ctx, sx + 1, sy + 7, 7 * f, st.knight ? 'rgba(255,90,70,0.5)' : 'rgba(70,200,255,0.55)');
  }
  // 骨盆、脊柱、肋骨
  cel(ctx, (c) => { c.moveTo(-4.5, hipY - 1); c.lineTo(4.5, hipY - 1); c.lineTo(3, hipY + 2.6); c.lineTo(-3, hipY + 2.6); c.closePath(); }, st.bone, { sd: 1, lw: 1.2 });
  // 破布腰带
  cel(ctx, (c) => { c.moveTo(-5, hipY - 2); c.lineTo(5, hipY - 2); c.lineTo(4, hipY + 5); c.lineTo(1.5, hipY + 2.5); c.lineTo(-1, hipY + 6); c.lineTo(-4, hipY + 3); c.closePath(); }, st.knight ? '#2a2d36' : st.rag, { sd: 1.4, lw: 1.1 });
  inkLine(ctx, [sx + 0.4, sy + 1, 0, hipY - 1], st.bone, 1.8);
  if (st.knight) {
    // 胸甲：一块生锈的铁板，上面有一道旧伤
    cel(ctx, (c) => {
      c.moveTo(sx - 5.5, sy + 0.5);
      c.quadraticCurveTo(sx + 1, sy - 2, sx + 7, sy + 0.5);
      c.lineTo(sx + 6, sy + 10);
      c.quadraticCurveTo(sx + 1, sy + 12.5, sx - 4.5, sy + 10);
      c.closePath();
    }, st.iron, { sd: 2, lw: 1.3 });
    line(ctx, [sx - 2, sy + 2.5, sx + 3.5, sy + 8], 'rgba(20,12,10,0.7)', 0.8);
    flat(ctx, (c) => pEll(c, sx + 4, sy + 7, 1.6, 1), 'rgba(140,70,40,0.6)');     // 锈斑
    rivets(ctx, [sx - 3.5, sy + 1.6, sx + 5, sy + 1.6, sx - 3, sy + 9, sx + 4.6, sy + 9], 0.5, '#c8ccd4');
  } else {
    for (let i = 0; i < 4; i++) {
      const y = sy + 2.4 + i * 2.6 + rattle * (i % 2 ? 1 : -1) * 0.3;
      const wdt = 5.6 - i * 0.6;
      ctx.beginPath();
      ctx.moveTo(sx - wdt + 1, y + 0.8);
      ctx.quadraticCurveTo(sx + 0.5, y - 1.2, sx + wdt + 1, y + 0.8);
      ctx.lineCap = 'round';
      ctx.strokeStyle = OUTLINE; ctx.lineWidth = 3.2; ctx.stroke();
      ctx.strokeStyle = i % 2 ? '#d8cfb4' : st.bone; ctx.lineWidth = 1.4; ctx.stroke();
    }
  }

  // 头：骷髅兵是光头骨，骑士戴一顶带护鼻和红缨的铁盔
  const hy = sy - 6 + guard * 0.8;
  const hx = sx + guard * 1.2;
  cel(ctx, (c) => {
    c.moveTo(hx - 3, hy + 1);
    c.quadraticCurveTo(hx - 3, hy - 6, hx + 2.6, hy - 6);
    c.quadraticCurveTo(hx + 8.4, hy - 5.4, hx + 8.2, hy + 1);
    c.lineTo(hx + 7.6, hy + 4.4);
    c.lineTo(hx + 1, hy + 5);
    c.closePath();
  }, st.bone, { sd: 1.4, lw: 1.3 });
  flat(ctx, (c) => { pEll(c, hx + 3.3, hy - 0.5, 1.6, 1.9); pEll(c, hx + 6.9, hy - 0.4, 1.3, 1.7); }, '#120e18');
  const glow = 0.65 + 0.35 * Math.sin(t * 5);
  const eye = st.knight ? `rgba(255,90,60,${glow})` : `rgba(90,230,255,${glow})`;
  glint(ctx, hx + 3.4, hy - 0.4, 3.4, eye);
  glint(ctx, hx + 6.9, hy - 0.3, 2.8, eye);
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let x = 3; x <= 7.5; x += 1.5) { ctx.moveTo(hx + x, hy + 3); ctx.lineTo(hx + x, hy + 4.8); }
  ctx.stroke();
  if (st.knight) {
    // 红缨在后面飘
    cel(ctx, (c) => {
      c.moveTo(hx + 1, hy - 7);
      c.quadraticCurveTo(hx - 6, hy - 12 + sway * 0.4, hx - 11 - sway, hy - 6);
      c.quadraticCurveTo(hx - 5, hy - 7, hx + 1, hy - 4);
      c.closePath();
    }, '#a8262c', { sd: 1.4, lw: 1.1 });
    cel(ctx, (c) => {
      c.moveTo(hx - 4, hy + 2);
      c.quadraticCurveTo(hx - 4.5, hy - 8.5, hx + 3, hy - 8.4);
      c.quadraticCurveTo(hx + 9.6, hy - 8, hx + 9.4, hy - 1.5);
      c.lineTo(hx + 8.6, hy - 1.5);
      c.lineTo(hx + 8.6, hy - 2.6);
      c.lineTo(hx + 1.6, hy - 2.6);
      c.lineTo(hx + 1.6, hy + 3);     // 护鼻
      c.lineTo(hx - 1, hy + 3);
      c.closePath();
    }, st.iron, { sd: 1.6, lw: 1.3 });
    line(ctx, [hx - 3, hy - 3.5, hx + 8.5, hy - 3.8], 'rgba(255,255,255,0.25)', 0.7);
  }

  // 近手（盾）：平时挡在身前，举盾时往前顶、抬高；出手时让开；破防时被打开
  let shieldX = sx + 6.5, shieldY = sy + 10, face = 0.55;
  if (guard) { shieldX = sx + 9.5; shieldY = sy + 7; face = 0.75; }
  if (ap) { shieldX = arc3(ap, shieldX, sx + 4, sx + 1); shieldY = arc3(ap, shieldY, sy + 9, sy + 12); }
  if (broken > 0) { shieldX = lerp(shieldX, sx + 3, broken); shieldY = lerp(shieldY, sy + 15, broken); face = lerp(face, 0.3, broken); }
  const nearShoulder = { x: sx + 2, y: sy + 2 };
  inkLine(ctx, [nearShoulder.x, nearShoulder.y, (nearShoulder.x + shieldX) / 2 + 1, (nearShoulder.y + shieldY) / 2 + 2, shieldX - 1, shieldY], st.bone, 1.7);
  if (st.knight) {
    // 肩甲
    cel(ctx, (c) => { c.moveTo(sx - 1.5, sy + 3); c.quadraticCurveTo(sx + 2.5, sy - 3.5, sx + 7, sy + 1.5); c.lineTo(sx + 5.5, sy + 4.5); c.quadraticCurveTo(sx + 2.5, sy + 2, sx - 1.5, sy + 3); c.closePath(); }, st.iron, { sd: 1.4, lw: 1.2 });
  }
  drawBoneShield(ctx, shieldX, shieldY, face, st, q);
}

// drawBoneSword 在手的位置 (hx, hy) 画一把剑，angle 是剑尖的方向（0 朝前，正的往下）。
function drawBoneSword(ctx, hx, hy, angle, st: SkeletonStyle, swinging) {
  const length = st.knight ? 21 : 15;
  const width = st.knight ? 2.4 : 1.7;
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(angle);
  if (swinging) {
    // 劈下去的一瞬间拖一道刀光
    flat(ctx, (c) => { c.moveTo(4, 0); c.arc(0, 0, length, -1.6, 0, false); c.lineTo(length * 0.4, 0); c.closePath(); }, st.knight ? 'rgba(255,140,110,0.35)' : 'rgba(200,230,255,0.3)');
  }
  // 剑身（缺了几个口）、护手、握柄
  cel(ctx, (c) => {
    c.moveTo(2.5, -width);
    c.lineTo(length - 3, -width);
    c.lineTo(length, 0);
    c.lineTo(length - 3, width);
    c.lineTo(length * 0.6, width);
    c.lineTo(length * 0.55, width - 0.8);
    c.lineTo(length * 0.5, width);
    c.lineTo(2.5, width);
    c.closePath();
  }, st.iron, { sd: 0.9, lw: 1.1 });
  line(ctx, [3, -0.3, length - 3, -0.3], 'rgba(255,255,255,0.35)', 0.6);
  cel(ctx, (c) => pRrect(c, 1.2, -width - 2, 2, width * 2 + 4, 0.8), st.knight ? '#7a5a2a' : '#5a5048', { sd: 0.6, lw: 1 });
  inkLine(ctx, [-2.5, 0, 1.2, 0], '#4a3424', 1.6);
  ctx.restore();
  flat(ctx, (c) => pEll(c, hx, hy, 1.8, 1.8), st.bone, 1);
}

// drawBoneShield 画近手的盾：骷髅兵是一面破木圆盾，骑士是一面铁边塔盾。face 是盾面朝外露出多少（侧面看是扁的）。
function drawBoneShield(ctx, x, y, face, st: SkeletonStyle, q) {
  const flash = q.parry >= 0 ? 1 - q.parry : 0;
  if (st.knight) {
    const w = 6 * face + 1.5, h = 13;
    cel(ctx, (c) => {
      c.moveTo(x - w, y - h);
      c.quadraticCurveTo(x, y - h - 2, x + w, y - h);
      c.lineTo(x + w, y + h * 0.55);
      c.quadraticCurveTo(x + w * 0.4, y + h, x, y + h + 1.5);
      c.quadraticCurveTo(x - w * 0.4, y + h, x - w, y + h * 0.55);
      c.closePath();
    }, st.iron, { sd: 2, lw: 1.5 });
    // 盾面上的骷髅纹和铁边
    cel(ctx, (c) => {
      c.moveTo(x - w + 1.6, y - h + 1.8);
      c.lineTo(x + w - 1.6, y - h + 1.8);
      c.lineTo(x + w - 1.6, y + h * 0.5);
      c.quadraticCurveTo(x, y + h - 0.5, x - w + 1.6, y + h * 0.5);
      c.closePath();
    }, '#7a1f26', { sd: 1.2, lw: 0.9 });
    flat(ctx, (c) => { pEll(c, x, y - 2, w * 0.45, 3); pRrect(c, x - w * 0.25, y + 0.2, w * 0.5, 2.4, 0.6); }, '#d8d0b8');
    flat(ctx, (c) => { pEll(c, x - w * 0.18, y - 2.2, 0.7, 0.9); pEll(c, x + w * 0.18, y - 2.2, 0.7, 0.9); }, '#1a0e12');
    rivets(ctx, [x - w + 0.9, y - h + 0.9, x + w - 0.9, y - h + 0.9, x - w + 0.9, y + 3, x + w - 0.9, y + 3], 0.55, '#c8ccd4');
  } else {
    const rx = 5.6 * face + 1, ry = 8;
    cel(ctx, (c) => pEll(c, x, y, rx, ry), st.wood, { sd: 1.8, lw: 1.5 });
    // 木板缝、铁边、中间的铁包
    line(ctx, [x - rx * 0.4, y - ry + 1.2, x - rx * 0.4, y + ry - 1.2], 'rgba(30,18,10,0.6)', 0.7);
    line(ctx, [x + rx * 0.35, y - ry + 1.4, x + rx * 0.35, y + ry - 1.4], 'rgba(30,18,10,0.6)', 0.7);
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
    ctx.lineWidth = 1.3; ctx.strokeStyle = st.iron; ctx.stroke();
    cel(ctx, (c) => pEll(c, x + 0.4, y, Math.max(1, rx * 0.35), 2.4), st.iron, { sd: 0.8, lw: 1 });
    // 缺了一角
    flat(ctx, (c) => pPoly(c, [x + rx * 0.3, y - ry - 0.5, x + rx + 0.6, y - ry * 0.6, x + rx + 0.6, y - ry - 0.5]), '#140c12');
  }
  if (flash > 0) glint(ctx, x, y, 14, `rgba(200,235,255,${0.8 * flash})`);
}

// drawDroppedArms：骷髅兵 / 骑士倒下时盾和剑掉在骨堆旁边。
function drawDroppedArms(ctx, d, drop, st: SkeletonStyle) {
  ctx.save();
  ctx.translate(lerp(-6, -11, d), drop(-16, -3));
  ctx.rotate(lerp(0, -1.2, d));
  drawBoneSword(ctx, 0, 0, 0, st, false);
  ctx.restore();
  ctx.save();
  ctx.translate(lerp(8, 7, d), drop(-14, -3));
  ctx.scale(1, lerp(1, 0.45, d));      // 盾倒下来平躺在地上
  drawBoneShield(ctx, 0, 0, lerp(0.55, 1, d), st, { parry: -1 });
  ctx.restore();
}

// drawBonePileAlive 是骨堆（还能站起来的那种）：和骷髅兵倒下的最后一帧一样，
// 魂火在骨头缝里越烧越旺、骨头越抖越厉害，6 秒左右重新拼起来。q.age 是出现了多少毫秒。
function drawBonePileAlive(ctx, q) {
  const k = clamp01((q.age || 0) / 6000);
  const t = q.time / 1000;
  const shake = q.dead < 0 ? Math.sin(t * (18 + k * 30)) * k * k * 1.6 : 0;
  const jolt = q.hit >= 0 && q.hit < 1 ? Math.sin(q.hit * 30) * (1 - q.hit) * 2.5 : 0;
  ctx.save();
  if (q.dead >= 0) {
    // 砸碎了：骨头散开、压扁
    const d = ease(clamp01(q.dead));
    ctx.scale(1 + d * 0.4, 1 - d * 0.55);
  }
  ctx.translate(shake + jolt, 0);
  drawBonePile(ctx, { ...q, dead: 1 }, SOLDIER_STYLE.bone, SOLDIER_STYLE.rag, (c, d, drop) => drawDroppedArms(c, d, drop, SOLDIER_STYLE));
  ctx.restore();
  if (q.dead < 0) {
    // 骨头缝里的魂火：一团实心的蓝火苗，越到后面越高
    const f = 0.8 + 0.2 * Math.sin(t * 9);
    const h = 3 + k * 9 * f;
    flat(ctx, (c) => {
      c.moveTo(-3.5, -3);
      c.quadraticCurveTo(-4, -3 - h * 0.6, 0, -3 - h);
      c.quadraticCurveTo(3.5, -3 - h * 0.5, 3, -3);
      c.closePath();
    }, `rgba(110,220,255,${0.55 + 0.35 * k})`);
    flat(ctx, (c) => {
      c.moveTo(-1.5, -3);
      c.quadraticCurveTo(-1.6, -3 - h * 0.45, 0.4, -3 - h * 0.7);
      c.quadraticCurveTo(1.6, -3 - h * 0.35, 1.4, -3);
      c.closePath();
    }, `rgba(225,250,255,${0.6 + 0.3 * k})`);
  }
}

/* ------------------------- crypt: mechanisms ------------------------- */

// drawBoneStatue 是骨箭雕像：石台上一尊大骷髅头，四面各伸出一根骨刺（横竖两条射线的方向）；
// 预警时（行为树在 WarnLine）眼睛和骨刺尖烧红。
function drawBoneStatue(ctx, q) {
  const t = q.time / 1000;
  const warn = q.node === 'warn_line' ? 0.6 + 0.4 * Math.sin(t * 22) : 0;
  const stone = '#6b6878';
  const dark = '#45424f';
  ctx.scale(LX, 1);     // 雕像不跟着朝向翻转（横竖对称，左右翻过来反而奇怪）
  // 台座
  cel(ctx, (c) => pRrect(c, -15, -10, 30, 11, 2), dark, { sd: 2, lw: 1.5 });
  cel(ctx, (c) => pRrect(c, -12, -16, 24, 8, 2), stone, { sd: 1.6, lw: 1.4 });
  line(ctx, [-13, -5, 13, -5], 'rgba(10,8,14,0.5)', 0.8);
  // 左右两根骨刺（横线）和上面一根（竖线；下面那根埋在台座里）
  const tip = warn ? `rgba(255,${120 - warn * 60},${90 - warn * 60},1)` : '#e8e0c8';
  for (const sign of [-1, 1]) {
    cel(ctx, (c) => pPoly(c, [sign * 9, -27, sign * 9, -21, sign * 22, -24]), '#d8d0b8', { sd: 1, lw: 1.2 });
    flat(ctx, (c) => pPoly(c, [sign * 18, -25.4, sign * 18, -22.6, sign * 22, -24]), tip);
  }
  cel(ctx, (c) => pPoly(c, [-3, -40, 3, -40, 0, -50]), '#d8d0b8', { sd: 1, lw: 1.2 });
  flat(ctx, (c) => pPoly(c, [-1.3, -46, 1.3, -46, 0, -50]), tip);
  // 大骷髅头
  cel(ctx, (c) => {
    c.moveTo(-10, -26);
    c.quadraticCurveTo(-11, -42, 0, -42);
    c.quadraticCurveTo(11, -42, 10, -26);
    c.lineTo(7, -18);
    c.lineTo(-7, -18);
    c.closePath();
  }, stone, { sd: 2.2, lw: 1.5 });
  // 裂纹和青苔
  line(ctx, [-6, -38, -3, -34, -5, -31], 'rgba(20,16,24,0.7)', 0.8);
  flat(ctx, (c) => { pEll(c, 6, -39, 3, 1.4); pEll(c, -8, -24, 2.2, 1.2); }, 'rgba(70,110,70,0.55)');
  // 眼窝：平时暗红，预警时烧亮
  flat(ctx, (c) => { pEll(c, -4.2, -30, 2.8, 3.2); pEll(c, 4.2, -30, 2.8, 3.2); }, '#140c12');
  const eye = 0.35 + warn * 0.65;
  flat(ctx, (c) => { pEll(c, -4.2, -29.6, 1.3, 1.5); pEll(c, 4.2, -29.6, 1.3, 1.5); }, `rgba(255,${90 + warn * 80},70,${eye})`);
  if (warn) {
    glint(ctx, -4.2, -29.6, 6, `rgba(255,80,60,${warn})`);
    glint(ctx, 4.2, -29.6, 6, `rgba(255,80,60,${warn})`);
  }
  // 牙
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  for (let x = -5; x <= 5; x += 2.5) { ctx.moveTo(x, -22); ctx.lineTo(x, -18.5); }
  ctx.stroke();
}

// drawBrazier 是灵火盆：熄着时是一盆黑炭冒一缕烟，被打一下就点着（服务端把它算作倒下，尸体一直留着）。
function drawBrazier(ctx, q) {
  const t = q.time / 1000;
  const lit = q.dead >= 0;
  const flare = lit ? clamp01(q.dead / 0.3) : 0;
  ctx.scale(LX, 1);
  // 三条腿的石座和铁盆
  for (const x of [-7, 0, 7]) inkLine(ctx, [x * 0.6, -8, x, 0], '#4a4652', 2);
  cel(ctx, (c) => { c.moveTo(-11, -14); c.lineTo(11, -14); c.quadraticCurveTo(9, -6, 0, -6); c.quadraticCurveTo(-9, -6, -11, -14); c.closePath(); }, '#5a5d68', { sd: 2, lw: 1.4 });
  cel(ctx, (c) => pEll(c, 0, -14, 11, 3), '#2a2830', { sd: 0.8, lw: 1.2 });
  rivets(ctx, [-8, -11, 0, -8.5, 8, -11], 0.6, '#b8bcc8');
  if (!lit) {
    // 黑炭和一缕青烟
    flat(ctx, (c) => { pEll(c, -4, -14.5, 3, 1.4); pEll(c, 3, -14.8, 3.4, 1.5); pEll(c, 0, -15.4, 2.4, 1.2); }, '#1a1418');
    const drift = Math.sin(t * 1.4) * 2;
    line(ctx, [0, -16, drift, -22, -drift, -28], 'rgba(150,200,220,0.35)', 1.4);
    return;
  }
  // 点着：一团实心的青色魂火，外层、里层两层火舌
  const f = 0.85 + 0.15 * Math.sin(t * 11) + 0.08 * Math.sin(t * 23);
  const h = (18 + 6 * flare * (1 - clamp01((q.dead - 0.3) / 0.5))) * f;
  const sway = Math.sin(t * 3) * 1.5;
  flat(ctx, (c) => {
    c.moveTo(-9, -14);
    c.quadraticCurveTo(-10, -14 - h * 0.5, -3 + sway, -14 - h * 0.75);
    c.quadraticCurveTo(-2, -14 - h * 0.6, sway * 1.4, -14 - h);
    c.quadraticCurveTo(4, -14 - h * 0.55, 5 + sway, -14 - h * 0.7);
    c.quadraticCurveTo(10, -14 - h * 0.4, 9, -14);
    c.closePath();
  }, '#3fd8ff');
  flat(ctx, (c) => {
    c.moveTo(-5, -14);
    c.quadraticCurveTo(-5, -14 - h * 0.4, sway, -14 - h * 0.7);
    c.quadraticCurveTo(5, -14 - h * 0.4, 5, -14);
    c.closePath();
  }, '#d8fbff');
  // 飘起来的火星
  for (let i = 0; i < 3; i++) {
    const k = (t * 0.8 + i / 3) % 1;
    flat(ctx, (c) => pEll(c, Math.sin(i * 2.3 + t * 2) * 6, -14 - h * 0.6 - k * 16, 1.1 * (1 - k), 1.1 * (1 - k)), '#9ff0ff');
  }
}

// drawCrackedWall 是墙上的一道裂缝（守墓人密室的入口）：一段石墙，裂缝里透出一点光；
// 挨一下重击裂得更开，砸开以后塌成一堆碎石。
function drawCrackedWall(ctx, q) {
  const stone = safeColor(q.color, '#6a6474');
  const hurt = q.hpk !== undefined ? 1 - q.hpk : 0;
  const shiver = q.hit >= 0 && q.hit < 1 ? Math.sin(q.hit * 40) * (1 - q.hit) * 2 : 0;
  ctx.scale(LX, 1);
  if (q.dead >= 0) {
    const d = ease(clamp01(q.dead));
    for (const [x, y, r] of [[-12, -4, 6], [-3, -3, 7], [8, -4, 6], [14, -2, 4], [2, -9, 5], [-9, -10, 4]] as [number, number, number][]) {
      cel(ctx, (c) => pEll(c, x * (1 + d * 0.2), lerp(y - 18, y, d), r, r * 0.7), stone, { sd: 1.4, lw: 1.2 });
    }
    return;
  }
  ctx.translate(shiver, 0);
  // 砖块
  for (let row = 0; row < 4; row++) {
    for (let col = -2; col < 2; col++) {
      const x = col * 11 + (row % 2 ? 5.5 : 0) - 5.5;
      const y = -10 - row * 9;
      cel(ctx, (c) => pRrect(c, x, y, 10.5, 8.5, 1.2), shade(stone, ((row * 3 + col) % 3) * 0.06 - 0.06), { sd: 1.4, lw: 1.1 });
    }
  }
  // 裂缝：一道折线，里面透出光；挨过一下后裂得更宽、光更亮
  const crack = [-2, -44, 2, -34, -3, -26, 3, -18, -1, -6];
  line(ctx, crack, OUTLINE, 1.8 + hurt * 2.4);
  if (hurt > 0) line(ctx, crack, 'rgba(255,170,110,0.9)', 0.6 + hurt * 1.2);
  else line(ctx, crack, 'rgba(160,200,255,0.35)', 0.6);     // 裂缝里透出一点墙后的蓝光
  if (hurt > 0) line(ctx, [-3, -26, -11, -22, -14, -14], OUTLINE, 1.6);
}

// drawStonePillar 是献祭坑的石柱（首领冲撞撞上就碎）：和地图上的石柱一个样子，柱身上缠着褪色的红布；
// 撞碎以后剩半截断柱和一地碎石。
function drawStonePillar(ctx, q) {
  const stone = '#d8ccb0';
  const dark = '#9d907a';
  ctx.scale(LX, 1);
  flat(ctx, (c) => pEll(c, 0, 0, 16, 5), 'rgba(0,0,0,0.35)');
  cel(ctx, (c) => c.rect(-13, -7, 26, 7), '#b9ac90', { sd: 1.4, lw: 1.3 });
  cel(ctx, (c) => c.rect(-10.5, -11, 21, 5), '#cfc2a4', { sd: 1.2, lw: 1.2 });
  if (q.dead >= 0) {
    // 断柱：参差的断口，脚下一圈碎石（倒下那一下碎石往外散开）
    const d = ease(clamp01(q.dead / 0.4));
    cel(ctx, (c) => {
      c.moveTo(-8.5, -11); c.lineTo(-8, -34); c.lineTo(-4, -40); c.lineTo(-1, -33); c.lineTo(3, -44); c.lineTo(8, -36); c.lineTo(8.5, -11);
      c.closePath();
    }, stone, { sd: 1.6, lw: 1.5 });
    flat(ctx, (c) => c.rect(3, -34, 4.5, 22), dark);
    for (const [x, y, r] of [[-17, -2, 5], [15, -3, 6], [-9, 3, 4], [9, 4, 4.5], [22, 1, 3.5], [-22, 2, 3]] as [number, number, number][]) {
      cel(ctx, (c) => pEll(c, x * (0.6 + 0.4 * d), y, r, r * 0.65), '#b9ac90', { sd: 1.2, lw: 1.1 });
    }
    return;
  }
  const H = 82;
  const shiver = q.hit >= 0 && q.hit < 1 ? Math.sin(q.hit * 40) * (1 - q.hit) * 1.5 : 0;
  ctx.translate(shiver, 0);
  cel(ctx, (c) => { c.moveTo(-8.5, -11); c.lineTo(-7.8, -H); c.lineTo(7.8, -H); c.lineTo(8.5, -11); c.closePath(); }, stone, { sd: 1.8, lw: 1.6 });
  flat(ctx, (c) => c.rect(3, -H + 4, 4.6, H - 15), dark);
  for (const x of [-4, -0.5, 2.8]) line(ctx, [x, -13, x, -H + 5], 'rgba(70,55,40,0.5)', 0.9);
  // 柱头
  cel(ctx, (c) => c.rect(-11.5, -H - 7, 23, 7), '#cfc2a4', { sd: 1.2, lw: 1.3 });
  cel(ctx, (c) => { pEll(c, -10.5, -H - 3.5, 2.8, 2.8); pEll(c, 10.5, -H - 3.5, 2.8, 2.8); }, '#b9ac90', { sd: 0.8, lw: 1.1 });
  // 缠着的旧红布和一道裂纹
  cel(ctx, (c) => { c.moveTo(-8, -52); c.lineTo(8, -58); c.lineTo(8, -50); c.lineTo(-8, -44); c.closePath(); }, '#8a2a24', { sd: 1, lw: 1.1 });
  line(ctx, [-5, -30, -2, -26, -4, -21, 0, -16], 'rgba(40,30,24,0.8)', 1);
}

// SPECS: how each model is drawn and how it falls when it dies (fall is the
// direction it topples: -1 backward, +1 forward, 0 handles death itself).
const SPECS = {
  knight: { draw: drawKnight, fall: -1 },
  ranger: { draw: drawRanger, fall: -1 },
  guard: { draw: drawGuard, fall: -1 },
  villager: { draw: drawVillager, fall: -1 },
  slime: { draw: drawSlime, fall: 0 },
  wolf: { draw: drawWolf, fall: 0 },
  alpha_wolf: { draw: (ctx, q) => drawWolf(ctx, q, WOLF_STYLES.alpha_wolf), fall: 0 },
  wolf_king: { draw: (ctx, q) => drawWolf(ctx, q, WOLF_STYLES.wolf_king), fall: 0 },
  hunter: { draw: drawHunter, fall: -1 },
  bramble: { draw: drawBramble, fall: 0 },
  skeleton_archer: { draw: drawSkeleton, fall: 0 },
  skeleton_soldier: { draw: (ctx, q) => drawSkeletonWarrior(ctx, q, SOLDIER_STYLE), fall: 0 },
  skeleton_knight: { draw: (ctx, q) => drawSkeletonWarrior(ctx, q, KNIGHT_STYLE), fall: 0 },
  bone_pile: { draw: drawBonePileAlive, fall: 0 },
  bone_statue: { draw: drawBoneStatue, fall: 0 },
  brazier: { draw: drawBrazier, fall: 0, keep: true },
  cracked_wall: { draw: drawCrackedWall, fall: 0 },
  stone_pillar: { draw: drawStonePillar, fall: 0, keep: true },
  ogre_chief: { draw: drawOgre, fall: 1 },
  wolf_pup: { draw: drawWolfPup, fall: 0 },
  ember: { draw: drawEmber, fall: 0 },
  sprout: { draw: drawSprout, fall: 0 },
  blob: { draw: drawBlob, fall: -1 },
};
