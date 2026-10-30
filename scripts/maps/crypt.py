# 生成第二关「亡者地穴」地图：python3 scripts/maps/crypt.py config/maps/graveyard.tmj config/maps/crypt.tmj
# 从上往下走：0 守夜人篝火 → 1 断碑走廊 → 2 骨堆大厅 → 岔路 3A 灵火回廊（暗、点灯、钥匙）/ 3B 渗水墓道（积水）
# → 4 地下礼拜堂（存档、捷径回 0）→ 5 墓穴守卫 → 6 献祭坑（首领）→ 7 出口。3A 左边是守墓人密室（裂墙 + 钥匙）。
# 第一个参数是拿来抄文件头和碰撞形状（shape.* 属性）的地图。改完重新生成，再用 Tiled 打开看一眼。
import json, random, sys
random.seed(23)
W, H, T = 1600, 4160, 32
ROOMS = {  # id: (x, y, w, h), 标题
  'r0': ((620, 80, 360, 260), '守夜人篝火'),
  'r1': ((360, 460, 880, 360), '断碑走廊'),
  'r2': ((300, 960, 1000, 520), '骨堆大厅'),
  'r3a': ((300, 1620, 480, 600), '灵火回廊'),
  'secret': ((40, 1760, 200, 220), '守墓人密室'),
  'r3b': ((880, 1620, 500, 600), '渗水墓道'),
  'r4': ((500, 2360, 600, 300), '地下礼拜堂'),
  'r5': ((420, 2800, 760, 400), '墓穴守卫'),
  'r6': ((440, 3320, 720, 560), '献祭坑'),
  'r7': ((700, 3960, 200, 140), '坑底出口'),
}
CORRIDORS = [
  (750, 340, 100, 120), (750, 820, 100, 140),
  (420, 1480, 100, 140), (1080, 1480, 100, 140),
  (560, 2220, 100, 140), (980, 2220, 100, 140),
  (750, 2660, 100, 140), (750, 3200, 100, 120), (750, 3880, 100, 80),
  (240, 1840, 60, 80),                                        # 3A → 密室
  (980, 200, 560, 80), (1460, 200, 80, 2380), (1100, 2500, 440, 80),  # 捷径：礼拜堂 → 篝火
]
KEY = '守墓人钥匙'
GATES = [  # id, rect, after, to, breakable, key
  ('g_r1_in', (750, 444, 100, 16), '', 'r1', '', ''),
  ('g_r1_out', (750, 824, 100, 16), 'r1', 'r2', '', ''),
  ('g_r2_a', (420, 1484, 100, 16), 'r2', 'r3a', '', ''),
  ('g_r2_b', (1080, 1484, 100, 16), 'r2', 'r3b', '', ''),
  ('g_vault', (262, 1840, 16, 80), '', 'secret', 'cracked_wall', KEY),
  ('g_r3a_out', (560, 2224, 100, 16), 'r3a', 'r4', '', ''),
  ('g_r3b_out', (980, 2224, 100, 16), 'r3b', 'r4', '', ''),
  ('g_r4_out', (750, 2664, 100, 16), 'r4', 'r5', '', ''),
  ('g_r5_out', (750, 3204, 100, 16), 'r5', 'r6', '', ''),
  ('g_r6_out', (750, 3884, 100, 16), 'r6', 'r7', '', ''),
  ('g_shortcut', (984, 200, 16, 80), 'r4', '', '', ''),
]
WATER = [(880, 1760, 500, 140), (880, 1980, 260, 240), (1220, 2040, 160, 180)]  # 3B 的积水
C = 20
cols, rows = W // C, H // C
walk = [[False] * cols for _ in range(rows)]
for x, y, w, h in [rect for rect, _ in ROOMS.values()] + CORRIDORS:
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
def wall(ax, ay, bx, by):
  return {'id': nid(), 'name': '', 'type': 'wall', 'x': ax, 'y': ay, 'width': 0, 'height': 0, 'rotation': 0, 'visible': True,
          'polyline': [{'x': 0, 'y': 0}, {'x': bx - ax, 'y': by - ay}]}
props = [wall(ax, ay, bx, by) for (ax, ay), (bx, by) in segs]
TYPES = {'s': 'float', 'v': 'int', 'flip': 'bool'}
def point(kind, x, y, **pr):
  o = {'id': nid(), 'name': '', 'type': kind, 'x': x, 'y': y, 'width': 0, 'height': 0, 'rotation': 0, 'visible': True, 'point': True}
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
# 墙外的岩体：一圈乱石和断柱（只是看的，碰撞在墙上）
for gy in range(30, H, 54):
  for gx in range(30, W, 54):
    x, y = gx + random.uniform(-16, 16), gy + random.uniform(-16, 16)
    if not (0 < x < W and 0 < y < H): continue
    d = dist_walk(x, y)
    if d < 40 or d > 130: continue
    kind = random.choice(['rock', 'rock', 'rock', 'column', 'tomb'])
    props.append(point(kind, round(x), round(y), v=random.randint(0, 2), s=round(random.uniform(1.0, 1.5), 2), flip=random.random() < 0.5))
# 0 守夜人篝火：蓝色篝火、石碑
props += [point('campfire', 700, 220), point('tomb', 900, 140, v=2), point('column', 650, 110), point('column', 950, 110)]
# 1 断碑走廊：墓碑当掩体，弓手站在下面的高台上
for x, y in [(520, 600), (700, 640), (880, 590), (1060, 640), (600, 720), (980, 730), (800, 520)]:
  props.append(point('tomb', x, y, v=random.randint(0, 2), s=1.3))
props += [point('column', 400, 780), point('column', 1200, 780), point('bones', 1150, 520)]
# 2 骨堆大厅：骨头散落，四根柱子
for x, y in [(480, 1100), (1120, 1100), (480, 1360), (1120, 1360)]:
  props.append(point('column', x, y, s=1.2))
props += [point('bones', 700, 1200, v=1), point('bones', 900, 1300, v=2), point('bones', 620, 1420), point('tomb', 1000, 1040, v=1)]
# 3A 灵火回廊：中间是雕像（实体），角落的陶罐和骨头；左墙的裂缝（裂墙实体）后面是密室
props += [point('amphora', 330, 2180), point('bones', 740, 1660, v=2), point('bones', 340, 1990, v=1)]
# 密室：守墓人的遗物
props += [point('tomb', 140, 1800, v=2, s=1.2), point('amphora', 80, 1940), point('bones', 190, 1950, v=1), point('totem', 70, 1790)]
# 3B 渗水墓道：水里的断碑，干地上的墓碑
props += [point('tomb', 1300, 1700, v=1), point('tomb', 950, 1680), point('column', 1300, 1960), point('bones', 1180, 2160)]
# 4 地下礼拜堂：柱子、蓝火（泉水是回血区）
props += [point('column', 560, 2420), point('column', 1040, 2420), point('brazier', 700, 2400), point('brazier', 900, 2400), point('tomb', 800, 2390, v=2, s=1.3)]
# 5 墓穴守卫：两边墓碑当掩体
props += [point('tomb', 560, 2960), point('tomb', 1040, 2960), point('tomb', 620, 3100, v=1), point('tomb', 980, 3100, v=1), point('bones', 800, 2880)]
# 6 献祭坑：四根石柱（首领冲撞会撞碎，P3），坑边骨头台子
for x, y in [(620, 3480), (980, 3480), (620, 3720), (980, 3720)]:
  props.append(point('column', x, y, s=1.6))
props += [point('bones', 500, 3600, v=2), point('bones', 1100, 3600, v=2), point('totem', 800, 3360)]
# 7 出口
props += [point('brazier', 740, 4060), point('brazier', 860, 4060)]
def Z(n, x, y):
  return {'id': nid(), 'name': n, 'type': 'zone', 'x': x, 'y': y, 'width': 0, 'height': 0, 'rotation': 0, 'visible': True, 'point': True}
zones = [Z('graveyard', x + w / 2, y + h / 2) for (x, y, w, h), _ in ROOMS.values()] + [Z('camp', 760, 220)]
roads = []
def road(*pts):
  x0, y0 = pts[0]
  roads.append({'id': nid(), 'name': '', 'type': 'road', 'x': x0, 'y': y0, 'width': 0, 'height': 0, 'rotation': 0, 'visible': True,
                'polyline': [{'x': x - x0, 'y': y - y0} for x, y in pts]})
road((800, 140), (800, 460), (800, 820), (800, 1200), (470, 1500), (470, 1640))
road((800, 1200), (1130, 1500), (1130, 1640))
road((800, 2380), (800, 2800), (800, 3320))
def rect(n, x, y, w, h, pr, cls):
  o = {'id': nid(), 'name': n, 'type': cls, 'x': x, 'y': y, 'width': w, 'height': h, 'rotation': 0, 'visible': True}
  if pr: o['properties'] = pr
  return o
S = lambda n, v: {'name': n, 'type': 'string', 'value': v}
rooms = [rect(rid, *rc, [S('title', t)], 'room') for rid, (rc, t) in ROOMS.items()]
gates = []
for gid, rc, after, to, brk, key in GATES:
  pr = [S(n, v) for n, v in [('after', after), ('to', to), ('breakable', brk), ('key', key)] if v]
  gates.append(rect(gid, *rc, pr, 'gate'))
water = [rect('', *rc, [], 'water') for rc in WATER]
portals = [
  {'id': nid(), 'name': 'to_graveyard', 'class': 'portal', 'x': 800, 'y': 110, 'width': 0, 'height': 0, 'rotation': 0, 'visible': True, 'point': True,
   'properties': [S('to', 'graveyard'), {'name': 'r', 'type': 'float', 'value': 30}]},
  {'id': nid(), 'name': 'exit_graveyard', 'class': 'portal', 'x': 800, 'y': 4040, 'width': 0, 'height': 0, 'rotation': 0, 'visible': True, 'point': True,
   'properties': [S('to', 'graveyard'), {'name': 'r', 'type': 'float', 'value': 30}]},
]
base = json.load(open(sys.argv[1]))
layer = lambda i, n, objs: {'id': i, 'name': n, 'type': 'objectgroup', 'draworder': 'topdown', 'opacity': 1, 'visible': True, 'x': 0, 'y': 0, 'objects': objs}
m = {k: v for k, v in base.items() if k != 'layers'}
m.update({'width': W // T, 'height': H // T, 'nextlayerid': 9, 'nextobjectid': nid() + 1})
m['layers'] = [layer(1, 'zones', zones), layer(2, 'roads', roads), layer(7, 'water', water), layer(3, 'props', props),
               layer(4, 'portals', portals), layer(5, 'rooms', rooms), layer(6, 'gates', gates)]
json.dump(m, open(sys.argv[2], 'w'), ensure_ascii=False, indent=1)
print(len(props), 'props', len(segs), 'walls')
