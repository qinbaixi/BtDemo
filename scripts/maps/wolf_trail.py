# 生成第一关「黑松林道」地图：python3 scripts/maps/wolf_trail.py config/maps/village.tmj config/maps/wolf_trail.tmj
# 坐标先按 OY=0 写，最后整体往下挪 OY。改完重新生成，再用 Tiled 打开看一眼。
import json, random, sys
random.seed(11)
OY = 600
W, H, T = 1600, 3488, 32
def r(x, y, w, h): return (x, y + OY, w, h)
ROOMS = {  # id: rect, title
  'r0': (r(560, 2560, 480, 300), '林口营地'),
  'r1': (r(160, 2040, 600, 400), '落叶小径'),
  'secret': (r(100, 1700, 260, 200), '古树洞'),
  'r2': (r(900, 1920, 600, 460), '狼迹空地'),
  'r3a': (r(900, 1240, 220, 540), '倒木隘口'),
  'r3b': (r(1200, 1300, 340, 480), '蘑菇洼地'),
  'r4': (r(880, 800, 620, 320), '猎人小屋'),
  'r5': (r(840, 360, 700, 320), '狼穴前'),
  'r6': (r(860, -300, 680, 560), '灰鬃狼王'),
  'r7': (r(1100, -540, 200, 160), '狼穴深处'),
}
CORRIDORS = [r(*c) for c in [
  (600, 2440, 100, 120), (180, 1900, 80, 140), (760, 2120, 140, 100),
  (960, 1780, 100, 140), (1340, 1780, 100, 140),
  (960, 1120, 100, 120), (1340, 1120, 100, 180),
  (1140, 680, 100, 120), (1140, 260, 100, 100), (1150, -380, 100, 80),
  (40, 880, 840, 100), (40, 880, 100, 1880), (40, 2660, 520, 100),
]]
GATES = [  # id, rect, after, to, breakable
  ('g_r1_in', r(600, 2444, 100, 16), '', 'r1', ''),
  ('g_secret', r(180, 1904, 80, 16), '', 'secret', 'bramble'),
  ('g_r1_out', r(764, 2120, 16, 100), 'r1', 'r2', ''),
  ('g_r2_a', r(960, 1784, 100, 16), 'r2', 'r3a', ''),
  ('g_r2_b', r(1340, 1784, 100, 16), 'r2', 'r3b', ''),
  ('g_r3a_out', r(960, 1224, 100, 16), 'r3a', 'r4', ''),
  ('g_r3b_out', r(1340, 1284, 100, 16), 'r3b', 'r4', ''),
  ('g_r4_out', r(1140, 784, 100, 16), 'r4', 'r5', ''),
  ('g_r5_out', r(1140, 344, 100, 16), 'r5', 'r6', ''),
  ('g_r6_out', r(1150, -384, 100, 16), 'r6', 'r7', ''),
  ('g_shortcut', r(544, 2660, 16, 100), 'r4', '', ''),
]
C = 20
cols, rows = W // C, H // C
walk = [[False] * cols for _ in range(rows)]
for (x, y, w, h), _ in ROOMS.values():
  for rr in range(y // C, (y + h) // C):
    for c in range(x // C, (x + w) // C): walk[rr][c] = True
for x, y, w, h in CORRIDORS:
  for rr in range(y // C, (y + h) // C):
    for c in range(x // C, (x + w) // C): walk[rr][c] = True
def isw(rr, c): return 0 <= rr < rows and 0 <= c < cols and walk[rr][c]
segs = []
for rr in range(rows + 1):
  c = 0
  while c < cols:
    if isw(rr, c) != isw(rr - 1, c):
      c0 = c
      while c < cols and isw(rr, c) != isw(rr - 1, c): c += 1
      segs.append(((c0 * C, rr * C), (c * C, rr * C)))
    else: c += 1
for c in range(cols + 1):
  rr = 0
  while rr < rows:
    if isw(rr, c) != isw(rr, c - 1):
      r0 = rr
      while rr < rows and isw(rr, c) != isw(rr, c - 1): rr += 1
      segs.append(((c * C, r0 * C), (c * C, rr * C)))
    else: rr += 1
oid = [0]
def nid():
  oid[0] += 1; return oid[0]
props = []
for (ax, ay), (bx, by) in segs:
  props.append({'id': nid(), 'name': '', 'type': 'wall', 'x': ax, 'y': ay, 'width': 0, 'height': 0, 'rotation': 0, 'visible': True,
                'polyline': [{'x': 0, 'y': 0}, {'x': bx - ax, 'y': by - ay}]})
TYPES = {'s': 'float', 'v': 'int', 'flip': 'bool'}
def point(kind, x, y, **pr):
  o = {'id': nid(), 'name': '', 'type': kind, 'x': x, 'y': y + OY, 'width': 0, 'height': 0, 'rotation': 0, 'visible': True, 'point': True}
  if pr: o['properties'] = [{'name': k, 'type': TYPES[k], 'value': v} for k, v in pr.items()]
  return o
def dist_walk(x, y):
  best = 1e9
  for rr in range(max(0, int(y // C) - 9), min(rows, int(y // C) + 10)):
    for c in range(max(0, int(x // C) - 9), min(cols, int(x // C) + 10)):
      if walk[rr][c]:
        cx, cy = c * C + C / 2, rr * C + C / 2
        best = min(best, ((cx - x) ** 2 + (cy - y) ** 2) ** 0.5)
  return best
for gy in range(30, H, 58):
  for gx in range(30, W, 58):
    x, y = gx + random.uniform(-18, 18), gy + random.uniform(-18, 18)
    if not (0 < x < W and 0 < y < H): continue
    d = dist_walk(x, y)
    if d < 46 or d > 170: continue
    kind = random.choice(['tree', 'tree', 'cypress', 'deadtree'])
    o = point(kind, round(x), round(y) - OY, v=random.randint(0, 2), s=round(random.uniform(0.9, 1.25), 2), flip=random.random() < 0.5)
    props.append(o)
# 营地
props += [point('campfire', 720, 2640), point('tent', 930, 2630, v=1), point('stake', 600, 2830), point('stake', 1000, 2830)]
# 落叶小径：落叶、碎石、左上角颜色深一点的灌木丛就是秘密房的入口（荆棘丛在门里）
props += [point('rock', 360, 2180), point('rock', 560, 2320, s=0.7), point('rock', 260, 2360, s=0.7), point('deadtree', 640, 2110, v=1), point('bones', 420, 2400)]
# 古树洞
props += [point('deadtree', 230, 1760, v=2, s=1.4), point('bones', 160, 1860, v=2), point('amphora', 300, 1840), point('totem', 320, 1740)]
# 狼迹空地：中间倒木（墙）卡位、骨头
props += [point('rock', 1140, 2100, s=1.2), point('rock', 1260, 2200), point('deadtree', 1000, 2280, v=2), point('bones', 1380, 2010), point('bones', 1100, 2300, v=1)]
props.append({'id': nid(), 'name': '', 'type': 'wall', 'x': 1160, 'y': 2160 + OY, 'width': 0, 'height': 0, 'rotation': 0, 'visible': True, 'polyline': [{'x': 0, 'y': 0}, {'x': 160, 'y': -40}]})
# 倒木隘口：两根倒木把隘口压窄
props += [point('rock', 990, 1540), point('deadtree', 1060, 1440, v=0), point('bones', 960, 1680, v=1)]
props.append({'id': nid(), 'name': '', 'type': 'wall', 'x': 900, 'y': 1400 + OY, 'width': 0, 'height': 0, 'rotation': 0, 'visible': True, 'polyline': [{'x': 0, 'y': 0}, {'x': 120, 'y': 20}]})
props.append({'id': nid(), 'name': '', 'type': 'wall', 'x': 1120, 'y': 1620 + OY, 'width': 0, 'height': 0, 'rotation': 0, 'visible': True, 'polyline': [{'x': 0, 'y': 0}, {'x': -120, 'y': 20}]})
# 蘑菇洼地
props += [point('rock', 1470, 1660), point('rock', 1260, 1420, s=0.8), point('bones', 1300, 1720, v=2), point('totem', 1460, 1360)]
# 猎人小屋
props += [point('house', 1360, 920, v=2, flip=True), point('well', 1000, 900), point('stake', 920, 1080), point('stake', 1460, 1080), point('tent', 1050, 1060, v=2, s=0.8)]
# 狼穴前：骨头堆、图腾
props += [point('bones', 900, 400), point('bones', 1480, 420, v=1), point('bones', 1200, 520, v=2), point('totem', 880, 640), point('totem', 1500, 640), point('rock', 1020, 600), point('rock', 1380, 460)]
# 狼王场地：四块大石头（扑杀撞上去会晕），一圈骨头
for x, y in [(1030, -160), (1370, -160), (1030, 80), (1370, 80)]:
  props.append(point('rock', x, y, s=1.7))
props += [point('bones', 900, -260), point('bones', 1500, -250, v=1), point('bones', 920, 220, v=2), point('bones', 1490, 230), point('totem', 1200, -280)]
# 狼穴深处
props += [point('bones', 1140, -500, v=2), point('brazier', 1280, -510)]
Z = lambda n, x, y: {'id': nid(), 'name': n, 'type': 'zone', 'x': x, 'y': y + OY, 'width': 0, 'height': 0, 'rotation': 0, 'visible': True, 'point': True}
zones = [Z('forest', 460, 2240), Z('forest', 1190, 2140), Z('forest', 1010, 1500), Z('forest', 1370, 1540), Z('meadow', 1190, 960), Z('forest', 800, 2720),
         Z('forest', 90, 1800), Z('forest', 1190, 520), Z('camp', 1200, -20), Z('forest', 230, 1800)]
roads = []
def road(*pts):
  x0, y0 = pts[0]
  roads.append({'id': nid(), 'name': '', 'type': 'road', 'x': x0, 'y': y0 + OY, 'width': 0, 'height': 0, 'rotation': 0, 'visible': True,
                'polyline': [{'x': x - x0, 'y': y - y0} for x, y in pts]})
road((800, 2850), (760, 2680), (650, 2500), (560, 2320), (460, 2200), (600, 2170), (830, 2170), (1050, 2140), (1190, 2100), (1010, 1930), (1010, 1580), (1010, 1260), (1150, 1100), (1190, 980), (1190, 700), (1190, 500), (1190, 300))
road((1190, 2100), (1390, 1930), (1390, 1580), (1390, 1280), (1190, 1100))
def rect(n, x, y, w, h, pr, cls):
  o = {'id': nid(), 'name': n, 'type': cls, 'x': x, 'y': y, 'width': w, 'height': h, 'rotation': 0, 'visible': True}
  if pr: o['properties'] = pr
  return o
S = lambda n, v: {'name': n, 'type': 'string', 'value': v}
rooms = [rect(rid, *rc, [S('title', t)], 'room') for rid, (rc, t) in ROOMS.items()]
gates = []
for gid, rc, after, to, brk in GATES:
  pr = []
  if after: pr.append(S('after', after))
  if to: pr.append(S('to', to))
  if brk: pr.append(S('breakable', brk))
  gates.append(rect(gid, *rc, pr, 'gate'))
portals = [
  {'id': nid(), 'name': 'to_village', 'class': 'portal', 'x': 800, 'y': 2848 + OY, 'width': 0, 'height': 0, 'rotation': 0, 'visible': True, 'point': True,
   'properties': [S('to', 'village'), {'name': 'r', 'type': 'float', 'value': 30}]},
  {'id': nid(), 'name': 'to_graveyard', 'class': 'portal', 'x': 1200, 'y': -480 + OY, 'width': 0, 'height': 0, 'rotation': 0, 'visible': True, 'point': True,
   'properties': [S('to', 'graveyard'), {'name': 'r', 'type': 'float', 'value': 34}]},
]
village = json.load(open(sys.argv[1]))
layer = lambda i, n, objs: {'id': i, 'name': n, 'type': 'objectgroup', 'draworder': 'topdown', 'opacity': 1, 'visible': True, 'x': 0, 'y': 0, 'objects': objs}
m = {k: v for k, v in village.items() if k != 'layers'}
m.update({'width': W // T, 'height': H // T, 'nextlayerid': 8, 'nextobjectid': nid() + 1})
m['layers'] = [layer(1, 'zones', zones), layer(2, 'roads', roads), layer(3, 'props', props), layer(4, 'portals', portals), layer(5, 'rooms', rooms), layer(6, 'gates', gates)]
json.dump(m, open(sys.argv[2], 'w'), ensure_ascii=False, indent=1)
print(len(props), 'props', len(segs), 'walls, OY', OY)
