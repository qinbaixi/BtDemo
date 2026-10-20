// World scenery: a painted ground layer plus props (trees, houses, tombs,
// tents...) that the main renderer depth-sorts together with the characters.
//
// The layout is generated from a fixed seed and the zones in config
// (village, slime meadow, wolf forest, graveyard, ogre camp), so every client
// sees the same world. The ground is painted once into an offscreen canvas;
// static props are cached as sprites; only fire, smoke and fog animate.

const TAU = Math.PI * 2;
const OUTLINE = 'rgba(22,18,26,0.8)';
const SPRITE_SCALE = 2;      // sprite resolution relative to world units

/* ------------------------------ layout ------------------------------ */

// Zone centres follow config/monsters.yaml spawns.
const ZONES = {
  village: { x: 540, y: 770 },
  meadow: { x: 1000, y: 920 },
  forest: { x: 900, y: 330 },
  graveyard: { x: 1600, y: 800 },
  camp: { x: 2050, y: 1300 },
};

// Dirt roads linking the zones, as polylines.
const ROADS = [
  [[540, 790], [700, 820], [860, 880], [1000, 920]],
  [[1000, 920], [1180, 880], [1360, 820], [1520, 800]],
  [[1600, 860], [1700, 1000], [1840, 1140], [1960, 1260]],
  [[600, 700], [680, 560], [790, 440], [880, 360]],
  [[100, 760], [260, 780], [420, 790]],
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function roadDist(x, y) {
  let best = Infinity;
  for (const r of ROADS) {
    for (let i = 1; i < r.length; i++) {
      best = Math.min(best, distToSeg(x, y, r[i - 1][0], r[i - 1][1], r[i][0], r[i][1]));
    }
  }
  return best;
}

const near = (x, y, z, r) => Math.hypot(x - z.x, y - z.y) < r;

/* ------------------------------ public ------------------------------ */

export function createScenery(mapW, mapH, seed = 20261020) {
  const rnd = mulberry32(seed);
  const ground = paintGround(mapW, mapH, mulberry32(seed ^ 0x5eed));
  const props = placeProps(mapW, mapH, rnd);
  const sprites = new Map();

  function sprite(p) {
    const key = p.kind + ':' + p.variant + ':' + p.s.toFixed(2) + ':' + (p.flip ? 1 : 0);
    let sp = sprites.get(key);
    if (sp) return sp;
    const def = KINDS[p.kind];
    const w = Math.ceil(def.w * p.s);
    const h = Math.ceil(def.h * p.s);
    const c = document.createElement('canvas');
    c.width = w * SPRITE_SCALE;
    c.height = h * SPRITE_SCALE;
    const g = c.getContext('2d');
    g.scale(SPRITE_SCALE, SPRITE_SCALE);
    g.translate(w / 2, h - def.foot * p.s);
    g.scale(p.s * (p.flip ? -1 : 1), p.s);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    def.draw(g, p.variant, mulberry32(p.variant * 977 + 13));
    sp = { canvas: c, w, h, ox: w / 2, oy: h - def.foot * p.s };
    sprites.set(key, sp);
    return sp;
  }

  return {
    props,

    drawGround(ctx, view) {
      const x0 = Math.max(0, Math.floor(view.x));
      const y0 = Math.max(0, Math.floor(view.y));
      const x1 = Math.min(mapW, Math.ceil(view.x + view.w));
      const y1 = Math.min(mapH, Math.ceil(view.y + view.h));
      if (x1 <= x0 || y1 <= y0) return;
      ctx.drawImage(ground, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    },

    // visible returns the props intersecting the view, for depth sorting.
    visible(view) {
      const out = [];
      for (const p of props) {
        const def = KINDS[p.kind];
        const hw = (def.w * p.s) / 2 + (p.dx ? Math.abs(p.dx) : 0);
        if (p.x + hw < view.x || p.x - hw > view.x + view.w) continue;
        if (p.dy && Math.abs(p.dy) > 0 && (p.y + Math.max(0, p.dy) < view.y - 40 || p.y + Math.min(0, p.dy) > view.y + view.h + 40)) continue;
        if (p.y - def.h * p.s > view.y + view.h || p.y + 20 < view.y) continue;
        out.push(p);
      }
      return out;
    },

    // drawProp draws one prop. focus is the own player's position: tall props
    // standing in front of it turn see-through so the player is never lost.
    drawProp(ctx, p, time, focus) {
      const def = KINDS[p.kind];
      ctx.save();
      if (focus && def.tall && focus.y < p.y - 4) {
        const hw = (def.w * p.s) / 2 - 6;
        if (Math.abs(focus.x - p.x) < hw && focus.y > p.y - def.h * p.s * 0.95) ctx.globalAlpha = 0.45;
      }
      if (def.live) {
        ctx.translate(p.x, p.y);
        ctx.scale(p.s, p.s);
        def.live(ctx, time, p);
      } else {
        const sp = sprite(p);
        ctx.drawImage(sp.canvas, p.x - sp.ox, p.y - sp.oy, sp.w, sp.h);
      }
      ctx.restore();
    },

    // drawAmbient adds the animated atmosphere above everything else:
    // graveyard fog, campfire light and fireflies.
    drawAmbient(ctx, view, time) {
      const g = ZONES.graveyard;
      if (Math.abs(g.x - (view.x + view.w / 2)) < view.w / 2 + 400 &&
          Math.abs(g.y - (view.y + view.h / 2)) < view.h / 2 + 400) {
        ctx.save();
        for (let i = 0; i < 9; i++) {
          const a = time / 9000 + i * 0.7;
          const x = g.x + Math.cos(a + i) * (120 + i * 18);
          const y = g.y + Math.sin(a * 1.3 + i * 2) * 90 + 20;
          const r = 90 + (i % 3) * 30;
          const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
          grad.addColorStop(0, 'rgba(176,170,210,0.13)');
          grad.addColorStop(1, 'rgba(176,170,210,0)');
          ctx.fillStyle = grad;
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
        ctx.restore();
      }
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const f of FIRES) {
        if (f.x < view.x - 300 || f.x > view.x + view.w + 300 || f.y < view.y - 300 || f.y > view.y + view.h + 300) continue;
        const flick = 1 + Math.sin(time / 90 + f.x) * 0.05 + Math.sin(time / 37) * 0.03;
        const r = f.light * flick;
        const grad = ctx.createRadialGradient(f.x, f.y - 10, 0, f.x, f.y - 10, r);
        grad.addColorStop(0, 'rgba(255,170,80,0.28)');
        grad.addColorStop(0.5, 'rgba(255,120,40,0.08)');
        grad.addColorStop(1, 'rgba(255,100,30,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(f.x - r, f.y - 10 - r, r * 2, r * 2);
      }
      // fireflies over the meadow and the forest edge
      for (let i = 0; i < 28; i++) {
        const z = i % 2 ? ZONES.meadow : ZONES.forest;
        const x = z.x + Math.sin(time / 2300 + i * 1.7) * 220 + Math.sin(i * 12.9) * 120;
        const y = z.y + Math.cos(time / 2900 + i * 2.3) * 140 + Math.cos(i * 7.1) * 60;
        if (x < view.x || x > view.x + view.w || y < view.y || y > view.y + view.h) continue;
        const a = 0.35 + 0.35 * Math.sin(time / 300 + i * 3);
        ctx.globalAlpha = a;
        ctx.drawImage(fireflySprite(), x - 7, y - 7, 14, 14);
      }
      ctx.restore();
    },
  };
}

let firefly = null;

function fireflySprite() {
  if (firefly) return firefly;
  firefly = document.createElement('canvas');
  firefly.width = firefly.height = 28;
  const g = firefly.getContext('2d');
  const grad = g.createRadialGradient(14, 14, 0, 14, 14, 14);
  grad.addColorStop(0, 'rgba(230,255,150,1)');
  grad.addColorStop(1, 'rgba(230,255,150,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 28, 28);
  return firefly;
}

/* ------------------------------ ground ------------------------------ */

function blob(g, x, y, r, inner, outer) {
  const grad = g.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(x - r, y - r, r * 2, r * 2);
}

function paintGround(W, H, rnd) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  // base grass with broad light/dark variation
  g.fillStyle = '#3f6b37';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 140; i++) {
    const light = rnd() < 0.5;
    blob(g, rnd() * W, rnd() * H, 80 + rnd() * 200,
      light ? 'rgba(110,150,70,0.22)' : 'rgba(30,60,35,0.25)', 'rgba(0,0,0,0)');
  }

  // zone tints
  const { village, meadow, forest, graveyard, camp } = ZONES;
  for (let i = 0; i < 18; i++) {
    blob(g, forest.x + (rnd() - 0.5) * 900, forest.y - 60 + (rnd() - 0.5) * 380, 160 + rnd() * 120,
      'rgba(18,48,30,0.45)', 'rgba(18,48,30,0)');
  }
  for (let i = 0; i < 10; i++) {
    blob(g, meadow.x + (rnd() - 0.5) * 380, meadow.y + (rnd() - 0.5) * 260, 140 + rnd() * 80,
      'rgba(140,180,80,0.25)', 'rgba(140,180,80,0)');
  }
  for (let i = 0; i < 12; i++) {
    blob(g, graveyard.x + (rnd() - 0.5) * 420, graveyard.y + (rnd() - 0.5) * 340, 150 + rnd() * 90,
      'rgba(70,72,82,0.5)', 'rgba(70,72,82,0)');
  }
  for (let i = 0; i < 12; i++) {
    blob(g, camp.x + (rnd() - 0.5) * 380, camp.y + (rnd() - 0.5) * 280, 140 + rnd() * 100,
      'rgba(120,88,52,0.55)', 'rgba(120,88,52,0)');
  }

  // roads: dark rim, dirt, worn centre, pebbles
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const roadPath = () => {
    g.beginPath();
    for (const r of ROADS) {
      g.moveTo(r[0][0], r[0][1]);
      for (let i = 1; i < r.length - 1; i++) {
        const mx = (r[i][0] + r[i + 1][0]) / 2;
        const my = (r[i][1] + r[i + 1][1]) / 2;
        g.quadraticCurveTo(r[i][0], r[i][1], mx, my);
      }
      const last = r[r.length - 1];
      g.lineTo(last[0], last[1]);
    }
  };
  roadPath();
  g.strokeStyle = 'rgba(60,46,30,0.55)';
  g.lineWidth = 44;
  g.stroke();
  g.strokeStyle = '#8c7350';
  g.lineWidth = 36;
  g.stroke();
  g.strokeStyle = 'rgba(178,150,105,0.5)';
  g.lineWidth = 16;
  g.stroke();

  // village plaza with cobbles
  g.fillStyle = 'rgba(60,46,30,0.5)';
  ellipseFill(g, village.x, village.y + 20, 168, 120);
  g.fillStyle = '#9a8865';
  ellipseFill(g, village.x, village.y + 20, 160, 112);
  for (let i = 0; i < 520; i++) {
    const a = rnd() * TAU;
    const d = Math.sqrt(rnd());
    const x = village.x + Math.cos(a) * d * 150;
    const y = village.y + 20 + Math.sin(a) * d * 104;
    const v = 120 + (rnd() * 50) | 0;
    g.fillStyle = `rgb(${v + 20},${v + 8},${v - 20})`;
    rrectFill(g, x - 6, y - 4, 10 + rnd() * 5, 7 + rnd() * 3, 3);
  }

  // camp: scorched dirt around the fire
  const fire = FIRES[0];
  blob(g, fire.x, fire.y, 90, 'rgba(40,26,18,0.55)', 'rgba(40,26,18,0)');

  // grass tufts and pebbles, kept off roads and the plaza
  for (let i = 0; i < 6000; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    if (roadDist(x, y) < 26 || near(x, y, village, 170)) continue;
    const inGrave = near(x, y, graveyard, 280);
    const inCamp = near(x, y, camp, 230);
    const tone = rnd();
    g.strokeStyle = inGrave ? `rgba(120,125,105,${0.5 + tone * 0.3})`
      : inCamp ? `rgba(140,120,70,${0.4 + tone * 0.3})`
      : tone < 0.5 ? 'rgba(30,70,32,0.6)' : 'rgba(120,170,80,0.55)';
    g.lineWidth = 1.3;
    const h = 4 + rnd() * 5;
    g.beginPath();
    g.moveTo(x - 3, y - h * 0.7); g.lineTo(x, y);
    g.lineTo(x + 0.5, y - h);
    g.moveTo(x + 3.5, y - h * 0.65); g.lineTo(x, y);
    g.stroke();
  }
  for (let i = 0; i < 500; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const v = 100 + (rnd() * 60) | 0;
    g.fillStyle = `rgba(${v},${v},${v - 10},0.7)`;
    ellipseFill(g, x, y, 1.5 + rnd() * 2.5, 1 + rnd() * 1.5);
  }

  // meadow flowers
  const petals = ['#fff6e0', '#ffd84d', '#ff8fb1', '#c59bff', '#ffffff'];
  for (let i = 0; i < 420; i++) {
    const a = rnd() * TAU;
    const d = Math.sqrt(rnd()) * 300;
    const x = meadow.x + Math.cos(a) * d * 1.2;
    const y = meadow.y + Math.sin(a) * d * 0.8;
    if (roadDist(x, y) < 24) continue;
    g.fillStyle = petals[(rnd() * petals.length) | 0];
    const s = 1.6 + rnd() * 1.2;
    for (let k = 0; k < 4; k++) ellipseFill(g, x + Math.cos(k * 1.57) * s, y + Math.sin(k * 1.57) * s * 0.7, s, s * 0.8);
    g.fillStyle = '#ffb02e';
    ellipseFill(g, x, y, s * 0.6, s * 0.6);
  }

  // grave mounds
  for (const t of TOMBS) {
    g.fillStyle = 'rgba(70,55,40,0.3)';
    ellipseFill(g, t.x + 2, t.y + 13, 16, 9);
  }

  // darken the map edge
  const edge = 70;
  const sides = [
    [0, 0, W, edge, 0, 0, 0, edge],
    [0, H - edge, W, edge, 0, H, 0, H - edge],
    [0, 0, edge, H, 0, 0, edge, 0],
    [W - edge, 0, edge, H, W, 0, W - edge, 0],
  ];
  for (const [x, y, w, h, gx0, gy0, gx1, gy1] of sides) {
    const grad = g.createLinearGradient(gx0, gy0, gx1, gy1);
    grad.addColorStop(0, 'rgba(10,20,12,0.55)');
    grad.addColorStop(1, 'rgba(10,20,12,0)');
    g.fillStyle = grad;
    g.fillRect(x, y, w, h);
  }
  return c;
}

function ellipseFill(g, x, y, rx, ry) {
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, TAU);
  g.fill();
}

function rrectFill(g, x, y, w, h, r) {
  rrect(g, x, y, w, h, r);
  g.fill();
}

function rrect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/* ------------------------------ props ------------------------------ */

// Fixed landmarks; scattered props are added by placeProps.
const FIRES = [{ x: 1990, y: 1250, light: 230 }, { x: 410, y: 900, light: 110 }, { x: 690, y: 900, light: 110 }];
const TOMBS = [];
{
  const g = ZONES.graveyard;
  const r = mulberry32(77);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 6; col++) {
      if (r() < 0.25) continue;
      TOMBS.push({ x: g.x - 230 + col * 92 + (r() - 0.5) * 20, y: g.y - 150 + row * 105 + (r() - 0.5) * 16 });
    }
  }
}

function placeProps(W, H, rnd) {
  const props = [];
  // scales are quantized so props share a handful of cached sprites
  const add = (kind, x, y, s = 1, variant = 0, flip = false) =>
    props.push({ kind, x, y, s: Math.round(s * 8) / 8, variant, flip });
  const { village, forest, graveyard, camp, meadow } = ZONES;

  // village
  add('house', 360, 640, 1.0, 0);
  add('house', 720, 610, 0.95, 1, true);
  add('house', 300, 880, 0.9, 2);
  add('house', 780, 960, 0.9, 1);
  add('well', 430, 720);
  add('torch', 410, 900, 1, 0);
  add('torch', 690, 900, 1, 0);
  add('barrel', 405, 662); add('barrel', 420, 670, 0.9, 1);
  add('crate', 760, 640); add('crate', 745, 652, 0.85, 1);
  add('hay', 280, 760, 1, 0); add('hay', 845, 900, 0.9, 1);
  for (let i = 0; i < 22; i++) {
    const a = -0.35 + (i / 22) * TAU;
    // gaps where the roads leave the village
    if ((a > -0.25 && a < 0.35) || (a > 4.9 && a < 5.5) || (a > 2.85 && a < 3.4)) continue;
    const x = village.x + Math.cos(a) * 330;
    const y = village.y + 20 + Math.sin(a) * 250;
    const x2 = village.x + Math.cos(a + TAU / 22) * 330;
    const y2 = village.y + 20 + Math.sin(a + TAU / 22) * 250;
    props.push({ kind: 'fence', x, y, s: 1, variant: 0, dx: x2 - x, dy: y2 - y });
  }

  // wolf forest: a ring of trees around the clearing, denser outside
  for (let i = 0; i < 70; i++) {
    const a = rnd() * TAU;
    const d = 230 + rnd() * 330;
    const x = forest.x + Math.cos(a) * d * 1.4;
    const y = forest.y + Math.sin(a) * d * 0.7;
    if (y > 620 || y < 30 || x < 30 || x > W - 30 || roadDist(x, y) < 50) continue;
    add(rnd() < 0.7 ? 'pine' : 'oak', x, y, 0.85 + rnd() * 0.4, (rnd() * 3) | 0, rnd() < 0.5);
  }
  // scattered trees elsewhere
  for (let i = 0; i < 90; i++) {
    const x = 40 + rnd() * (W - 80);
    const y = 40 + rnd() * (H - 60);
    if (roadDist(x, y) < 60) continue;
    if (near(x, y, village, 400) || near(x, y, meadow, 330) || near(x, y, graveyard, 330) || near(x, y, camp, 330) || near(x, y, forest, 640)) continue;
    add(rnd() < 0.5 ? 'oak' : 'pine', x, y, 0.8 + rnd() * 0.45, (rnd() * 3) | 0, rnd() < 0.5);
  }
  // bushes and rocks
  for (let i = 0; i < 110; i++) {
    const x = 30 + rnd() * (W - 60);
    const y = 30 + rnd() * (H - 40);
    if (roadDist(x, y) < 34 || near(x, y, village, 190) || near(x, y, camp, 160)) continue;
    if (near(x, y, graveyard, 280)) continue;
    add(rnd() < 0.6 ? 'bush' : 'rock', x, y, 0.7 + rnd() * 0.6, (rnd() * 3) | 0, rnd() < 0.5);
  }

  // graveyard
  TOMBS.forEach((t, i) => add('tomb', t.x, t.y, 0.9 + ((i * 37) % 10) / 40, i % 3, i % 2 === 0));
  add('deadtree', graveyard.x - 300, graveyard.y - 210, 1.2, 0);
  add('deadtree', graveyard.x + 290, graveyard.y + 210, 1.0, 1, true);
  add('deadtree', graveyard.x + 260, graveyard.y - 240, 0.9, 2);
  add('crypt', graveyard.x + 30, graveyard.y - 270, 1, 0);

  // ogre camp
  add('tent', camp.x - 170, camp.y - 120, 1.1, 0);
  add('tent', camp.x + 150, camp.y - 150, 1.0, 1, true);
  add('tent', camp.x + 210, camp.y + 60, 0.95, 2);
  add('campfire', FIRES[0].x, FIRES[0].y);
  add('totem', camp.x + 40, camp.y - 200, 1.1);
  add('bones', camp.x - 80, camp.y + 90); add('bones', camp.x + 70, camp.y + 140, 0.9, 1, true);
  add('bones', camp.x - 220, camp.y + 40, 0.8, 2);
  for (let i = 0; i < 26; i++) {
    const a = 3.0 + (i / 26) * 2.9;
    add('stake', camp.x + Math.cos(a) * 320, camp.y + Math.sin(a) * 230, 0.9 + (i % 3) * 0.1, i % 2, i % 2 === 1);
  }

  return props;
}

/* ---------------------------- prop kinds ---------------------------- */

function shadow(g, rx, ry = rx * 0.35) {
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.beginPath();
  g.ellipse(0, 0, rx, ry, 0, 0, TAU);
  g.fill();
}

function outlineFill(g, fill, lw = 1.5) {
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = lw;
  g.strokeStyle = OUTLINE;
  g.stroke();
}

function circle(g, x, y, r) {
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
}

const KINDS = {
  pine: {
    w: 90, h: 150, foot: 12, tall: true,
    draw(g, v) {
      shadow(g, 30, 10);
      g.beginPath(); g.rect(-5, -24, 10, 24); outlineFill(g, '#6b4a2f');
      const greens = [['#25553a', '#2f6b47', '#3f8758'], ['#1f4d3d', '#2a6350', '#3a7d64'], ['#2c5a30', '#386f3c', '#4b8a4c']][v];
      const tiers = [[38, -20, -66], [31, -50, -100], [23, -80, -132]];
      for (const [hw, base, top] of tiers) {
        g.beginPath();
        g.moveTo(-hw, base); g.quadraticCurveTo(0, base + 8, hw, base); g.lineTo(0, top); g.closePath();
        outlineFill(g, greens[0]);
        g.beginPath();
        g.moveTo(0, top); g.lineTo(-hw * 0.95, base - 1); g.quadraticCurveTo(-hw * 0.4, base + 4, -hw * 0.1, base + 3); g.closePath();
        g.fillStyle = greens[1]; g.fill();
        g.beginPath();
        g.moveTo(0, top + 4); g.lineTo(-hw * 0.55, base - 6); g.lineTo(-hw * 0.3, base - 4); g.closePath();
        g.fillStyle = greens[2]; g.fill();
      }
    },
  },
  oak: {
    w: 110, h: 160, foot: 12, tall: true,
    draw(g, v, r) {
      shadow(g, 38, 12);
      g.beginPath();
      g.moveTo(-7, 0); g.lineTo(-5, -40); g.lineTo(-14, -56); g.lineTo(-8, -58); g.lineTo(0, -46);
      g.lineTo(9, -60); g.lineTo(14, -56); g.lineTo(6, -40); g.lineTo(8, 0); g.closePath();
      outlineFill(g, '#6e4a2c');
      const tones = [['#2f6a35', '#3f8a40', '#5aa851'], ['#466b26', '#5c8a2e', '#7aab3e'], ['#2b5f45', '#3a7c58', '#52a072']][v];
      const blobs = [];
      for (let i = 0; i < 7; i++) blobs.push([(r() - 0.5) * 56, -72 - r() * 36, 20 + r() * 10]);
      blobs.sort((a, b) => a[1] - b[1]);
      g.lineWidth = 3;
      g.strokeStyle = OUTLINE;
      for (const [x, y, rr] of blobs) { circle(g, x, y, rr); g.stroke(); }
      for (const [x, y, rr] of blobs) { circle(g, x, y, rr); g.fillStyle = tones[0]; g.fill(); }
      for (const [x, y, rr] of blobs) { circle(g, x - rr * 0.2, y - rr * 0.25, rr * 0.75); g.fillStyle = tones[1]; g.fill(); }
      for (const [x, y, rr] of blobs) { circle(g, x - rr * 0.35, y - rr * 0.45, rr * 0.35); g.fillStyle = tones[2]; g.fill(); }
    },
  },
  bush: {
    w: 60, h: 46, foot: 8,
    draw(g, v) {
      shadow(g, 22, 7);
      const tones = [['#2f6a35', '#46914a'], ['#35602b', '#52873a'], ['#2a5e4a', '#3f8a68']][v];
      const pts = [[-12, -10, 12], [10, -11, 12], [0, -19, 13]];
      g.lineWidth = 2.6; g.strokeStyle = OUTLINE;
      for (const [x, y, r] of pts) { circle(g, x, y, r); g.stroke(); }
      for (const [x, y, r] of pts) { circle(g, x, y, r); g.fillStyle = tones[0]; g.fill(); }
      for (const [x, y, r] of pts) { circle(g, x - 3, y - 4, r * 0.55); g.fillStyle = tones[1]; g.fill(); }
      if (v === 1) {
        g.fillStyle = '#e8434e';
        for (const [x, y] of [[-10, -14], [6, -20], [12, -8], [-2, -9]]) { circle(g, x, y, 2.2); g.fill(); }
      }
    },
  },
  rock: {
    w: 56, h: 40, foot: 8,
    draw(g, v, r) {
      shadow(g, 22, 7);
      g.beginPath();
      const n = 7;
      for (let i = 0; i < n; i++) {
        const a = Math.PI + (i / (n - 1)) * Math.PI;
        const rr = 16 + r() * 6;
        const x = Math.cos(a) * rr * 1.2;
        const y = Math.sin(a) * rr * (0.9 + v * 0.1);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
      outlineFill(g, '#7d8288', 2);
      g.beginPath(); g.moveTo(-12, -6); g.lineTo(-6, -16); g.lineTo(6, -18); g.lineTo(-2, -8); g.closePath();
      g.fillStyle = '#a6abb0'; g.fill();
      g.fillStyle = 'rgba(90,140,70,0.7)';
      g.beginPath(); g.ellipse(8, -3, 8, 3, 0, 0, TAU); g.fill();
    },
  },
  house: {
    w: 170, h: 170, foot: 14, tall: true,
    draw(g, v) {
      const roof = ['#a8453a', '#4f6d8f', '#8d6a3b'][v];
      const roofHi = ['#c6614f', '#6f8fb3', '#ad8a52'][v];
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.beginPath(); g.ellipse(4, 0, 74, 18, 0, 0, TAU); g.fill();
      // walls
      g.beginPath(); g.rect(-58, -64, 116, 64); outlineFill(g, '#e9dcc0', 2);
      g.fillStyle = '#d4c3a1'; g.fillRect(20, -63, 37, 62);
      g.strokeStyle = '#6b4a2f'; g.lineWidth = 5;
      g.beginPath();
      g.moveTo(-58, -3); g.lineTo(58, -3);
      g.moveTo(-56, -64); g.lineTo(-56, 0); g.moveTo(56, -64); g.lineTo(56, 0);
      g.moveTo(-58, -36); g.lineTo(58, -36);
      g.moveTo(-30, -64); g.lineTo(-10, -36); g.moveTo(30, -64); g.lineTo(10, -36);
      g.stroke();
      // door
      g.beginPath(); g.moveTo(-12, 0); g.lineTo(-12, -26); g.arc(0, -26, 12, Math.PI, 0); g.lineTo(12, 0); g.closePath();
      outlineFill(g, '#6b4429', 2);
      g.fillStyle = '#e8c45a'; circle(g, 7, -13, 1.8); g.fill();
      // lit windows
      for (const wx of [-40, 36]) {
        g.beginPath(); g.rect(wx - 9, -30, 18, 16); outlineFill(g, '#ffd27a', 2);
        g.fillStyle = 'rgba(255,240,180,0.9)'; g.fillRect(wx - 7, -28, 6, 5);
        g.strokeStyle = '#6b4a2f'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(wx, -30); g.lineTo(wx, -14); g.moveTo(wx - 9, -22); g.lineTo(wx + 9, -22); g.stroke();
      }
      // chimney
      g.beginPath(); g.rect(28, -132, 16, 40); outlineFill(g, '#8a7a72', 2);
      g.fillStyle = '#5d524c'; g.fillRect(26, -136, 20, 6);
      // roof
      g.beginPath();
      g.moveTo(-74, -58); g.lineTo(-44, -120); g.lineTo(44, -120); g.lineTo(74, -58); g.closePath();
      outlineFill(g, roof, 2.5);
      g.beginPath(); g.moveTo(-74, -58); g.lineTo(-44, -120); g.lineTo(-10, -120); g.lineTo(-30, -58); g.closePath();
      g.fillStyle = roofHi; g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 2;
      for (let y = -104; y < -58; y += 14) {
        const k = (y + 120) / 62;
        g.beginPath(); g.moveTo(-44 - 30 * k, y); g.lineTo(44 + 30 * k, y); g.stroke();
      }
      g.strokeStyle = OUTLINE; g.lineWidth = 2.5;
      g.beginPath(); g.moveTo(-74, -58); g.lineTo(-44, -120); g.lineTo(44, -120); g.lineTo(74, -58); g.stroke();
    },
  },
  well: {
    w: 80, h: 100, foot: 12, tall: true,
    draw(g) {
      shadow(g, 32, 10);
      g.beginPath(); g.rect(-24, -64, 6, 50); outlineFill(g, '#6b4a2f');
      g.beginPath(); g.rect(18, -64, 6, 50); outlineFill(g, '#6b4a2f');
      g.beginPath(); g.ellipse(0, -14, 28, 10, 0, 0, TAU); g.rect(-28, -14, 56, 14); outlineFill(g, '#8d9196', 2);
      g.fillStyle = '#1d2a36'; g.beginPath(); g.ellipse(0, -14, 22, 7, 0, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1.5;
      for (const x of [-18, -6, 6, 18]) { g.beginPath(); g.moveTo(x, -10); g.lineTo(x, 0); g.stroke(); }
      g.beginPath(); g.moveTo(-34, -60); g.lineTo(0, -84); g.lineTo(34, -60); g.closePath(); outlineFill(g, '#a8453a', 2);
      g.strokeStyle = '#4b3a2a'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, -60); g.lineTo(0, -30); g.stroke();
      g.beginPath(); g.rect(-5, -32, 10, 9); outlineFill(g, '#7b5636');
    },
  },
  barrel: {
    w: 34, h: 44, foot: 6,
    draw(g) {
      shadow(g, 12, 4);
      g.beginPath(); g.ellipse(0, -14, 11, 15, 0, 0, TAU); outlineFill(g, '#8a5a32');
      g.fillStyle = '#a77142'; g.beginPath(); g.ellipse(-3, -15, 5, 12, 0, 0, TAU); g.fill();
      g.strokeStyle = '#3d3a3a'; g.lineWidth = 2;
      for (const y of [-24, -6]) { g.beginPath(); g.moveTo(-10, y); g.lineTo(10, y); g.stroke(); }
    },
  },
  crate: {
    w: 36, h: 40, foot: 6,
    draw(g) {
      shadow(g, 14, 5);
      g.beginPath(); g.rect(-12, -24, 24, 24); outlineFill(g, '#b0844e');
      g.strokeStyle = '#6b4a2f'; g.lineWidth = 2.5;
      g.beginPath(); g.moveTo(-11, -23); g.lineTo(11, -1); g.moveTo(-12, -12); g.lineTo(12, -12); g.stroke();
    },
  },
  hay: {
    w: 60, h: 46, foot: 8,
    draw(g) {
      shadow(g, 24, 7);
      g.beginPath(); g.moveTo(-24, 0); g.quadraticCurveTo(-26, -34, 0, -34); g.quadraticCurveTo(26, -34, 24, 0); g.closePath();
      outlineFill(g, '#d9b350');
      g.strokeStyle = 'rgba(140,100,30,0.6)'; g.lineWidth = 1.4;
      for (let i = -18; i <= 18; i += 6) { g.beginPath(); g.moveTo(i, -2); g.lineTo(i * 0.8 + 2, -28); g.stroke(); }
    },
  },
  fence: {
    w: 1, h: 1, foot: 0,
    live(g, t, p) {
      const { dx, dy } = p;
      g.lineCap = 'round';
      g.strokeStyle = OUTLINE; g.lineWidth = 6;
      g.beginPath(); g.moveTo(0, -14); g.lineTo(dx, dy - 14); g.moveTo(0, -24); g.lineTo(dx, dy - 24); g.stroke();
      g.strokeStyle = '#8c6338'; g.lineWidth = 3.5;
      g.beginPath(); g.moveTo(0, -14); g.lineTo(dx, dy - 14); g.moveTo(0, -24); g.lineTo(dx, dy - 24); g.stroke();
      g.beginPath(); g.rect(-3.5, -30, 7, 30); outlineFill(g, '#9b7041');
    },
  },
  torch: {
    w: 1, h: 1, foot: 0,
    live(g, t, p) {
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.beginPath(); g.ellipse(0, 0, 8, 3, 0, 0, TAU); g.fill();
      g.beginPath(); g.rect(-3, -46, 6, 46); outlineFill(g, '#5a3f28');
      g.beginPath(); g.rect(-6, -52, 12, 7); outlineFill(g, '#3c3c44');
      flame(g, 0, -52, 0.6, t + p.x);
    },
  },
  campfire: {
    w: 1, h: 1, foot: 0,
    live(g, t) {
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.beginPath(); g.ellipse(0, 2, 30, 9, 0, 0, TAU); g.fill();
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * TAU;
        g.beginPath(); g.ellipse(Math.cos(a) * 24, Math.sin(a) * 9, 6, 4.5, 0, 0, TAU); outlineFill(g, '#7e8086');
      }
      g.lineWidth = 6; g.strokeStyle = '#4b3220';
      g.beginPath(); g.moveTo(-16, 2); g.lineTo(14, -6); g.moveTo(-14, -6); g.lineTo(16, 2); g.stroke();
      flame(g, 0, -2, 1.3, t);
      // rising smoke
      for (let i = 0; i < 5; i++) {
        const k = ((t / 2400 + i / 5) % 1);
        g.fillStyle = `rgba(120,115,110,${0.22 * (1 - k)})`;
        circle(g, Math.sin(k * 6 + i) * 8 + k * 14, -40 - k * 90, 6 + k * 16);
        g.fill();
      }
    },
  },
  tomb: {
    w: 50, h: 64, foot: 8,
    draw(g, v) {
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.beginPath(); g.ellipse(2, 0, 18, 5, 0, 0, TAU); g.fill();
      if (v === 1) {
        g.beginPath();
        g.rect(-4, -46, 8, 46); g.rect(-15, -36, 30, 8);
        outlineFill(g, '#8b8f99', 2);
        g.fillStyle = '#a8adb6'; g.fillRect(-3, -45, 3, 44);
        return;
      }
      g.beginPath();
      if (v === 0) { g.moveTo(-14, 0); g.lineTo(-14, -30); g.arc(0, -30, 14, Math.PI, 0); g.lineTo(14, 0); }
      else { g.moveTo(-13, 0); g.lineTo(-15, -34); g.lineTo(-4, -42); g.lineTo(12, -38); g.lineTo(14, 0); }
      g.closePath();
      outlineFill(g, '#868b96', 2);
      g.fillStyle = '#a3a8b2'; g.fillRect(-12, -36, 5, 34);
      g.strokeStyle = 'rgba(40,40,50,0.6)'; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(-6, -26); g.lineTo(6, -26); g.moveTo(-6, -20); g.lineTo(4, -20); g.moveTo(0, -36); g.lineTo(0, -30); g.stroke();
      g.fillStyle = 'rgba(80,120,70,0.8)';
      g.beginPath(); g.ellipse(-8, -2, 8, 3, 0, 0, TAU); g.fill();
    },
  },
  crypt: {
    w: 150, h: 150, foot: 12, tall: true,
    draw(g) {
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.beginPath(); g.ellipse(0, 0, 66, 14, 0, 0, TAU); g.fill();
      g.beginPath(); g.rect(-52, -70, 104, 70); outlineFill(g, '#767b88', 2.5);
      g.fillStyle = '#5e6370'; g.fillRect(16, -69, 35, 68);
      g.beginPath(); g.moveTo(-62, -66); g.lineTo(0, -108); g.lineTo(62, -66); g.closePath(); outlineFill(g, '#5b5f6c', 2.5);
      g.beginPath(); g.moveTo(-16, 0); g.lineTo(-16, -34); g.arc(0, -34, 16, Math.PI, 0); g.lineTo(16, 0); g.closePath();
      outlineFill(g, '#1a1822', 2);
      g.beginPath(); g.rect(-3, -132, 6, 26); g.rect(-11, -124, 22, 6); outlineFill(g, '#8b8f99', 1.5);
      for (const x of [-40, 40]) { g.beginPath(); g.rect(x - 6, -66, 12, 66); outlineFill(g, '#8d929e', 1.5); }
    },
  },
  deadtree: {
    w: 120, h: 150, foot: 10, tall: true,
    draw(g, v, r) {
      shadow(g, 26, 8);
      const branch = (x, y, ang, len, w, depth) => {
        const x2 = x + Math.cos(ang) * len;
        const y2 = y + Math.sin(ang) * len;
        g.strokeStyle = OUTLINE; g.lineWidth = w + 2.5;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
        g.strokeStyle = '#4a3c35'; g.lineWidth = w;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
        if (depth <= 0) return;
        branch(x2, y2, ang - 0.45 - r() * 0.3, len * 0.68, w * 0.62, depth - 1);
        branch(x2, y2, ang + 0.35 + r() * 0.3, len * 0.62, w * 0.62, depth - 1);
      };
      branch(0, 0, -Math.PI / 2 + (v - 1) * 0.08, 52, 11, 3);
    },
  },
  tent: {
    w: 130, h: 125, foot: 12, tall: true,
    draw(g, v) {
      const hide = ['#9c7a52', '#86664a', '#a8865c'][v];
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.beginPath(); g.ellipse(0, 0, 58, 14, 0, 0, TAU); g.fill();
      g.lineWidth = 3.5; g.strokeStyle = '#4b3220';
      g.beginPath(); g.moveTo(-10, -86); g.lineTo(-20, -100); g.moveTo(8, -86); g.lineTo(18, -102); g.moveTo(0, -86); g.lineTo(2, -104); g.stroke();
      g.beginPath(); g.moveTo(-56, 0); g.quadraticCurveTo(-30, -40, 0, -86); g.quadraticCurveTo(30, -40, 56, 0); g.closePath();
      outlineFill(g, hide, 2.5);
      g.beginPath(); g.moveTo(0, -86); g.quadraticCurveTo(30, -40, 56, 0); g.lineTo(20, 0); g.closePath();
      g.fillStyle = 'rgba(0,0,0,0.16)'; g.fill();
      g.strokeStyle = '#7a2e22'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(-40, -22); g.quadraticCurveTo(0, -30, 40, -22); g.stroke();
      g.beginPath(); g.moveTo(-14, 0); g.lineTo(0, -44); g.lineTo(14, 0); g.closePath(); outlineFill(g, '#2a1d16', 2);
      g.strokeStyle = 'rgba(60,40,20,0.6)'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(-30, -36); g.lineTo(-24, -30); g.moveTo(28, -12); g.lineTo(34, -6); g.stroke();
    },
  },
  totem: {
    w: 60, h: 145, foot: 8, tall: true,
    draw(g) {
      shadow(g, 16, 5);
      g.beginPath(); g.rect(-6, -96, 12, 96); outlineFill(g, '#6b4a2f');
      g.strokeStyle = '#a8453a'; g.lineWidth = 3;
      for (const y of [-30, -50]) { g.beginPath(); g.moveTo(-6, y); g.lineTo(6, y - 4); g.stroke(); }
      // skull
      g.beginPath(); g.ellipse(0, -104, 13, 12, 0, 0, TAU); outlineFill(g, '#ebe5d2');
      g.beginPath(); g.rect(-8, -96, 16, 8); outlineFill(g, '#ebe5d2', 1.2);
      g.fillStyle = '#2a1d16';
      g.beginPath(); g.ellipse(-5, -105, 3.5, 4, 0, 0, TAU); g.ellipse(5, -105, 3.5, 4, 0, 0, TAU); g.fill();
      // horns
      g.beginPath(); g.moveTo(-11, -110); g.quadraticCurveTo(-26, -114, -24, -128); g.quadraticCurveTo(-18, -118, -8, -115); g.closePath();
      outlineFill(g, '#d9cdb0', 1.2);
      g.beginPath(); g.moveTo(11, -110); g.quadraticCurveTo(26, -114, 24, -128); g.quadraticCurveTo(18, -118, 8, -115); g.closePath();
      outlineFill(g, '#d9cdb0', 1.2);
    },
  },
  bones: {
    w: 60, h: 34, foot: 8,
    draw(g, v) {
      const bone = (x, y, a, l) => {
        g.save(); g.translate(x, y); g.rotate(a);
        g.beginPath(); g.rect(-l / 2, -1.8, l, 3.6);
        g.arc(-l / 2, -2, 2.6, 0, TAU); g.moveTo(-l / 2 + 2.6, 2); g.arc(-l / 2, 2, 2.6, 0, TAU);
        g.moveTo(l / 2 + 2.6, -2); g.arc(l / 2, -2, 2.6, 0, TAU); g.moveTo(l / 2 + 2.6, 2); g.arc(l / 2, 2, 2.6, 0, TAU);
        outlineFill(g, '#e6dfcb', 1.2);
        g.restore();
      };
      bone(-10, -3, 0.3, 18);
      bone(8, -5, -0.6, 16);
      if (v !== 2) {
        g.beginPath(); g.ellipse(2, -9, 8, 7, 0, 0, TAU); outlineFill(g, '#ebe5d2', 1.4);
        g.fillStyle = '#2a1d16';
        g.beginPath(); g.ellipse(-1, -10, 2, 2.4, 0, 0, TAU); g.ellipse(5, -10, 2, 2.4, 0, 0, TAU); g.fill();
      }
    },
  },
  stake: {
    w: 30, h: 70, foot: 6,
    draw(g, v) {
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.beginPath(); g.ellipse(0, 0, 9, 3, 0, 0, TAU); g.fill();
      g.save();
      g.rotate((v ? 0.12 : -0.1));
      g.beginPath(); g.moveTo(-6, 0); g.lineTo(-6, -42); g.lineTo(0, -54); g.lineTo(6, -42); g.lineTo(6, 0); g.closePath();
      outlineFill(g, '#8a6239');
      g.fillStyle = '#a77c4c'; g.fillRect(-5, -42, 4, 41);
      g.strokeStyle = '#4b3220'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(-6, -16); g.lineTo(6, -18); g.stroke();
      g.restore();
    },
  },
};

// flame draws a flickering fire with its tip at (x, y - height).
function flame(g, x, y, s, t) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.globalCompositeOperation = 'lighter';
  const halo = g.createRadialGradient(0, -10, 0, 0, -10, 34);
  halo.addColorStop(0, 'rgba(255,170,60,0.55)');
  halo.addColorStop(1, 'rgba(255,120,30,0)');
  g.fillStyle = halo;
  g.fillRect(-34, -44, 68, 68);
  g.globalCompositeOperation = 'source-over';
  const layers = [['#ff5a1f', 1, 0], ['#ffa531', 0.72, 1.3], ['#fff1a8', 0.42, 2.6]];
  for (const [color, k, ph] of layers) {
    const sway = Math.sin(t / 110 + ph) * 3 * k;
    const h = (26 + Math.sin(t / 70 + ph * 2) * 4) * k;
    const w = 11 * k;
    g.beginPath();
    g.moveTo(-w, 0);
    g.quadraticCurveTo(-w * 1.1, -h * 0.5, sway, -h);
    g.quadraticCurveTo(w * 1.1, -h * 0.5, w, 0);
    g.quadraticCurveTo(0, w * 0.4, -w, 0);
    g.fillStyle = color;
    g.fill();
  }
  // embers
  for (let i = 0; i < 4; i++) {
    const k = ((t / 900 + i / 4) % 1);
    g.fillStyle = `rgba(255,200,90,${1 - k})`;
    g.fillRect(Math.sin(i * 9 + k * 5) * 10, -20 - k * 40, 2, 2);
  }
  g.restore();
}
