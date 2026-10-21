// Procedural character models. Everything is drawn with the Canvas 2D API in
// a small chibi style: soft ground shadow, dark outline, flat colour with one
// highlight and one shade.
//
// drawModel(ctx, model, p) draws one character with its feet at (p.x, p.y).
//   p.r       collision radius; the drawing scales with it
//   p.color   base colour from config
//   p.facing  radians, 0 = right, PI/2 = down
//   p.walk    walk-cycle phase in radians (advanced by distance travelled)
//   p.moving  whether the walk cycle should show
//   p.attack  -1, or 0..1 progress of an attack swing
//   p.hit     -1, or 0..1 progress of a hit reaction
//   p.dead    -1, or 0..1 progress of the death animation (stays at 1)
//   p.time    ms clock for idle motion
//   p.isSelf  draw the own-player ground ring
//   p.bare    skip the ground ring and shadow (ink.js draws the model alone)

const TAU = Math.PI * 2;
const OUTLINE = '#0b0710';

export const MODELS = ['knight', 'slime', 'wolf', 'skeleton_archer', 'ogre_chief', 'guard', 'villager'];

/* ------------------------------ colour ------------------------------ */

const shadeCache = new Map();

// shade lightens (amt > 0) or darkens (amt < 0) a #rrggbb colour.
function shade(hex, amt) {
  const key = hex + amt;
  let out = shadeCache.get(key);
  if (out) return out;
  let r, g, b;
  const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(hex);
  if (m) {
    r = +m[1]; g = +m[2]; b = +m[3];   // already shaded once
  } else {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map((ch) => ch + ch).join('');
    const n = parseInt(c, 16);
    r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
  }
  if (amt >= 0) {
    r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt;
  } else {
    r *= 1 + amt; g *= 1 + amt; b *= 1 + amt;
  }
  out = `rgb(${r | 0},${g | 0},${b | 0})`;
  shadeCache.set(key, out);
  return out;
}

function safeColor(c, fallback) {
  return typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c) ? c : fallback;
}

/* ----------------------------- helpers ------------------------------ */

const ease = (t) => 1 - (1 - t) * (1 - t);
const clamp01 = (t) => Math.max(0, Math.min(1, t));

function rrect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fillStroke(ctx, fill, lw = 1.7) {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
}

function ellipse(ctx, x, y, rx, ry, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, TAU);
}

function limb(ctx, x0, y0, len, ang, w, color) {
  const x1 = x0 + Math.sin(ang) * len;
  const y1 = y0 + Math.cos(ang) * len;
  ctx.lineCap = 'round';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = w + 2.4;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.stroke();
  return { x: x1, y: y1 };
}

// swing maps attack progress to a weapon angle: wind up, strike, recover.
function swing(attack, rest, back, strike) {
  if (attack < 0) return rest;
  if (attack < 0.3) return rest + (back - rest) * ease(attack / 0.3);
  if (attack < 0.55) return back + (strike - back) * ease((attack - 0.3) / 0.25);
  return strike + (rest - strike) * ease((attack - 0.55) / 0.45);
}

/* ------------------------------ entry ------------------------------- */

export function drawModel(ctx, model, p) {
  const s = (p.r || 14) / 16;
  const dir = Math.cos(p.facing || 0) < -0.1 ? -1 : 1;
  const dead = p.dead >= 0 ? ease(clamp01(p.dead)) : -1;
  const hit = p.hit >= 0 && p.hit < 1 ? p.hit : -1;

  ctx.save();
  ctx.translate(p.x, p.y);

  if (p.isSelf && dead < 0 && !p.bare) {
    const pulse = 0.5 + 0.5 * Math.sin(p.time / 300);
    ctx.strokeStyle = `rgba(255,214,90,${0.45 + 0.3 * pulse})`;
    ctx.lineWidth = 2;
    ellipse(ctx, 0, 0, (p.r + 8) * 1.1, (p.r + 8) * 0.45);
    ctx.stroke();
  }

  // ground shadow
  if (!p.bare) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ellipse(ctx, 0, 0, p.r * 1.05, p.r * 0.42);
    ctx.fill();
  }

  // hit reaction: knock back away from facing and shake
  if (hit >= 0) {
    const k = 1 - hit;
    ctx.translate(-dir * 4 * k + Math.sin(hit * 50) * 1.5 * k, 0);
  }
  // death: fall over sideways and fade
  if (dead >= 0) {
    ctx.globalAlpha *= 1 - 0.55 * dead;
    if (model !== 'slime') ctx.rotate(-dir * dead * Math.PI * 0.45);
  }

  ctx.scale(dir * s, s);
  const q = { ...p, s, dir, dead, hit };
  const fn = DRAW[model] || drawBlob;
  fn(ctx, q);

  if (hit >= 0 && hit < 0.4) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.35 * (1 - hit / 0.4);
    ctx.fillStyle = '#ffffff';
    ellipse(ctx, 0, -16, 13, 17);
    ctx.fill();
  }
  ctx.restore();
}

const DRAW = {
  knight: drawKnight,
  guard: drawGuard,
  villager: drawVillager,
  slime: drawSlime,
  wolf: drawWolf,
  skeleton_archer: drawSkeleton,
  ogre_chief: drawOgre,
};

/* ----------------------------- humanoid ----------------------------- */

// rig draws a small humanoid. opts supplies colours and part painters; the
// body is drawn in local units where the feet are at y = 0 and the head
// centre around y = -34 (before scaling by r/16).
function rig(ctx, q, opts) {
  const moving = q.moving && q.dead < 0;
  const ph = q.walk || 0;
  const bob = moving ? Math.abs(Math.sin(ph)) * 2 : Math.sin(q.time / 450) * 0.6;
  const swingLeg = moving ? Math.sin(ph) * 0.55 : 0;
  const swingArm = moving ? Math.sin(ph) * 0.5 : Math.sin(q.time / 700) * 0.05;
  const hipY = -12;
  const shoulderY = -26 - bob;

  if (opts.back) opts.back(ctx, q, shoulderY, bob);

  // legs
  limb(ctx, -3, hipY - bob * 0.5, 12, -swingLeg, 4.2, opts.legs);
  limb(ctx, 3, hipY - bob * 0.5, 12, swingLeg, 4.2, shade(opts.legs, -0.15));
  // boots
  ctx.fillStyle = opts.boots || '#3b2a20';
  for (const [x, a] of [[-3, -swingLeg], [3, swingLeg]]) {
    const fx = x + Math.sin(a) * 12;
    const fy = hipY - bob * 0.5 + Math.cos(a) * 12;
    ellipse(ctx, fx + 1.5, fy, 3.6, 2.2);
    ctx.fill();
  }

  // rear arm (off hand)
  const rear = limb(ctx, -6, shoulderY + 2, 10, opts.rearArm ?? (0.25 - swingArm), 3.6, shade(opts.body, -0.2));
  if (opts.offhand) opts.offhand(ctx, q, rear);

  // torso
  rrect(ctx, -8, shoulderY - 1, 16, 16 + bob * 0.5, 5);
  fillStroke(ctx, opts.body);
  ctx.fillStyle = shade(opts.body, 0.25);
  rrect(ctx, -6, shoulderY + 1, 6, 9, 3);
  ctx.fill();
  if (opts.torso) opts.torso(ctx, q, shoulderY);

  // head
  const headY = shoulderY - 8;
  ellipse(ctx, 1, headY, 7.5, 7.5);
  fillStroke(ctx, opts.skin || '#f2c9a0');
  if (opts.head) opts.head(ctx, q, headY);

  // front arm with weapon
  const armAng = opts.armAngle ? opts.armAngle(q, swingArm) : swingArm * -1 + 0.3;
  const hand = limb(ctx, 6, shoulderY + 2, 10, armAng, 3.8, opts.body);
  ctx.fillStyle = opts.skin || '#f2c9a0';
  ellipse(ctx, hand.x, hand.y, 2.4, 2.4);
  ctx.fill();
  if (opts.weapon) opts.weapon(ctx, q, hand, armAng);
}

function eyes(ctx, x, y, color = '#1a1420') {
  ctx.fillStyle = color;
  ellipse(ctx, x, y, 1.2, 1.6);
  ctx.fill();
  ellipse(ctx, x + 3.6, y, 1.2, 1.6);
  ctx.fill();
}

/* ------------------------------ knight ------------------------------ */

function drawKnight(ctx, q) {
  const color = safeColor(q.color, '#4da3ff');
  const steel = '#c7d0da';
  rig(ctx, q, {
    legs: '#5b6472',
    boots: '#2e333c',
    body: color,
    skin: '#f2c9a0',
    back(ctx, q, sy) {
      // cape fluttering behind
      const flutter = Math.sin(q.time / 220 + (q.walk || 0)) * 2.5;
      ctx.beginPath();
      ctx.moveTo(-5, sy + 1);
      ctx.quadraticCurveTo(-14 - flutter, sy + 10, -12 - flutter * 1.5, sy + 22);
      ctx.lineTo(-3, sy + 18);
      ctx.closePath();
      fillStroke(ctx, shade(color, -0.45));
    },
    torso(ctx, q, sy) {
      // breastplate and belt
      ctx.fillStyle = steel;
      rrect(ctx, -2, sy + 1, 9, 8, 3);
      ctx.fill();
      ctx.fillStyle = '#5a3a1e';
      ctx.fillRect(-8, sy + 11, 16, 2.5);
      ctx.fillStyle = '#ffd34d';
      ctx.fillRect(-1, sy + 10.6, 3, 3.2);
    },
    head(ctx, q, hy) {
      // helmet with visor and plume
      ctx.beginPath();
      ctx.arc(1, hy, 8.3, Math.PI * 1.02, Math.PI * 2.02);
      ctx.lineTo(9, hy + 2.5);
      ctx.lineTo(-7, hy + 2.5);
      ctx.closePath();
      fillStroke(ctx, steel);
      ctx.fillStyle = '#2b2f38';
      ctx.fillRect(2, hy - 1.5, 6.5, 2);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ellipse(ctx, -2, hy - 5, 2.4, 1.4, -0.4);
      ctx.fill();
      const sway = Math.sin(q.time / 260) * 1.5;
      ctx.beginPath();
      ctx.moveTo(0, hy - 8);
      ctx.quadraticCurveTo(-6 + sway, hy - 16, -11 + sway, hy - 9);
      ctx.quadraticCurveTo(-5, hy - 10, 0, hy - 7);
      fillStroke(ctx, shade(color, 0.1), 1.1);
    },
    offhand(ctx, q, hand) {
      // round shield
      ellipse(ctx, hand.x - 2, hand.y - 4, 6.5, 8);
      fillStroke(ctx, shade(color, -0.25));
      ellipse(ctx, hand.x - 2, hand.y - 4, 3.6, 4.6);
      ctx.fillStyle = '#ffd34d';
      ctx.fill();
    },
    armAngle(q, sa) {
      return swing(q.attack, 0.9 - sa * 0.4, -2.5, 1.7);
    },
    weapon(ctx, q, hand, ang) {
      // sword along the arm direction
      const dx = Math.sin(ang);
      const dy = Math.cos(ang);
      ctx.lineCap = 'round';
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 4.6;
      ctx.beginPath();
      ctx.moveTo(hand.x, hand.y);
      ctx.lineTo(hand.x + dx * 19, hand.y + dy * 19);
      ctx.stroke();
      ctx.strokeStyle = '#eef3f8';
      ctx.lineWidth = 2.6;
      ctx.stroke();
      // crossguard
      ctx.strokeStyle = '#c9a227';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(hand.x - dy * 4, hand.y + dx * 4);
      ctx.lineTo(hand.x + dy * 4, hand.y - dx * 4);
      ctx.stroke();
      if (q.attack >= 0.3 && q.attack < 0.65) {
        // swing trail
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.5 * (1 - Math.abs(q.attack - 0.45) / 0.2);
        ctx.strokeStyle = '#fff6c8';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(6, -24, 26, -1.9, 0.4);
        ctx.stroke();
        ctx.restore();
      }
    },
  });
}

/* ------------------------------ guard ------------------------------- */

function drawGuard(ctx, q) {
  const color = safeColor(q.color, '#3b82f6');
  const steel = '#b9c2cc';
  rig(ctx, q, {
    legs: '#4a4f5a',
    boots: '#2a2d33',
    body: color,
    torso(ctx, q, sy) {
      // tabard with a gold stripe
      ctx.fillStyle = shade(color, -0.25);
      ctx.fillRect(-4, sy + 2, 8, 14);
      ctx.fillStyle = '#ffd34d';
      ctx.fillRect(-0.8, sy + 2, 1.6, 14);
    },
    head(ctx, q, hy) {
      // conical kettle helmet with a brim
      ctx.beginPath();
      ctx.moveTo(-8, hy - 1);
      ctx.lineTo(1, hy - 13);
      ctx.lineTo(10, hy - 1);
      ctx.closePath();
      fillStroke(ctx, steel);
      ellipse(ctx, 1, hy - 1, 11, 2.6);
      fillStroke(ctx, shade(steel, -0.1), 1.1);
      eyes(ctx, 2, hy + 2);
    },
    offhand(ctx, q, hand) {
      // kite shield
      ctx.beginPath();
      ctx.moveTo(hand.x - 8, hand.y - 12);
      ctx.lineTo(hand.x + 4, hand.y - 12);
      ctx.lineTo(hand.x + 3, hand.y + 2);
      ctx.lineTo(hand.x - 2, hand.y + 8);
      ctx.lineTo(hand.x - 7, hand.y + 2);
      ctx.closePath();
      fillStroke(ctx, color);
      ctx.fillStyle = '#ffd34d';
      ctx.fillRect(hand.x - 2.8, hand.y - 10, 1.6, 14);
      ctx.fillRect(hand.x - 6.5, hand.y - 5, 9, 1.6);
    },
    armAngle(q) {
      return 1.45;
    },
    weapon(ctx, q, hand) {
      // spear held level; thrust forward on attack
      let thrust = 0;
      if (q.attack >= 0) {
        thrust = q.attack < 0.25 ? -5 * ease(q.attack / 0.25)
          : q.attack < 0.5 ? -5 + 19 * ease((q.attack - 0.25) / 0.25)
            : 14 * (1 - ease((q.attack - 0.5) / 0.5));
      }
      const x0 = hand.x - 14 + thrust;
      const x1 = hand.x + 22 + thrust;
      const y = hand.y - 1;
      ctx.lineCap = 'round';
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.strokeStyle = '#8a5a2b';
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x1 - 1, y - 3.5);
      ctx.lineTo(x1 + 8, y);
      ctx.lineTo(x1 - 1, y + 3.5);
      ctx.closePath();
      fillStroke(ctx, '#e6ecf2', 1.1);
    },
  });
}

/* ----------------------------- villager ----------------------------- */

function drawVillager(ctx, q) {
  const color = safeColor(q.color, '#f4c27a');
  rig(ctx, q, {
    legs: '#6b5440',
    boots: '#4a3424',
    body: shade(color, -0.1),
    torso(ctx, q, sy) {
      // apron
      ctx.fillStyle = '#f3ece0';
      rrect(ctx, -4, sy + 6, 9, 10, 2);
      ctx.fill();
    },
    head(ctx, q, hy) {
      ctx.fillStyle = '#7a4a24';
      ctx.beginPath();
      ctx.arc(0, hy - 1, 7.4, Math.PI, Math.PI * 1.9);
      ctx.fill();
      eyes(ctx, 2.5, hy + 0.5);
      ctx.fillStyle = 'rgba(230,110,110,0.55)';
      ellipse(ctx, 6.5, hy + 3, 1.6, 1.1);
      ctx.fill();
      // straw hat
      ellipse(ctx, 1, hy - 5, 11, 3);
      fillStroke(ctx, '#e8c76a', 1.1);
      ctx.beginPath();
      ctx.arc(1, hy - 6, 5.5, Math.PI, TAU);
      fillStroke(ctx, '#e2bd5c', 1.1);
      ctx.fillStyle = '#c0533a';
      ctx.fillRect(-4.4, hy - 7.5, 10.8, 1.6);
    },
    armAngle(q, sa) {
      return q.moving ? 0.4 - sa * 0.9 : 0.25 + Math.sin(q.time / 500) * 0.08;
    },
  });
}

/* ------------------------------- slime ------------------------------ */

function drawSlime(ctx, q) {
  const color = safeColor(q.color, '#6ccf6c');
  const t = q.time / 1000;
  let hop = 0;
  let sx = 1 + Math.sin(t * 3) * 0.04;
  let sy = 1 - Math.sin(t * 3) * 0.04;
  if (q.moving && q.dead < 0) {
    const ph = Math.abs(Math.sin(q.walk || 0));
    hop = ph * 7;
    sx = 1 - ph * 0.12 + (1 - ph) * 0.1;
    sy = 1 + ph * 0.16 - (1 - ph) * 0.1;
  }
  let lunge = 0;
  if (q.attack >= 0) {
    const a = q.attack;
    lunge = Math.sin(a * Math.PI) * 9;
    sx *= 1 + Math.sin(a * Math.PI) * 0.25;
    sy *= 1 - Math.sin(a * Math.PI) * 0.15;
  }
  if (q.dead >= 0) {
    // splat
    sx = 1 + q.dead * 0.7;
    sy = Math.max(0.25, 1 - q.dead * 0.75);
    hop = 0;
  }
  const w = 15 * sx;
  const h = 13 * sy;
  const cy = -h - hop;

  ctx.save();
  ctx.translate(lunge, 0);
  // body
  ctx.beginPath();
  ctx.moveTo(-w, -hop);
  ctx.bezierCurveTo(-w * 1.05, cy - h * 0.2, -w * 0.55, cy - h, 0, cy - h);
  ctx.bezierCurveTo(w * 0.55, cy - h, w * 1.05, cy - h * 0.2, w, -hop);
  ctx.quadraticCurveTo(0, -hop + 3, -w, -hop);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, cy - h, 0, -hop);
  g.addColorStop(0, shade(color, 0.35));
  g.addColorStop(1, shade(color, -0.3));
  ctx.globalAlpha *= 0.92;
  fillStroke(ctx, g, 1.5);
  ctx.globalAlpha /= 0.92;
  // inner core
  ctx.fillStyle = shade(color, -0.15);
  ctx.globalAlpha *= 0.35;
  ellipse(ctx, 2, cy + h * 0.25, w * 0.35, h * 0.3);
  ctx.fill();
  ctx.globalAlpha /= 0.35;
  // highlight
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ellipse(ctx, -w * 0.45, cy - h * 0.45, w * 0.22, h * 0.14, -0.5);
  ctx.fill();
  if (q.dead < 0) {
    // eyes look forward
    ctx.fillStyle = '#1a2a1a';
    ellipse(ctx, w * 0.25, cy - h * 0.05, 1.8, 2.6);
    ctx.fill();
    ellipse(ctx, w * 0.62, cy - h * 0.05, 1.8, 2.6);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ellipse(ctx, w * 0.25 + 0.6, cy - h * 0.05 - 1, 0.7, 0.8);
    ctx.fill();
    ellipse(ctx, w * 0.62 + 0.6, cy - h * 0.05 - 1, 0.7, 0.8);
    ctx.fill();
    ctx.strokeStyle = '#1a2a1a';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (q.attack >= 0) {
      ellipse(ctx, w * 0.45, cy + h * 0.3, 2.6, 2.2);
      ctx.fillStyle = '#3a1020';
      ctx.fill();
    } else {
      ctx.arc(w * 0.45, cy + h * 0.2, 2.2, 0.2, Math.PI - 0.2);
      ctx.stroke();
    }
  } else {
    ctx.strokeStyle = '#1a2a1a';
    ctx.lineWidth = 1.3;
    for (const ex of [w * 0.2, w * 0.6]) {
      ctx.beginPath();
      ctx.moveTo(ex - 1.8, cy - 1.8);
      ctx.lineTo(ex + 1.8, cy + 1.8);
      ctx.moveTo(ex + 1.8, cy - 1.8);
      ctx.lineTo(ex - 1.8, cy + 1.8);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/* ------------------------------- wolf ------------------------------- */

function drawWolf(ctx, q) {
  const color = safeColor(q.color, '#9a9a9a');
  const dark = shade(color, -0.35);
  const light = shade(color, 0.35);
  const moving = q.moving && q.dead < 0;
  const ph = q.walk || 0;
  const gallop = moving ? Math.sin(ph) : 0;
  const bob = moving ? Math.abs(Math.cos(ph)) * 2 : Math.sin(q.time / 500) * 0.5;
  let lunge = 0;
  let jaw = 0;
  if (q.attack >= 0) {
    lunge = Math.sin(q.attack * Math.PI) * 8;
    jaw = Math.sin(q.attack * Math.PI) * 0.6;
  }
  const by = -15 - bob;

  // tail
  const wag = Math.sin(q.time / 160) * (moving ? 0.2 : 0.45);
  ctx.save();
  ctx.translate(-13, by - 2);
  ctx.rotate(-0.7 + wag);
  ellipse(ctx, -7, 0, 9, 3.4);
  fillStroke(ctx, color);
  ctx.fillStyle = light;
  ellipse(ctx, -13, 0, 3, 2.2);
  ctx.fill();
  ctx.restore();

  // legs: back pair darker
  const legs = [[-9, gallop * 0.6, dark], [7, -gallop * 0.6, dark], [-6, -gallop * 0.6, color], [10, gallop * 0.6, color]];
  for (const [x, a, c] of legs) limb(ctx, x, by + 4, 11 + bob * 0.5, a, 3.4, c);

  // body
  ctx.save();
  ctx.translate(lunge * 0.4, 0);
  ellipse(ctx, 0, by, 15, 8);
  fillStroke(ctx, color);
  ctx.fillStyle = dark;
  ellipse(ctx, -2, by - 5, 11, 3, 0.05);
  ctx.fill();
  ctx.fillStyle = light;
  ellipse(ctx, 3, by + 4, 8, 3);
  ctx.fill();
  ctx.restore();

  // head
  ctx.save();
  ctx.translate(13 + lunge, by - 5);
  // ears
  for (const [ex, c] of [[-3, dark], [1.5, color]]) {
    ctx.beginPath();
    ctx.moveTo(ex - 2.5, -4);
    ctx.lineTo(ex, -12);
    ctx.lineTo(ex + 3, -4);
    ctx.closePath();
    fillStroke(ctx, c, 1.1);
  }
  ellipse(ctx, 0, 0, 7, 6);
  fillStroke(ctx, color);
  // snout + jaw
  ctx.save();
  ctx.translate(5, 2);
  ctx.rotate(jaw);
  ellipse(ctx, 4, 1.8, 5, 2);
  fillStroke(ctx, light, 1.1);
  ctx.restore();
  ellipse(ctx, 6, 0.5, 6, 3);
  fillStroke(ctx, light, 1.1);
  ctx.fillStyle = '#1b1b1b';
  ellipse(ctx, 11.5, -0.2, 1.6, 1.3);
  ctx.fill();
  // eye: glows when aggressive
  ctx.fillStyle = q.attack >= 0 ? '#ff4d3a' : '#ffd23a';
  ellipse(ctx, 2, -2, 1.5, 1.3);
  ctx.fill();
  ctx.restore();
}

/* ------------------------------ skeleton ---------------------------- */

function drawSkeleton(ctx, q) {
  const bone = '#ece6d4';
  const boneDark = '#b9b19a';
  const moving = q.moving && q.dead < 0;
  const ph = q.walk || 0;
  const swingLeg = moving ? Math.sin(ph) * 0.5 : 0;
  const bob = moving ? Math.abs(Math.sin(ph)) * 1.6 : Math.sin(q.time / 600) * 0.5;
  const hipY = -12 - bob * 0.5;
  const sy = -26 - bob;

  // legs
  limb(ctx, -2.5, hipY, 12, -swingLeg, 2.4, boneDark);
  limb(ctx, 2.5, hipY, 12, swingLeg, 2.4, bone);
  // tattered hood cloak
  ctx.beginPath();
  ctx.moveTo(-6, sy - 4);
  ctx.lineTo(-9, sy + 14);
  ctx.lineTo(-6, sy + 11);
  ctx.lineTo(-3, sy + 15);
  ctx.lineTo(-1, sy + 6);
  ctx.closePath();
  fillStroke(ctx, '#3b3550', 1.1);
  // spine + pelvis
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 4.2;
  ctx.beginPath();
  ctx.moveTo(0, sy);
  ctx.lineTo(0, hipY);
  ctx.stroke();
  ctx.strokeStyle = bone;
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ellipse(ctx, 0, hipY, 5, 2.4);
  fillStroke(ctx, bone, 1.1);
  // ribs
  for (let i = 0; i < 3; i++) {
    const y = sy + 3 + i * 3.2;
    ellipse(ctx, 0, y, 6 - i, 1.4);
    fillStroke(ctx, bone, 1);
  }
  // skull
  const hy = sy - 7;
  ellipse(ctx, 1, hy, 7, 6.6);
  fillStroke(ctx, bone);
  rrect(ctx, 2, hy + 3, 6, 4, 1.5);
  fillStroke(ctx, bone, 1);
  const glow = q.dead < 0 ? (0.6 + 0.4 * Math.sin(q.time / 200)) : 0;
  ctx.fillStyle = '#16121c';
  ellipse(ctx, 2.6, hy - 0.5, 1.8, 2.1);
  ctx.fill();
  ellipse(ctx, 6.6, hy - 0.5, 1.6, 2);
  ctx.fill();
  if (glow) {
    ctx.fillStyle = `rgba(255,70,60,${glow})`;
    ellipse(ctx, 2.8, hy - 0.4, 0.9, 1);
    ctx.fill();
    ellipse(ctx, 6.7, hy - 0.4, 0.8, 0.9);
    ctx.fill();
  }

  // bow arm: held forward; string pulls back on attack
  let draw = 0;
  if (q.attack >= 0) draw = q.attack < 0.55 ? ease(q.attack / 0.55) : 0;
  const hand = limb(ctx, 4, sy + 2, 10, 1.45, 2.2, bone);
  limb(ctx, -2, sy + 2, 7, 1.3, 2.2, boneDark);
  // bow
  const bx = hand.x + 1;
  const by = hand.y;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 3.6;
  ctx.beginPath();
  ctx.arc(bx - 4, by, 11, -1.15, 1.15);
  ctx.stroke();
  ctx.strokeStyle = '#7a4e2a';
  ctx.lineWidth = 2;
  ctx.stroke();
  const tx = bx - 4 + Math.cos(-1.15) * 11;
  const ty1 = by + Math.sin(-1.15) * 11;
  const ty2 = by + Math.sin(1.15) * 11;
  const pull = bx - 2 - draw * 9;
  ctx.strokeStyle = 'rgba(240,240,230,0.9)';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(tx, ty1);
  ctx.lineTo(pull, by);
  ctx.lineTo(tx, ty2);
  ctx.stroke();
  if (draw > 0 || q.attack < 0) {
    // nocked arrow
    ctx.strokeStyle = '#d9cfb0';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(pull, by);
    ctx.lineTo(pull + 16, by);
    ctx.stroke();
    ctx.fillStyle = '#cfd6dd';
    ctx.beginPath();
    ctx.moveTo(pull + 16, by - 2);
    ctx.lineTo(pull + 20, by);
    ctx.lineTo(pull + 16, by + 2);
    ctx.fill();
  }
}

/* -------------------------------- ogre ------------------------------ */

function drawOgre(ctx, q) {
  const accent = safeColor(q.color, '#c0392b');
  const skin = '#7f9a4c';
  const skinDark = shade(skin, -0.3);
  const moving = q.moving && q.dead < 0;
  const ph = q.walk || 0;
  const swingLeg = moving ? Math.sin(ph) * 0.4 : 0;
  const bob = moving ? Math.abs(Math.sin(ph)) * 1.5 : Math.sin(q.time / 650) * 0.8;
  const sy = -27 - bob;

  // legs (short and thick)
  limb(ctx, -4, -11, 10, -swingLeg, 6.5, skinDark);
  limb(ctx, 4, -11, 10, swingLeg, 6.5, skin);

  // rear arm
  limb(ctx, -10, sy + 4, 11, 0.3 - swingLeg, 5.5, skinDark);

  // belly
  ellipse(ctx, 0, sy + 8, 13, 12);
  fillStroke(ctx, skin, 1.6);
  ctx.fillStyle = shade(skin, 0.2);
  ellipse(ctx, 3, sy + 11, 7, 6);
  ctx.fill();
  // loincloth + belt with skull buckle
  ctx.beginPath();
  ctx.moveTo(-11, sy + 15);
  ctx.lineTo(11, sy + 15);
  ctx.lineTo(7, sy + 24);
  ctx.lineTo(-7, sy + 24);
  ctx.closePath();
  fillStroke(ctx, accent, 1.2);
  ctx.fillStyle = '#4a2e1a';
  ctx.fillRect(-12, sy + 13, 24, 3);
  ellipse(ctx, 1, sy + 14.5, 2.4, 2.2);
  ctx.fillStyle = '#ece6d4';
  ctx.fill();
  // shoulder pad
  ellipse(ctx, -7, sy - 1, 7, 4.5, -0.3);
  fillStroke(ctx, '#6b6f78', 1.2);
  ctx.fillStyle = '#d8dce2';
  for (const sx of [-10, -6]) {
    ctx.beginPath();
    ctx.moveTo(sx - 1.5, sy - 4);
    ctx.lineTo(sx, sy - 9);
    ctx.lineTo(sx + 1.5, sy - 4);
    ctx.fill();
  }

  // head
  const hy = sy - 5;
  ellipse(ctx, 4, hy, 7, 6);
  fillStroke(ctx, skin, 1.4);
  // brow and eyes
  ctx.fillStyle = skinDark;
  ctx.fillRect(1, hy - 3.5, 9, 2);
  ctx.fillStyle = q.attack >= 0 || q.dead < 0 ? '#ffde3b' : '#888';
  ellipse(ctx, 5, hy - 1, 1.2, 1);
  ctx.fill();
  ellipse(ctx, 8.5, hy - 1, 1.2, 1);
  ctx.fill();
  // tusks
  ctx.fillStyle = '#f4efe1';
  for (const tx of [4.5, 8.5]) {
    ctx.beginPath();
    ctx.moveTo(tx - 1, hy + 3);
    ctx.lineTo(tx, hy - 0.5);
    ctx.lineTo(tx + 1, hy + 3);
    ctx.fill();
  }
  // horned helmet
  ctx.beginPath();
  ctx.arc(4, hy - 2, 7.2, Math.PI, TAU);
  fillStroke(ctx, '#6b6f78', 1.2);
  for (const [hx, d] of [[-2, -1], [10, 1]]) {
    ctx.beginPath();
    ctx.moveTo(hx, hy - 3);
    ctx.quadraticCurveTo(hx + d * 5, hy - 6, hx + d * 4, hy - 13);
    ctx.quadraticCurveTo(hx + d * 2, hy - 7, hx - d * 1, hy - 5);
    ctx.closePath();
    fillStroke(ctx, '#efe7d2', 1);
  }

  // club arm: raised overhead then smashed down
  const ang = swing(q.attack, 1.0, -2.8, 1.6);
  const hand = limb(ctx, 10, sy + 3, 11, ang, 5.8, skin);
  const dx = Math.sin(ang);
  const dy = Math.cos(ang);
  ctx.save();
  ctx.translate(hand.x, hand.y);
  ctx.rotate(-ang + Math.PI);
  // club: handle + spiked head
  rrect(ctx, -2, -4, 4, 14, 2);
  fillStroke(ctx, '#6e4524', 1.2);
  ctx.beginPath();
  ctx.moveTo(-3, -4);
  ctx.quadraticCurveTo(-7, -14, -4, -24);
  ctx.quadraticCurveTo(0, -28, 4, -24);
  ctx.quadraticCurveTo(7, -14, 3, -4);
  ctx.closePath();
  fillStroke(ctx, '#8a5a2b', 1.3);
  ctx.fillStyle = '#d8dce2';
  for (const [sx2, sy2, d] of [[-5, -14, -1], [5, -16, 1], [-4, -21, -1], [4, -22, 1]]) {
    ctx.beginPath();
    ctx.moveTo(sx2, sy2 - 1.5);
    ctx.lineTo(sx2 + d * 3.5, sy2);
    ctx.lineTo(sx2, sy2 + 1.5);
    ctx.fill();
  }
  ctx.restore();
  if (q.attack >= 0.5 && q.attack < 0.75) {
    // ground impact dust
    const k = (q.attack - 0.5) / 0.25;
    ctx.strokeStyle = `rgba(230,210,170,${0.7 * (1 - k)})`;
    ctx.lineWidth = 2;
    ellipse(ctx, hand.x + dx * 18, -1, 6 + k * 16, 2 + k * 5);
    ctx.stroke();
  }
  void dy;
}

/* ------------------------------ fallback ---------------------------- */

function drawBlob(ctx, q) {
  const color = safeColor(q.color, '#cccccc');
  const bob = q.moving ? Math.abs(Math.sin(q.walk || 0)) * 3 : Math.sin(q.time / 400) * 0.8;
  ellipse(ctx, 0, -13 - bob, 13, 13);
  fillStroke(ctx, color);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ellipse(ctx, -4, -18 - bob, 4, 2.5, -0.5);
  ctx.fill();
  eyes(ctx, 3, -14 - bob);
}
