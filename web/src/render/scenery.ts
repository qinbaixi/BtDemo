// World scenery in an underworld, Hades-like style: a painted ground layer and
// props (cypresses, columns, braziers, tombs, tents...) that the main renderer
// depth-sorts together with the characters, plus the light sources that the
// lighting pass carves out of the dark.
//
// 地表按地图（config/map.tmj）里的区域画，区域位置和 config/monsters.yaml 的刷怪点对应：
//   village   -> a Greek sanctuary: marble plaza with a meander border,
//                columns, braziers, terracotta houses and amphorae
//   meadow    -> Elysian fields: warm grass and glowing asphodels
//   forest    -> a dark cypress grove
//   graveyard -> Asphodel: slate ground, tombs and blue soul fire
//   camp      -> Tartarus: scorched earth split by lava cracks
// 区域、道路和挡路的物件来自地图文件；草丛等小装饰用固定种子生成，所以每个客户端看到的都一样。
// The ground is painted once into an offscreen canvas and static props are
// cached as sprites; only fire, lava and souls animate.

import type { MapData, Pt } from '../game/map';
import { art } from './art';

const TAU = Math.PI * 2;
const INK = '#0b0710';
const SPRITE_SCALE = 2;      // sprite resolution relative to world units

/* ------------------------------ layout ------------------------------ */

// 当前地图的区域和道路（createScenery 时从地图数据设置；同一时间只有一个场景）。
// ZONES 是区域种类 -> 区域中心列表，一种区域可以有多处。
type Zone = { x: number; y: number };
let ZONES: Record<'village' | 'meadow' | 'forest' | 'graveyard' | 'camp', Zone[]> = emptyZones();
let ROADS: Pt[][] = [];

function emptyZones() {
  return { village: [], meadow: [], forest: [], graveyard: [], camp: [] };
}

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

// near：点是否在某一处区域中心的 r 范围内。
const near = (x, y, zones: Zone[], r) => zones.some((z) => Math.hypot(x - z.x, y - z.y) < r);

// 塔尔塔罗斯营地周围的岩浆裂缝（折线），画进地表，也是光源。
let LAVA: Pt[][] = [];
function makeLava(): Pt[][] {
  const out: Pt[][] = [];
  const lr = mulberry32(99);
  for (const c of ZONES.camp) for (let i = 0; i < 7; i++) {
    let a = (i / 7) * TAU + lr() * 0.5;
    let x = c.x + Math.cos(a) * 40;
    let y = c.y + Math.sin(a) * 26;
    const line: Pt[] = [[x, y]];
    const steps = 5 + ((lr() * 4) | 0);
    for (let k = 0; k < steps; k++) {
      a += (lr() - 0.5) * 0.9;
      const len = 26 + lr() * 26;
      x += Math.cos(a) * len;
      y += Math.sin(a) * len * 0.62;
      line.push([x, y]);
    }
    out.push(line);
  }
  return out;
}

/* ------------------------------ public ------------------------------ */

// 只有美术图、没有程序画法的物件种类：按一个中等大小的物件来做镜头裁剪
const ART_ONLY = { w: 120, h: 160, foot: 0 };

// kindDef 返回物件种类的尺寸和画法；都没有时返回 undefined（画不出来）。
function kindDef(p) {
  return KINDS[p.kind] || (art.props.has(p.kind) ? ART_ONLY : undefined);
}

// createScenery 按地图建场景。地图里的物件服务端也用来挡路，所以必须画在完全相同的位置；
// 小装饰（草丛、魂火）在它们周围生成。map 为 null 表示没有地图文件：一片空地。
export function createScenery(mapW: number, mapH: number, map: MapData | null, seed = 20261020) {
  ZONES = emptyZones();
  for (const k of Object.keys(ZONES)) ZONES[k] = map?.zones[k] || [];
  ROADS = map?.roads || [];
  LAVA = makeLava();
  const unknown = new Set((map?.props || []).filter((p) => !kindDef(p)).map((p) => p.kind));
  if (unknown.size) console.error(`map.tmj 里的物件种类前端不会画：${[...unknown].join(', ')}（加美术图，或在 scenery.ts 的 KINDS 里加画法）`);
  const blocking = (map?.props || []).filter((p) => kindDef(p));
  const of = (kind) => blocking.filter((p) => p.kind === kind);
  const tombs = of('tomb');
  const braziers = of('brazier');
  const campfires = of('campfire');
  const crypts = of('crypt');
  const houses = of('house');
  const soulfires = tombs.filter((_, i) => i % 3 === 1).map((t) => ({ x: t.x + 18 * t.s, y: t.y + 10 }));
  const ground = paintGround(mapW, mapH, mulberry32(seed ^ 0x5eed), { tombs, campfires });
  const props = blocking.concat(placeDecor(mapW, mapH, mulberry32(seed), blocking, soulfires));
  const sprites = new Map();

  function sprite(p) {
    const key = p.kind + ':' + p.variant + ':' + p.s.toFixed(3) + ':' + (p.flip ? 1 : 0);
    let sp = sprites.get(key);
    if (sp) return sp;
    const def = kindDef(p);
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
    zones: ZONES,       // 区域种类 -> 区域中心，后期处理按离哪个区域近切换调色

    // heat 登记镜头里的热源（营火、火盆），后期处理在它们上方画热浪扭曲。
    // (x, y) 是火焰底部，radius 是热浪的宽度（向上延伸约两倍），strength 是扭曲强度（像素）。
    heat(add, view) {
      const inView = (x, y, r) => x + r > view.x && x - r < view.x + view.w && y + r * 3 > view.y && y - r < view.y + view.h;
      for (const c of campfires) if (inView(c.x, c.y, 70)) add(c.x, c.y - 24, 60, 3);
      for (const { x, y } of braziers) if (inView(x, y, 36)) add(x, y - 52, 34, 2.2);
    },

    // visible returns the props intersecting the view, for depth sorting.
    visible(view) {
      const out = [];
      for (const p of props) {
        const def = kindDef(p);
        const hw = (def.w * p.s) / 2 + (p.dx ? Math.abs(p.dx * p.s) : 0);
        if (p.x + hw < view.x || p.x - hw > view.x + view.w) continue;
        // 墙段两端的 y 都要算上（dy 可能是负的）
        const top = Math.min(p.y, p.y + (p.dy || 0) * p.s) - def.h * p.s;
        const bottom = Math.max(p.y + 20, p.y + (p.dy || 0) * p.s);
        if (top > view.y + view.h || bottom < view.y) continue;
        out.push(p);
      }
      return out;
    },

    // ground 是整张地图的地表画布（世界坐标 1:1）。
    ground,

    // propSprite 返回静态物件预先画好的精灵画布（同种类、同变体只画一次）。
    propSprite: sprite,

    // kindOf 返回物件种类的定义：w/h 尺寸、foot 脚底偏移、tall 高物件、live 动态绘制、box 动态绘制的范围。
    kindOf: kindDef,

    // seeThrough：高物件挡在自己的角色前面时变成半透明，保证玩家不会被挡住。
    seeThrough(p, focus) {
      const def = kindDef(p);
      if (!focus || !def.tall || focus.y >= p.y - 4) return false;
      const hw = (def.w * p.s) / 2 - 6;
      return Math.abs(focus.x - p.x) < hw && focus.y > p.y - def.h * p.s * 0.95;
    },

    // drawLive 在 (0, 0) 处画动态物件（火盆、营火、魂火、墙），坐标是物件本地坐标，已按 s 缩放。
    drawLive(ctx, p, time) {
      ctx.scale(p.s, p.s);
      KINDS[p.kind].live(ctx, time, p);
    },

    // lights registers the scene's light sources with the lighting pass.
    lights(add, view, time) {
      const inView = (x, y, r) => x + r > view.x && x - r < view.x + view.w && y + r > view.y && y - r < view.y + view.h;
      const flick = (seed, amt) => 1 + Math.sin(time / 90 + seed) * amt + Math.sin(time / 37 + seed * 3) * amt * 0.6;
      for (const c of campfires) {
        if (inView(c.x, c.y, 380)) add(c.x, c.y - 20, 360 * flick(c.x, 0.04), '#ff8a3a', 1, 0.45);
      }
      for (const { x, y } of braziers) {
        if (inView(x, y, 260)) add(x, y - 40, 250 * flick(x, 0.05), '#ffa64d', 0.95, 0.4);
      }
      for (const s of soulfires) {
        if (inView(s.x, s.y, 180)) add(s.x, s.y - 12, 160 * flick(s.x, 0.06), '#5fd8ff', 0.85, 0.45);
      }
      for (const c of crypts) {
        if (inView(c.x, c.y, 200)) add(c.x, c.y - 20, 180, '#7ae0ff', 0.7, 0.35);
      }
      for (const line of LAVA) {
        for (let i = 1; i < line.length; i += 2) {
          const [x, y] = line[i];
          if (!inView(x, y, 140)) continue;
          const pulse = 0.8 + 0.2 * Math.sin(time / 600 + i + x * 0.01);
          add(x, y, 130 * pulse, '#ff5a14', 0.75 * pulse, 0.5);
        }
      }
      for (const p of houses) {
        if (!inView(p.x, p.y, 120)) continue;
        add(p.x - 40 * p.s, p.y - 10, 90, '#ffb35a', 0.55, 0.25);
        add(p.x + 36 * p.s, p.y - 10, 90, '#ffb35a', 0.55, 0.25);
      }
    },

    // drawAmbient adds the animated atmosphere above everything else:
    // graveyard fog, Tartarus embers, Elysian motes and stray souls.
    drawAmbient(ctx, view, time) {
      const close = (z: Zone) => Math.abs(z.x - (view.x + view.w / 2)) < view.w / 2 + 400 &&
        Math.abs(z.y - (view.y + view.h / 2)) < view.h / 2 + 400;
      for (const g of ZONES.graveyard) {
        if (!close(g)) continue;
        ctx.save();
        const fog = fogSprite();
        for (let i = 0; i < 9; i++) {
          const a = time / 9000 + i * 0.7;
          const x = g.x + Math.cos(a + i) * (120 + i * 18);
          const y = g.y + Math.sin(a * 1.3 + i * 2) * 90 + 20;
          const r = 100 + (i % 3) * 34;
          ctx.globalAlpha = 0.5;
          ctx.drawImage(fog, x - r, y - r * 0.6, r * 2, r * 1.2);
        }
        ctx.restore();
      }
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const mote = (x, y, size, color, a) => {
        if (x < view.x - 10 || x > view.x + view.w + 10 || y < view.y - 10 || y > view.y + view.h + 10) return;
        ctx.globalAlpha = a;
        ctx.drawImage(dotSprite(color), x - size, y - size, size * 2, size * 2);
      };
      // 塔尔塔罗斯升起的火星
      for (const c of ZONES.camp) for (let i = 0; i < 36; i++) {
        const k = ((time / 3200 + i * 0.137) % 1);
        const x = c.x + Math.sin(i * 12.9) * 260 + Math.sin(time / 700 + i) * 10;
        const y = c.y + Math.cos(i * 7.3) * 170 - k * 160;
        mote(x, y, 3 + (i % 3), i % 4 ? '#ff7a2a' : '#ffd27a', (1 - k) * 0.9);
      }
      // 极乐草地和柏树林上空的金色光点
      const glade = [...ZONES.forest, ...ZONES.meadow];   // 各一处时：偶数号在林子，奇数号在草地
      for (let i = 0; glade.length && i < 30; i++) {
        const z = glade[i % glade.length];
        const x = z.x + Math.sin(time / 2300 + i * 1.7) * 220 + Math.sin(i * 12.9) * 120;
        const y = z.y + Math.cos(time / 2900 + i * 2.3) * 140 + Math.cos(i * 7.1) * 60;
        mote(x, y, 6, '#ffe08a', 0.35 + 0.35 * Math.sin(time / 300 + i * 3));
      }
      // 墓地上空飘荡的亡魂
      for (const g of ZONES.graveyard) for (let i = 0; i < 10; i++) {
        const k = ((time / 5200 + i * 0.1) % 1);
        const x = g.x + Math.sin(i * 5.1) * 230 + Math.sin(time / 900 + i) * 14;
        const y = g.y + Math.cos(i * 3.7) * 150 - k * 70;
        mote(x, y, 9, '#7ae0ff', Math.sin(k * Math.PI) * 0.7);
      }
      ctx.restore();
    },
  };
}

const glowCache = new Map();

function dotSprite(color) {
  let s = glowCache.get(color);
  if (s) return s;
  s = document.createElement('canvas');
  s.width = s.height = 32;
  const g = s.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.25, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  glowCache.set(color, s);
  return s;
}

function fogSprite() {
  let s = glowCache.get('fog');
  if (s) return s;
  s = document.createElement('canvas');
  s.width = s.height = 128;
  const g = s.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(150,140,210,0.28)');
  grad.addColorStop(1, 'rgba(150,140,210,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowCache.set('fog', s);
  return s;
}

/* ------------------------------ ground ------------------------------ */

function blob(g, x, y, r, inner, outer = 'rgba(0,0,0,0)') {
  const grad = g.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(x - r, y - r, r * 2, r * 2);
}

function ellipseFill(g, x, y, rx, ry) {
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, TAU);
  g.fill();
}

function poly(g, pts) {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
}

// hatch lays short parallel ink strokes, the comic-book way of shading.
function hatch(g, x, y, r, rnd, color, n = 14) {
  g.strokeStyle = color;
  g.lineWidth = 1.2;
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU;
    const d = Math.sqrt(rnd()) * r;
    const px = x + Math.cos(a) * d;
    const py = y + Math.sin(a) * d * 0.6;
    const len = 5 + rnd() * 7;
    g.moveTo(px, py);
    g.lineTo(px + len * 0.8, py - len * 0.45);
  }
  g.stroke();
}

function paintGround(W, H, rnd, { tombs, campfires }) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const { village, meadow, forest, graveyard, camp } = ZONES;

  // base: cool, dark green-grey earth with painterly light and shade
  g.fillStyle = '#2e3d33';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 170; i++) {
    const t = rnd();
    blob(g, rnd() * W, rnd() * H, 70 + rnd() * 210,
      t < 0.4 ? 'rgba(80,110,70,0.22)' : t < 0.75 ? 'rgba(14,24,22,0.32)' : 'rgba(90,70,40,0.18)');
  }

  // 各区域的地面底色
  for (const z of forest) for (let i = 0; i < 20; i++) {
    blob(g, z.x + (rnd() - 0.5) * 900, z.y - 60 + (rnd() - 0.5) * 380, 150 + rnd() * 130, 'rgba(8,20,18,0.5)');
  }
  for (const z of meadow) for (let i = 0; i < 14; i++) {
    blob(g, z.x + (rnd() - 0.5) * 420, z.y + (rnd() - 0.5) * 280, 130 + rnd() * 90, 'rgba(150,150,60,0.22)');
  }
  for (const z of graveyard) for (let i = 0; i < 14; i++) {
    blob(g, z.x + (rnd() - 0.5) * 440, z.y + (rnd() - 0.5) * 360, 150 + rnd() * 90, 'rgba(46,42,74,0.6)');
  }
  for (const z of camp) for (let i = 0; i < 16; i++) {
    blob(g, z.x + (rnd() - 0.5) * 420, z.y + (rnd() - 0.5) * 300, 130 + rnd() * 110, 'rgba(70,24,14,0.6)');
  }
  for (const c of campfires) blob(g, c.x, c.y, 120, 'rgba(10,4,4,0.7)');

  // ink hatching in the shadows of every zone
  for (let i = 0; i < 260; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    if (roadDist(x, y) < 30 || near(x, y, village, 175)) continue;
    hatch(g, x, y, 26 + rnd() * 30, rnd, 'rgba(6,10,10,0.35)', 10);
  }

  // 路面被踩出的泥土带，石板铺在上面，边缘有一圈压实的深色
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const [wd, col] of [[46, 'rgba(30,22,20,0.28)'], [36, 'rgba(78,62,46,0.45)']] as [number, string][]) {
    g.lineWidth = wd;
    g.strokeStyle = col;
    for (const road of ROADS) {
      g.beginPath();
      road.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
    }
  }

  // flagstone roads
  for (const road of ROADS) {
    for (let i = 1; i < road.length; i++) {
      const [ax, ay] = road[i - 1];
      const [bx, by] = road[i];
      const len = Math.hypot(bx - ax, by - ay);
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      for (let d = 0; d < len; d += 15) {
        for (const side of [-1, 0, 1]) {
          if (rnd() < 0.12) continue;
          const cx = ax + ux * d - uy * side * 13 + (rnd() - 0.5) * 4;
          const cy = ay + uy * d + ux * side * 13 * 0.8 + (rnd() - 0.5) * 4;
          const sw = 6 + rnd() * 3;
          const sh = 5 + rnd() * 2;
          const pts = [[-sw, -sh], [sw, -sh + rnd() * 2], [sw - rnd() * 2, sh], [-sw + rnd() * 2, sh]]
            .map(([x, y]) => [cx + x, cy + y * 0.8]);
          poly(g, pts);
          const v = 70 + (rnd() * 26) | 0;
          g.fillStyle = `rgb(${v + 6},${v},${v - 8})`;
          g.fill();
          g.lineWidth = 1.6;
          g.strokeStyle = 'rgba(10,8,10,0.7)';
          g.stroke();
          g.fillStyle = 'rgba(255,240,210,0.12)';
          g.fillRect(cx - sw + 1, cy - sh * 0.8 + 1, sw * 1.2, 1.4);
        }
      }
    }
  }

  // 圣所广场：大理石圆盘、回纹边、青铜徽记
  for (const v of village) paintPlaza(g, v.x, v.y + 20, rnd);

  // 极乐草地的日光兰：淡淡发光的六瓣小花
  for (const z of meadow) for (let i = 0; i < 360; i++) {
    const a = rnd() * TAU;
    const d = Math.sqrt(rnd()) * 320;
    const x = z.x + Math.cos(a) * d * 1.2;
    const y = z.y + Math.sin(a) * d * 0.8;
    if (roadDist(x, y) < 26) continue;
    const s = 1.8 + rnd() * 1.4;
    blob(g, x, y, s * 5, 'rgba(255,236,170,0.18)');
    g.fillStyle = rnd() < 0.8 ? '#f4ead0' : '#ffb7c8';
    for (let k = 0; k < 6; k++) {
      const pa = (k / 6) * TAU;
      ellipseFill(g, x + Math.cos(pa) * s * 1.2, y + Math.sin(pa) * s * 0.8, s * 0.9, s * 0.6);
    }
    g.fillStyle = '#e09a2a';
    ellipseFill(g, x, y, s * 0.55, s * 0.45);
  }

  // Asphodel graves: mounds and a few cracked slabs
  for (const t of tombs) {
    g.fillStyle = 'rgba(20,16,30,0.55)';
    ellipseFill(g, t.x + 2, t.y + 13, 17, 9);
  }
  for (const z of graveyard) for (let i = 0; i < 40; i++) {
    const x = z.x + (rnd() - 0.5) * 520;
    const y = z.y + (rnd() - 0.5) * 400;
    g.fillStyle = 'rgba(70,66,92,0.55)';
    g.save(); g.translate(x, y); g.rotate((rnd() - 0.5) * 0.4);
    g.fillRect(-12, -6, 24, 12);
    g.strokeStyle = 'rgba(8,6,12,0.6)'; g.lineWidth = 1.2; g.strokeRect(-12, -6, 24, 12);
    g.restore();
  }

  // Tartarus lava: ink rim, molten body, white-hot core and heat haze
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const pass of [[13, 'rgba(255,90,20,0.18)'], [7, INK], [4.5, '#d8360c'], [2.4, '#ff8a2a'], [1, '#ffe39a']] as [number, string][]) {
    g.lineWidth = pass[0];
    g.strokeStyle = pass[1];
    for (const line of LAVA) {
      g.beginPath();
      line.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
    }
  }

  // stones scattered everywhere
  for (let i = 0; i < 420; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    if (near(x, y, village, 180)) continue;
    const v = 60 + (rnd() * 40) | 0;
    g.fillStyle = INK;
    ellipseFill(g, x, y + 0.6, 2.6 + rnd() * 2, 1.8 + rnd());
    g.fillStyle = `rgb(${v},${v},${v + 8})`;
    ellipseFill(g, x, y, 1.8 + rnd() * 2, 1.2 + rnd());
  }

  // 塔尔塔罗斯营地周围的焦土裂纹（不发光的细裂缝）
  for (const z of camp) {
    g.lineCap = 'round';
    for (let i = 0; i < 26; i++) {
      const a = rnd() * TAU;
      const d = 60 + rnd() * 230;
      let x = z.x + Math.cos(a) * d * 1.2;
      let y = z.y + Math.sin(a) * d * 0.75;
      g.beginPath();
      g.moveTo(x, y);
      let ang = rnd() * TAU;
      for (let k = 0; k < 4; k++) {
        ang += (rnd() - 0.5) * 1.4;
        x += Math.cos(ang) * (8 + rnd() * 12);
        y += Math.sin(ang) * (5 + rnd() * 8);
        g.lineTo(x, y);
      }
      g.lineWidth = 2.2;
      g.strokeStyle = 'rgba(12,4,4,0.7)';
      g.stroke();
      g.lineWidth = 0.8;
      g.strokeStyle = 'rgba(150,60,30,0.35)';
      g.stroke();
    }
  }

  // 草丛：几根弯曲的草叶，暗色的根、亮一点的尖；颜色随区域变化，路上、广场、营地不长
  for (let i = 0; i < 1100; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const n = 3 + ((rnd() * 3) | 0);
    const hgt = 4 + rnd() * 5;
    const tone = rnd();
    if (roadDist(x, y) < 26 || near(x, y, village, 185) || near(x, y, camp, 260)) continue;
    const grave = near(x, y, graveyard, 260);
    if (grave && tone < 0.6) continue;   // 墓地的草稀
    const [root, tip] = grave ? ['#2a2a3e', '#6a6a8a']
      : near(x, y, forest, 420) ? ['#0e2420', tone < 0.5 ? '#2f5a48' : '#3c6a50']
        : near(x, y, meadow, 360) ? ['#3a4a22', tone < 0.5 ? '#8aa04a' : '#a8b85a']
          : ['#1e3024', tone < 0.5 ? '#4a6a44' : '#5a7a48'];
    g.lineCap = 'round';
    for (let k = 0; k < n; k++) {
      const lean = (k - (n - 1) / 2) * 0.35 + (rnd() - 0.5) * 0.3;
      const h2 = hgt * (0.7 + rnd() * 0.5);
      const tx = x + Math.sin(lean) * h2 * 1.1;
      const ty = y - Math.cos(lean) * h2;
      g.beginPath();
      g.moveTo(x + (k - n / 2) * 0.8, y);
      g.quadraticCurveTo(x + Math.sin(lean) * h2 * 0.3, y - h2 * 0.6, tx, ty);
      g.lineWidth = 1.6;
      g.strokeStyle = root;
      g.stroke();
      g.beginPath();
      g.moveTo(x + Math.sin(lean) * h2 * 0.55, y - h2 * 0.55);
      g.lineTo(tx, ty);
      g.lineWidth = 1;
      g.strokeStyle = tip;
      g.stroke();
    }
  }

  // darken the map edge
  const edge = 90;
  const sides = [
    [0, 0, W, edge, 0, 0, 0, edge],
    [0, H - edge, W, edge, 0, H, 0, H - edge],
    [0, 0, edge, H, 0, 0, edge, 0],
    [W - edge, 0, edge, H, W, 0, W - edge, 0],
  ];
  for (const [x, y, w, h, gx0, gy0, gx1, gy1] of sides) {
    const grad = g.createLinearGradient(gx0, gy0, gx1, gy1);
    grad.addColorStop(0, 'rgba(4,2,8,0.7)');
    grad.addColorStop(1, 'rgba(4,2,8,0)');
    g.fillStyle = grad;
    g.fillRect(x, y, w, h);
  }
  return c;
}

// paintPlaza 在 (px, py) 画一个圣所广场。
function paintPlaza(g, px, py, rnd) {
  g.fillStyle = INK;
  ellipseFill(g, px, py, 178, 126);
  g.fillStyle = '#6f2a1c';
  ellipseFill(g, px, py, 174, 122);
  g.fillStyle = '#c7b894';
  ellipseFill(g, px, py, 150, 104);
  // radial marble slabs
  g.save();
  g.translate(px, py);
  g.scale(1, 104 / 150);
  g.strokeStyle = 'rgba(60,45,30,0.45)';
  g.lineWidth = 1.6;
  for (const rr of [50, 100]) {
    g.beginPath(); g.arc(0, 0, rr, 0, TAU); g.stroke();
  }
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU;
    g.beginPath(); g.moveTo(Math.cos(a) * 50, Math.sin(a) * 50); g.lineTo(Math.cos(a) * 150, Math.sin(a) * 150); g.stroke();
  }
  for (let i = 0; i < 90; i++) {
    const a = rnd() * TAU;
    const d = 20 + rnd() * 125;
    g.strokeStyle = 'rgba(120,100,80,0.25)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.cos(a) * d, Math.sin(a) * d);
    g.quadraticCurveTo(Math.cos(a + 0.05) * (d + 8), Math.sin(a + 0.05) * (d + 8), Math.cos(a + 0.1) * (d + 4), Math.sin(a + 0.1) * (d + 4));
    g.stroke();
  }
  // Greek key around the rim
  g.strokeStyle = '#e0b25a';
  g.lineWidth = 2.4;
  const keyR = 162;
  const n = 44;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * TAU;
    const a1 = ((i + 0.8) / n) * TAU;
    const P = (a, rr) => [Math.cos(a) * rr, Math.sin(a) * rr];
    const am = (a0 + a1) / 2;
    const pts = [P(a0, keyR - 7), P(a0, keyR + 7), P(a1, keyR + 7), P(a1, keyR - 3), P(am, keyR - 3), P(am, keyR + 2)];
    g.beginPath();
    pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
  }
  // bronze emblem
  g.fillStyle = INK;
  g.beginPath(); g.arc(0, 0, 30, 0, TAU); g.fill();
  g.fillStyle = '#a5672a';
  g.beginPath(); g.arc(0, 0, 27, 0, TAU); g.fill();
  g.strokeStyle = '#f0c46a';
  g.lineWidth = 2;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    g.beginPath(); g.moveTo(Math.cos(a) * 8, Math.sin(a) * 8); g.lineTo(Math.cos(a) * 22, Math.sin(a) * 22); g.stroke();
  }
  g.restore();
}

/* ------------------------------ props ------------------------------ */

// placeDecor 撒地图里没有的小装饰（草丛、魂火），避开道路和地图里的物件。
function placeDecor(W, H, rnd, blocking, soulfires) {
  const props = [];
  const add = (kind, x, y, s = 1, variant = 0, flip = false) =>
    props.push({ kind, x, y, s: Math.round(s * 8) / 8, variant, flip });
  const clear = (x, y, r) => blocking.every((p) => {
    const def = kindDef(p);
    if (p.dx !== undefined) return distToSeg(x, y, p.x, p.y, p.x + p.dx * p.s, p.y + p.dy * p.s) > r + 10;
    return Math.hypot(x - p.x, (y - p.y) * 1.6) > r + (def.w * p.s) * 0.4;
  });
  const { village, graveyard, camp } = ZONES;

  for (const s of soulfires) add('soulfire', s.x, s.y);
  for (let i = 0; i < 130; i++) {
    const x = 30 + rnd() * (W - 60);
    const y = 30 + rnd() * (H - 40);
    const s = 0.7 + rnd() * 0.6;
    const v = (rnd() * 3) | 0;
    const flip = rnd() < 0.5;
    if (roadDist(x, y) < 34 || near(x, y, village, 190) || near(x, y, camp, 160) || near(x, y, graveyard, 280)) continue;
    if (!clear(x, y, 22 * s)) continue;
    add('bush', x, y, s, v, flip);
  }
  return props;
}

/* ---------------------------- prop kinds ---------------------------- */

function shadow(g, rx, ry = rx * 0.35) {
  g.fillStyle = 'rgba(0,0,0,0.42)';
  g.beginPath();
  g.ellipse(0, 0, rx, ry, 0, 0, TAU);
  g.fill();
}

function ink(g, fill, lw = 2.2) {
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = lw;
  g.strokeStyle = INK;
  g.stroke();
}

function circle(g, x, y, r) {
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
}

const KINDS = {
  cypress: {
    w: 70, h: 190, foot: 12, tall: true,
    draw(g, v) {
      shadow(g, 24, 8);
      g.beginPath(); g.rect(-4, -22, 8, 22); ink(g, '#3a261c');
      const tones = [['#123029', '#1f4a3c', '#3d7a5c'], ['#14262c', '#22414a', '#3f7280'], ['#1b2a1a', '#2d4628', '#5a7a3a']][v];
      const H = 150 + v * 10;
      const flame = (wid, top, base) => {
        g.beginPath();
        g.moveTo(0, top);
        g.bezierCurveTo(wid * 0.9, top + H * 0.25, wid * 1.1, base - H * 0.3, wid * 0.55, base);
        g.quadraticCurveTo(0, base + 6, -wid * 0.55, base);
        g.bezierCurveTo(-wid * 1.1, base - H * 0.3, -wid * 0.9, top + H * 0.25, 0, top);
        g.closePath();
      };
      flame(22, -H, -16);
      ink(g, tones[0], 2.6);
      // lit flank and leaf strokes
      g.save();
      flame(22, -H, -16);
      g.clip();
      g.fillStyle = tones[1];
      g.beginPath(); g.ellipse(-12, -H * 0.5, 14, H * 0.48, 0.08, 0, TAU); g.fill();
      g.strokeStyle = tones[2];
      g.lineWidth = 1.6;
      for (let y = -H + 14; y < -24; y += 9) {
        const w = 18 * Math.sin(((y + H) / H) * Math.PI) + 4;
        g.beginPath(); g.moveTo(-w, y + 4); g.quadraticCurveTo(-w * 0.4, y - 2, -w * 0.05, y + 1); g.stroke();
      }
      g.restore();
    },
  },
  tree: {
    w: 120, h: 165, foot: 12, tall: true,
    draw(g, v, r) {
      shadow(g, 40, 12);
      g.beginPath();
      g.moveTo(-8, 0); g.lineTo(-5, -42); g.lineTo(-16, -60); g.lineTo(-9, -62); g.lineTo(0, -48);
      g.lineTo(10, -64); g.lineTo(16, -60); g.lineTo(6, -42); g.lineTo(9, 0); g.closePath();
      ink(g, '#3e2a20');
      // Elysian emerald, gold and blood-red crowns
      const tones = [['#123a2e', '#21634a', '#c9d36a'], ['#2e2a12', '#5a5a20', '#f0c95a'], ['#3a1218', '#7a2230', '#ff8a6a']][v];
      const blobs = [];
      for (let i = 0; i < 7; i++) blobs.push([(r() - 0.5) * 58, -76 - r() * 40, 21 + r() * 10]);
      blobs.sort((a, b) => a[1] - b[1]);
      g.lineWidth = 5; g.strokeStyle = INK;
      for (const [x, y, rr] of blobs) { circle(g, x, y, rr); g.stroke(); }
      for (const [x, y, rr] of blobs) { circle(g, x, y, rr); g.fillStyle = tones[0]; g.fill(); }
      for (const [x, y, rr] of blobs) { circle(g, x - rr * 0.25, y - rr * 0.25, rr * 0.7); g.fillStyle = tones[1]; g.fill(); }
      // hard rim of light on the upper-left of each clump
      g.strokeStyle = tones[2];
      g.lineWidth = 2.4;
      for (const [x, y, rr] of blobs) {
        g.beginPath(); g.arc(x, y, rr - 2, Math.PI * 1.05, Math.PI * 1.55); g.stroke();
      }
    },
  },
  bush: {
    w: 64, h: 48, foot: 8,
    draw(g, v) {
      shadow(g, 22, 7);
      const tones = [['#123a2e', '#2a6a4c'], ['#1f2a14', '#4a5a24'], ['#2a1420', '#5a2440']][v];
      const pts = [[-12, -10, 12], [10, -11, 12], [0, -19, 13]];
      g.lineWidth = 4.5; g.strokeStyle = INK;
      for (const [x, y, r] of pts) { circle(g, x, y, r); g.stroke(); }
      for (const [x, y, r] of pts) { circle(g, x, y, r); g.fillStyle = tones[0]; g.fill(); }
      for (const [x, y, r] of pts) { circle(g, x - 3, y - 4, r * 0.55); g.fillStyle = tones[1]; g.fill(); }
      g.fillStyle = v === 2 ? '#ff7ab0' : '#ff3b4a';
      for (const [x, y] of [[-10, -14], [6, -20], [12, -8], [-2, -9]]) { circle(g, x, y, 2.2); g.fill(); }
    },
  },
  rock: {
    w: 60, h: 42, foot: 8,
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
      ink(g, '#3f3d4a', 2.6);
      g.beginPath(); g.moveTo(-14, -6); g.lineTo(-6, -17); g.lineTo(7, -19); g.lineTo(-1, -8); g.closePath();
      g.fillStyle = '#6c6a7c'; g.fill();
      g.strokeStyle = 'rgba(8,6,12,0.7)'; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(4, -12); g.lineTo(9, -4); g.stroke();
    },
  },
  house: {
    w: 176, h: 172, foot: 14, tall: true,
    draw(g, v) {
      const roof = ['#8f3424', '#7a2a30', '#9a4a26'][v];
      const roofHi = ['#c25a3a', '#a8454a', '#c9743a'][v];
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.beginPath(); g.ellipse(4, 0, 76, 18, 0, 0, TAU); g.fill();
      // plaster walls with a shaded side
      g.beginPath(); g.rect(-58, -64, 116, 64); ink(g, '#d9ccad', 2.6);
      g.fillStyle = '#a99a7c'; g.fillRect(18, -62, 38, 61);
      g.strokeStyle = 'rgba(60,40,30,0.35)'; g.lineWidth = 1.2;
      for (const y of [-48, -32, -16]) { g.beginPath(); g.moveTo(-56, y); g.lineTo(56, y); g.stroke(); }
      // meander frieze
      g.fillStyle = '#2a1410'; g.fillRect(-58, -64, 116, 9);
      g.strokeStyle = '#e0b25a'; g.lineWidth = 1.4;
      g.beginPath();
      for (let x = -54; x < 54; x += 9) {
        g.moveTo(x, -57); g.lineTo(x, -62); g.lineTo(x + 6, -62); g.lineTo(x + 6, -59); g.lineTo(x + 3, -59);
      }
      g.stroke();
      // door
      g.beginPath(); g.moveTo(-12, 0); g.lineTo(-12, -28); g.lineTo(12, -28); g.lineTo(12, 0); g.closePath();
      ink(g, '#2a1712', 2.2);
      g.fillStyle = '#e0b25a'; circle(g, 7, -13, 1.8); g.fill();
      // lit windows
      for (const wx of [-40, 36]) {
        g.beginPath(); g.rect(wx - 8, -40, 16, 18); ink(g, '#ffc874', 2.2);
        g.fillStyle = '#fff2c4'; g.fillRect(wx - 6, -38, 5, 6);
        g.strokeStyle = INK; g.lineWidth = 2;
        g.beginPath(); g.moveTo(wx, -40); g.lineTo(wx, -22); g.stroke();
      }
      // pediment roof with tiles
      g.beginPath();
      g.moveTo(-76, -60); g.lineTo(0, -122); g.lineTo(76, -60); g.closePath();
      ink(g, roof, 3);
      g.beginPath(); g.moveTo(-76, -60); g.lineTo(0, -122); g.lineTo(-6, -60); g.closePath();
      g.fillStyle = roofHi; g.fill();
      g.strokeStyle = 'rgba(20,6,6,0.35)'; g.lineWidth = 1.6;
      for (let x = -60; x <= 60; x += 12) {
        g.beginPath(); g.moveTo(x, -61); g.lineTo(x * 0.25, -61 - (76 - Math.abs(x)) * 0.8); g.stroke();
      }
      g.strokeStyle = INK; g.lineWidth = 3;
      g.beginPath(); g.moveTo(-76, -60); g.lineTo(0, -122); g.lineTo(76, -60); g.stroke();
      // acroterion
      g.beginPath(); g.arc(0, -124, 5, 0, TAU); ink(g, '#e0b25a', 1.8);
    },
  },
  column: {
    w: 56, h: 150, foot: 10, tall: true,
    draw(g, v) {
      shadow(g, 22, 7);
      const H = v === 2 ? 70 : 120;
      // base
      g.beginPath(); g.rect(-19, -10, 38, 10); ink(g, '#b9ac90');
      g.beginPath(); g.rect(-15, -16, 30, 7); ink(g, '#cfc2a4');
      // shaft
      g.beginPath();
      if (v === 2) {
        g.moveTo(-12, -16); g.lineTo(-12, -H + 8); g.lineTo(-6, -H - 2); g.lineTo(-1, -H + 6); g.lineTo(5, -H - 6); g.lineTo(12, -H + 4); g.lineTo(12, -16);
      } else {
        g.moveTo(-12, -16); g.lineTo(-11, -H); g.lineTo(11, -H); g.lineTo(12, -16);
      }
      g.closePath();
      ink(g, '#d8ccb0', 2.4);
      g.fillStyle = '#9d907a'; g.fillRect(4, -H + 6, 7, H - 22);
      g.strokeStyle = 'rgba(70,55,40,0.55)'; g.lineWidth = 1.3;
      for (const x of [-6, -1, 4]) { g.beginPath(); g.moveTo(x, -18); g.lineTo(x, -H + 8); g.stroke(); }
      if (v !== 2) {
        // capital
        g.beginPath(); g.rect(-17, -H - 10, 34, 10); ink(g, '#cfc2a4');
        g.beginPath(); g.arc(-15, -H - 5, 4, 0, TAU); ink(g, '#b9ac90', 1.6);
        g.beginPath(); g.arc(15, -H - 5, 4, 0, TAU); ink(g, '#b9ac90', 1.6);
        if (v === 1) {
          // a red banner hanging from it
          g.beginPath(); g.moveTo(-9, -H); g.lineTo(9, -H); g.lineTo(9, -H + 46); g.lineTo(0, -H + 38); g.lineTo(-9, -H + 46); g.closePath();
          ink(g, '#9a1f24', 2);
          g.strokeStyle = '#e0b25a'; g.lineWidth = 1.4;
          g.beginPath(); g.arc(0, -H + 18, 5, 0, TAU); g.stroke();
        }
      } else {
        // rubble at its foot
        g.beginPath(); g.ellipse(20, -4, 8, 5, 0.3, 0, TAU); ink(g, '#b9ac90', 1.6);
      }
    },
  },
  amphora: {
    w: 34, h: 50, foot: 6,
    draw(g, v) {
      shadow(g, 11, 4);
      const clay = ['#b5582a', '#1c1412'][v];
      const fig = ['#1c1412', '#c8693a'][v];
      g.beginPath();
      g.moveTo(-4, -38); g.lineTo(4, -38); g.lineTo(3, -32);
      g.bezierCurveTo(14, -28, 13, -8, 4, -2); g.lineTo(5, 0); g.lineTo(-5, 0); g.lineTo(-4, -2);
      g.bezierCurveTo(-13, -8, -14, -28, -3, -32); g.closePath();
      ink(g, clay, 2);
      g.fillStyle = fig; g.fillRect(-10, -22, 20, 6);
      g.strokeStyle = INK; g.lineWidth = 2;
      g.beginPath(); g.moveTo(-3, -34); g.quadraticCurveTo(-10, -34, -8, -26); g.moveTo(3, -34); g.quadraticCurveTo(10, -34, 8, -26); g.stroke();
      g.fillStyle = 'rgba(255,230,200,0.3)'; g.fillRect(-7, -28, 2.5, 14);
    },
  },
  wall: {
    w: 1, h: 1, foot: 0, still: true,   // 画法不随时间变化：只画一次
    live(g, t, p) {
      const { dx, dy } = p;
      const len = Math.hypot(dx, dy);
      // low stone wall: dark top band and a lit face
      g.lineCap = 'butt';
      g.strokeStyle = INK; g.lineWidth = 16;
      g.beginPath(); g.moveTo(0, -8); g.lineTo(dx, dy - 8); g.stroke();
      g.strokeStyle = '#8a8070'; g.lineWidth = 12;
      g.beginPath(); g.moveTo(0, -8); g.lineTo(dx, dy - 8); g.stroke();
      g.strokeStyle = '#b5a98f'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(0, -13); g.lineTo(dx, dy - 13); g.stroke();
      g.strokeStyle = 'rgba(10,8,10,0.6)'; g.lineWidth = 1.2;
      for (let k = 14; k < len; k += 14) {
        const x = (dx * k) / len;
        const y = (dy * k) / len;
        g.beginPath(); g.moveTo(x, y - 14); g.lineTo(x, y - 2); g.stroke();
      }
    },
  },
  well: {
    w: 84, h: 102, foot: 12, tall: true,
    draw(g) {
      shadow(g, 32, 10);
      g.beginPath(); g.rect(-24, -64, 6, 50); ink(g, '#5a3a24');
      g.beginPath(); g.rect(18, -64, 6, 50); ink(g, '#5a3a24');
      g.beginPath(); g.ellipse(0, -14, 28, 10, 0, 0, TAU); g.rect(-28, -14, 56, 14); ink(g, '#8f8778', 2.4);
      g.fillStyle = '#0d1820'; g.beginPath(); g.ellipse(0, -14, 22, 7, 0, 0, TAU); g.fill();
      g.fillStyle = 'rgba(90,200,255,0.35)'; g.beginPath(); g.ellipse(-3, -14, 12, 3, 0, 0, TAU); g.fill();
      g.beginPath(); g.moveTo(-34, -60); g.lineTo(0, -86); g.lineTo(34, -60); g.closePath(); ink(g, '#8f3424', 2.4);
      g.strokeStyle = INK; g.lineWidth = 2; g.beginPath(); g.moveTo(0, -60); g.lineTo(0, -30); g.stroke();
      g.beginPath(); g.rect(-5, -32, 10, 9); ink(g, '#7b5636');
    },
  },
  brazier: {
    w: 1, h: 1, foot: 0, box: [-30, -100, 30, 10],
    live(g, t, p) {
      g.fillStyle = 'rgba(0,0,0,0.4)';
      g.beginPath(); g.ellipse(0, 0, 16, 5, 0, 0, TAU); g.fill();
      // bronze tripod
      g.strokeStyle = INK; g.lineWidth = 5;
      g.beginPath(); g.moveTo(-12, 0); g.lineTo(-4, -30); g.moveTo(12, 0); g.lineTo(4, -30); g.moveTo(0, 2); g.lineTo(0, -30); g.stroke();
      g.strokeStyle = '#a5672a'; g.lineWidth = 2.6;
      g.beginPath(); g.moveTo(-12, 0); g.lineTo(-4, -30); g.moveTo(12, 0); g.lineTo(4, -30); g.moveTo(0, 2); g.lineTo(0, -30); g.stroke();
      // bowl
      g.beginPath(); g.moveTo(-17, -36); g.quadraticCurveTo(0, -18, 17, -36); g.closePath();
      ink(g, '#b7782e', 2.4);
      g.strokeStyle = '#ffd27a'; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(-12, -33); g.quadraticCurveTo(-4, -27, 2, -27); g.stroke();
      flame(g, 0, -36, 0.85, t + p.x, ['#ff4a12', '#ff9a2a', '#fff0a8']);
    },
  },
  campfire: {
    w: 1, h: 1, foot: 0, box: [-60, -180, 70, 16],
    live(g, t) {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.beginPath(); g.ellipse(0, 2, 34, 10, 0, 0, TAU); g.fill();
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * TAU;
        g.beginPath(); g.ellipse(Math.cos(a) * 26, Math.sin(a) * 10, 6.5, 5, 0, 0, TAU); ink(g, '#4a4552', 2);
      }
      g.lineWidth = 7; g.strokeStyle = INK;
      g.beginPath(); g.moveTo(-17, 2); g.lineTo(15, -7); g.moveTo(-15, -7); g.lineTo(17, 2); g.stroke();
      g.lineWidth = 4; g.strokeStyle = '#3a2418';
      g.beginPath(); g.moveTo(-17, 2); g.lineTo(15, -7); g.moveTo(-15, -7); g.lineTo(17, 2); g.stroke();
      flame(g, 0, -2, 1.5, t, ['#e8260c', '#ff8a1a', '#fff0a8']);
      for (let i = 0; i < 5; i++) {
        const k = ((t / 2400 + i / 5) % 1);
        g.fillStyle = `rgba(40,30,36,${0.4 * (1 - k)})`;
        circle(g, Math.sin(k * 6 + i) * 8 + k * 14, -50 - k * 90, 7 + k * 18);
        g.fill();
      }
    },
  },
  soulfire: {
    w: 1, h: 1, foot: 0, box: [-20, -48, 20, 8],
    live(g, t, p) {
      g.fillStyle = 'rgba(80,200,255,0.25)';
      g.beginPath(); g.ellipse(0, 0, 12, 4, 0, 0, TAU); g.fill();
      flame(g, 0, 0, 0.55, t * 0.8 + p.x * 7, ['#1a6cff', '#3ac8ff', '#e8fbff']);
    },
  },
  tomb: {
    w: 52, h: 66, foot: 8,
    draw(g, v) {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.beginPath(); g.ellipse(2, 0, 18, 5, 0, 0, TAU); g.fill();
      if (v === 1) {
        g.beginPath();
        g.rect(-4, -46, 8, 46); g.rect(-15, -36, 30, 8);
        ink(g, '#5c5a70', 2.4);
        g.fillStyle = '#8a88a0'; g.fillRect(-3, -45, 3, 44);
        return;
      }
      g.beginPath();
      if (v === 0) { g.moveTo(-14, 0); g.lineTo(-14, -30); g.arc(0, -30, 14, Math.PI, 0); g.lineTo(14, 0); }
      else { g.moveTo(-13, 0); g.lineTo(-15, -34); g.lineTo(-4, -42); g.lineTo(12, -38); g.lineTo(14, 0); }
      g.closePath();
      ink(g, '#58566c', 2.4);
      g.fillStyle = '#7e7c96'; g.fillRect(-12, -36, 5, 34);
      // a glowing rune
      g.strokeStyle = '#7ae0ff'; g.lineWidth = 1.8;
      g.beginPath(); g.moveTo(-5, -28); g.lineTo(0, -20); g.lineTo(5, -28); g.moveTo(0, -20); g.lineTo(0, -12); g.stroke();
    },
  },
  crypt: {
    w: 150, h: 150, foot: 12, tall: true,
    draw(g) {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.beginPath(); g.ellipse(0, 0, 66, 14, 0, 0, TAU); g.fill();
      g.beginPath(); g.rect(-52, -70, 104, 70); ink(g, '#4a485c', 3);
      g.fillStyle = '#363447'; g.fillRect(16, -68, 35, 67);
      g.beginPath(); g.moveTo(-62, -66); g.lineTo(0, -108); g.lineTo(62, -66); g.closePath(); ink(g, '#3a3848', 3);
      g.beginPath(); g.moveTo(-16, 0); g.lineTo(-16, -34); g.arc(0, -34, 16, Math.PI, 0); g.lineTo(16, 0); g.closePath();
      ink(g, '#7ae0ff', 2.4);
      g.fillStyle = '#e8fbff';
      g.beginPath(); g.moveTo(-8, 0); g.lineTo(-8, -30); g.arc(0, -30, 8, Math.PI, 0); g.lineTo(8, 0); g.closePath(); g.fill();
      g.beginPath(); g.rect(-3, -132, 6, 26); g.rect(-11, -124, 22, 6); ink(g, '#5c5a70', 2);
      for (const x of [-40, 40]) { g.beginPath(); g.rect(x - 6, -66, 12, 66); ink(g, '#5c5a70', 2); }
    },
  },
  deadtree: {
    w: 120, h: 150, foot: 10, tall: true,
    draw(g, v, r) {
      shadow(g, 26, 8);
      const branch = (x, y, ang, len, w, depth) => {
        const x2 = x + Math.cos(ang) * len;
        const y2 = y + Math.sin(ang) * len;
        g.strokeStyle = INK; g.lineWidth = w + 3.5;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
        g.strokeStyle = '#2e2236'; g.lineWidth = w;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
        if (depth <= 0) {
          g.fillStyle = '#7ae0ff';
          circle(g, x2, y2, 1.8); g.fill();
          return;
        }
        branch(x2, y2, ang - 0.45 - r() * 0.3, len * 0.68, w * 0.62, depth - 1);
        branch(x2, y2, ang + 0.35 + r() * 0.3, len * 0.62, w * 0.62, depth - 1);
      };
      branch(0, 0, -Math.PI / 2 + (v - 1) * 0.08, 52, 11, 3);
    },
  },
  tent: {
    w: 134, h: 128, foot: 12, tall: true,
    draw(g, v) {
      const hide = ['#6a3a26', '#5a2e22', '#7a4a2c'][v];
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.beginPath(); g.ellipse(0, 0, 58, 14, 0, 0, TAU); g.fill();
      g.lineWidth = 4; g.strokeStyle = INK;
      g.beginPath(); g.moveTo(-10, -86); g.lineTo(-20, -100); g.moveTo(8, -86); g.lineTo(18, -102); g.moveTo(0, -86); g.lineTo(2, -104); g.stroke();
      g.beginPath(); g.moveTo(-56, 0); g.quadraticCurveTo(-30, -40, 0, -86); g.quadraticCurveTo(30, -40, 56, 0); g.closePath();
      ink(g, hide, 3);
      g.beginPath(); g.moveTo(0, -86); g.quadraticCurveTo(30, -40, 56, 0); g.lineTo(20, 0); g.closePath();
      g.fillStyle = 'rgba(0,0,0,0.3)'; g.fill();
      g.strokeStyle = '#c0281c'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(-40, -22); g.quadraticCurveTo(0, -30, 40, -22); g.stroke();
      g.beginPath(); g.moveTo(-14, 0); g.lineTo(0, -44); g.lineTo(14, 0); g.closePath(); ink(g, '#120806', 2.4);
    },
  },
  totem: {
    w: 64, h: 145, foot: 8, tall: true,
    draw(g) {
      shadow(g, 16, 5);
      g.beginPath(); g.rect(-6, -96, 12, 96); ink(g, '#4a3020');
      g.strokeStyle = '#c0281c'; g.lineWidth = 3;
      for (const y of [-30, -50]) { g.beginPath(); g.moveTo(-6, y); g.lineTo(6, y - 4); g.stroke(); }
      g.beginPath(); g.ellipse(0, -104, 13, 12, 0, 0, TAU); ink(g, '#ebe5d2');
      g.beginPath(); g.rect(-8, -96, 16, 8); ink(g, '#ebe5d2', 1.6);
      g.fillStyle = '#ff5a14';
      g.beginPath(); g.ellipse(-5, -105, 3.5, 4, 0, 0, TAU); g.ellipse(5, -105, 3.5, 4, 0, 0, TAU); g.fill();
      g.beginPath(); g.moveTo(-11, -110); g.quadraticCurveTo(-26, -114, -24, -128); g.quadraticCurveTo(-18, -118, -8, -115); g.closePath();
      ink(g, '#d9cdb0', 1.6);
      g.beginPath(); g.moveTo(11, -110); g.quadraticCurveTo(26, -114, 24, -128); g.quadraticCurveTo(18, -118, 8, -115); g.closePath();
      ink(g, '#d9cdb0', 1.6);
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
        ink(g, '#e6dfcb', 1.6);
        g.restore();
      };
      bone(-10, -3, 0.3, 18);
      bone(8, -5, -0.6, 16);
      if (v !== 2) {
        g.beginPath(); g.ellipse(2, -9, 8, 7, 0, 0, TAU); ink(g, '#ebe5d2', 1.8);
        g.fillStyle = INK;
        g.beginPath(); g.ellipse(-1, -10, 2, 2.4, 0, 0, TAU); g.ellipse(5, -10, 2, 2.4, 0, 0, TAU); g.fill();
      }
    },
  },
  stake: {
    w: 30, h: 70, foot: 6,
    draw(g, v) {
      g.fillStyle = 'rgba(0,0,0,0.4)';
      g.beginPath(); g.ellipse(0, 0, 9, 3, 0, 0, TAU); g.fill();
      g.save();
      g.rotate((v ? 0.12 : -0.1));
      g.beginPath(); g.moveTo(-6, 0); g.lineTo(-6, -42); g.lineTo(0, -54); g.lineTo(6, -42); g.lineTo(6, 0); g.closePath();
      ink(g, '#4a2e1c');
      g.fillStyle = '#6e4a2c'; g.fillRect(-5, -42, 4, 41);
      g.fillStyle = '#c0281c'; g.beginPath(); g.moveTo(-3, -50); g.lineTo(0, -54); g.lineTo(3, -50); g.closePath(); g.fill();
      g.restore();
    },
  },
};

// flame draws a flickering fire with its base at (x, y).
function flame(g, x, y, s, t, colors) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  const layers = [[colors[0], 1, 0], [colors[1], 0.72, 1.3], [colors[2], 0.42, 2.6]];
  // ink tongue behind the fire keeps it readable on light ground
  g.fillStyle = INK;
  g.beginPath();
  g.moveTo(-13, 1); g.quadraticCurveTo(-14, -16, Math.sin(t / 110) * 3, -32); g.quadraticCurveTo(14, -16, 13, 1); g.closePath();
  g.fill();
  for (const [color, k, ph] of layers) {
    const sway = Math.sin(t / 110 + ph) * 3 * k;
    const h = (28 + Math.sin(t / 70 + ph * 2) * 4) * k;
    const w = 11 * k;
    g.beginPath();
    g.moveTo(-w, 0);
    g.quadraticCurveTo(-w * 1.1, -h * 0.5, sway, -h);
    g.quadraticCurveTo(w * 1.1, -h * 0.5, w, 0);
    g.quadraticCurveTo(0, w * 0.4, -w, 0);
    g.fillStyle = color;
    g.fill();
  }
  for (let i = 0; i < 4; i++) {
    const k = ((t / 900 + i / 4) % 1);
    g.fillStyle = colors[2];
    g.globalAlpha = 1 - k;
    g.fillRect(Math.sin(i * 9 + k * 5) * 10, -22 - k * 40, 2, 2);
  }
  g.restore();
}
