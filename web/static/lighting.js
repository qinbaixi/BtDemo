// Dynamic lighting. The world is drawn fully lit; this pass then lays a dark,
// cool shadow over the screen with holes carved where lights are, and adds
// each light's colour on top. Lights are collected fresh every frame from the
// player, fires, braziers, lava and active effects.

const SCALE = 0.5;               // lightmap resolution relative to CSS pixels

const spriteCache = new Map();

// falloff is a white radial sprite with a soft, slightly flattened core.
function falloff() {
  let s = spriteCache.get(':falloff');
  if (s) return s;
  s = document.createElement('canvas');
  s.width = s.height = 128;
  const g = s.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.8)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  spriteCache.set(':falloff', s);
  return s;
}

// tint is a coloured radial sprite for the additive colour pass.
function tint(color) {
  let s = spriteCache.get(color);
  if (s) return s;
  s = document.createElement('canvas');
  s.width = s.height = 128;
  const g = s.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  spriteCache.set(color, s);
  return s;
}

export function createLighting() {
  const map = document.createElement('canvas');
  const m = map.getContext('2d');
  // the coloured glow is also accumulated at low resolution, then blended
  // over the screen in one pass
  const tintMap = document.createElement('canvas');
  const t = tintMap.getContext('2d');
  const lights = [];

  return {
    // ambient is the darkness laid over unlit ground.
    ambient: 'rgba(10,6,22,0.58)',

    begin() { lights.length = 0; },

    // add registers a light in world coordinates. glow (0..1) scales the
    // additive colour pass; strength (0..1) how much darkness it removes.
    add(x, y, radius, color, strength = 1, glow = 0.35) {
      if (radius > 1 && strength > 0.01) lights.push({ x, y, radius, color, strength, glow });
    },

    // render composites the light pass over the scene. view is the camera
    // rectangle in world units; the caller's transform must be the identity
    // (in CSS pixels times dpr) when this runs.
    render(ctx, view, dpr) {
      const w = Math.ceil(view.w * SCALE);
      const h = Math.ceil(view.h * SCALE);
      if (map.width !== w || map.height !== h) {
        map.width = w; map.height = h;
        tintMap.width = w; tintMap.height = h;
      }
      t.globalCompositeOperation = 'source-over';
      t.globalAlpha = 1;
      t.clearRect(0, 0, w, h);
      t.globalCompositeOperation = 'lighter';
      m.globalCompositeOperation = 'source-over';
      m.globalAlpha = 1;
      m.clearRect(0, 0, w, h);
      m.fillStyle = this.ambient;
      m.fillRect(0, 0, w, h);
      m.globalCompositeOperation = 'destination-out';
      const white = falloff();
      for (const l of lights) {
        const x = (l.x - view.x) * SCALE;
        const y = (l.y - view.y) * SCALE;
        const r = l.radius * SCALE;
        if (x + r < 0 || y + r < 0 || x - r > w || y - r > h) continue;
        m.globalAlpha = Math.min(1, l.strength);
        // lights sit on the ground plane: squash them like the camera does
        m.drawImage(white, x - r, y - r * 0.8, r * 2, r * 1.6);
        if (l.glow > 0) {
          const rr = r * 0.85;
          t.globalAlpha = Math.min(1, l.glow * l.strength);
          t.drawImage(tint(l.color), x - rr, y - rr * 0.8, rr * 2, rr * 1.6);
        }
      }

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(map, 0, 0, w, h, 0, 0, view.w, view.h);
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(tintMap, 0, 0, w, h, 0, 0, view.w, view.h);
      ctx.restore();
    },
  };
}
