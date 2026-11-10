# 用 Blender 做骑士（玩家主角）的模型，并渲染成游戏用的动画表（sprite sheet）。
#
# 用法（不需要显卡，Blender 以 Python 模块的方式跑，见同目录 README.md）：
#   python tools/blender/knight.py sheet  <输出目录>     渲染整张动画表 knight.png + 清单片段 knight.json
#   python tools/blender/knight.py poses  <输出目录>     每个动画挑几帧放大渲染，检查造型用
#   python tools/blender/knight.py turn   <输出目录>     转一圈的展示图
#   python tools/blender/knight.py blend  <输出目录>     只保存 knight.blend（可以用 Blender 打开看）
#
# 整体思路：
#   1. 模型：全部用代码拼出来（旋转体、椭球、胶囊、挤出的多边形），每个部件挂在一个“关节”空物体下面。
#   2. 姿势：pose_xxx(k) 返回一帧的姿势参数（手、脚放哪儿，身体前倾多少……），solve() 用两节骨骼的 IK
#      算出每个关节的位置和朝向。
#   3. 着色：赛璐璐（硬边两层明暗 + 金属高光 + 背光侧的细亮边），全部用自发光节点算，不受场景灯光影响；
#      内部结构线用 Freestyle 画。外描边不画（游戏里的着色器会加）。
#   4. 相机：正交相机，从侧前方略微俯视。角色朝右，游戏里朝左时整体水平翻转。
#
# 单位：1 个 Blender 单位 = 程序模型的 1 个“模型单位”（半径 16 的角色站立高度约 45）。
# 坐标：X 朝前（角色面朝的方向），Y 朝角色左手边（离镜头远的一侧），Z 朝上，脚底在 Z = 0。

import json
import math
import os
import sys

import bpy
import bmesh  # 必须在 bpy 之后导入
from mathutils import Matrix, Vector

# ---------------------------------------------------------------- 基本参数

FRAME_W, FRAME_H = 240, 212        # 动画表每格的大小（像素），和 docs/art-spec.md 一致
ANCHOR = (120, 140)                # 格子里脚底中心的位置
PX_PER_UNIT = 2.5                  # 每个模型单位几个图片像素（ppu 2 × 模型放大 1.25）
SUPER = 2                          # 超采样倍数：先按 2 倍渲染再缩小，边缘更干净
CAM_YAW = math.radians(30)         # 相机往角色正面偏多少（0 = 纯侧面）
CAM_PITCH = math.radians(16)       # 相机俯视的角度

INK = '#0b0710'                    # 墨线
SHADOW_TINT = '#2a1438'            # 暗部偏冷紫
LIGHT_TINT = '#ffe6b0'             # 高光偏暖金

# 默认外观：圣骑士（和 models.ts 的 KNIGHT_SKINS.paladin 同一套配色）
LOOK = {
    'player': '#4da3ff',           # 玩家颜色：外袍、袖子、披风、羽饰、盾面
    'steel': '#c3cbd6',
    'trim': '#e2b04a',
    'legs': '#4a5160',
    'boots': '#2b2f3a',
    'hand': '#8a6a4c',
    'skin': '#f0c8a0',
    'blade': '#e8eef5',
    'gem': '#ff4a3a',
}


def hex_rgb(text):
    text = text.lstrip('#')
    return tuple(int(text[i:i + 2], 16) / 255 for i in (0, 2, 4))


def to_linear(channel):
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def linear_rgba(rgb):
    return (to_linear(rgb[0]), to_linear(rgb[1]), to_linear(rgb[2]), 1.0)


def mix_rgb(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def shade(text, amount):
    """amount > 0 往白色调亮，< 0 往黑色调暗（和 models.ts 的 shade 一样的用法）。"""
    rgb = hex_rgb(text)
    target = (1, 1, 1) if amount > 0 else (0, 0, 0)
    mixed = mix_rgb(rgb, target, abs(amount))
    return '#' + ''.join(f'{round(c * 255):02x}' for c in mixed)


# ---------------------------------------------------------------- 相机和光照方向

def camera_axes():
    """返回 (朝向镜头的方向, 画面右方向, 画面上方向)，都是世界坐标里的单位向量。"""
    toward = Vector((
        math.sin(CAM_YAW) * math.cos(CAM_PITCH),
        -math.cos(CAM_YAW) * math.cos(CAM_PITCH),
        math.sin(CAM_PITCH),
    ))
    right = Vector((0, 0, 1)).cross(toward).normalized() * -1
    up = toward.cross(right).normalized() * -1
    return toward, right, up


def light_vectors():
    """主光在画面左上、偏向镜头；背光的亮边来自画面右后方。"""
    toward, right, up = camera_axes()
    main = (-0.42 * right + 0.6 * up + 0.8 * toward).normalized()
    half = (main + toward).normalized()
    rim = (0.85 * right + 0.1 * up - 0.5 * toward).normalized()
    return main, half, rim


# ---------------------------------------------------------------- 材质（赛璐璐）

MATERIALS = {}


def cel_material(color, kind='matte'):
    """
    kind:
      matte  布、皮：亮面 / 暗面两层
      metal  金属：再加一块硬边高光
      flat   不受光（眼睛、墨色的缝）
      glow   自发光（宝石）：只有很浅的明暗
      blade  剑身：和金属一样，但不因为靠近身体变暗
    """
    key = (color, kind)
    if key in MATERIALS:
        return MATERIALS[key]
    base = hex_rgb(color)
    if kind in ('metal', 'blade', 'matte'):
        # 不发光的东西别太亮：亮度超过约 70% 的像素在游戏里会被泛光晕开
        peak = max(base)
        if peak > 0.72:
            base = tuple(channel * 0.72 / peak for channel in base)
    material = bpy.data.materials.new(f'{kind}_{color}')
    material.use_nodes = True
    tree = material.node_tree
    nodes, links = tree.nodes, tree.links
    nodes.clear()
    output = nodes.new('ShaderNodeOutputMaterial')
    emission = nodes.new('ShaderNodeEmission')
    links.new(emission.outputs[0], output.inputs[0])

    def constant(rgb):
        node = nodes.new('ShaderNodeRGB')
        node.outputs[0].default_value = linear_rgba(rgb)
        return node.outputs[0]

    def mix(factor, a, b):
        node = nodes.new('ShaderNodeMix')
        node.data_type = 'RGBA'
        links.new(factor, node.inputs[0])
        links.new(a, node.inputs[6])
        links.new(b, node.inputs[7])
        return node.outputs[2]

    def math_node(operation, a, b):
        node = nodes.new('ShaderNodeMath')
        node.operation = operation
        for index, value in enumerate((a, b)):
            if isinstance(value, (int, float)):
                node.inputs[index].default_value = value
            else:
                links.new(value, node.inputs[index])
        return node.outputs[0]

    if kind == 'flat':
        links.new(constant(base), emission.inputs[0])
        MATERIALS[key] = material
        return material

    main, half, rim = light_vectors()
    geometry = nodes.new('ShaderNodeNewGeometry')

    def facing(direction):
        node = nodes.new('ShaderNodeVectorMath')
        node.operation = 'DOT_PRODUCT'
        links.new(geometry.outputs['Normal'], node.inputs[0])
        node.inputs[1].default_value = direction
        return node.outputs['Value']

    # 暗面：压暗并往冷紫偏，不直接加黑
    dark_amount = {'matte': 0.5, 'metal': 0.56, 'blade': 0.5, 'glow': 0.25}[kind]
    dark = mix_rgb(mix_rgb(base, (0, 0, 0), dark_amount), hex_rgb(SHADOW_TINT), 0.34)
    # 缝隙和部件互相遮挡的地方也算暗面（环境光遮蔽）
    occlusion = nodes.new('ShaderNodeAmbientOcclusion')
    occlusion.inputs['Distance'].default_value = 2.6
    occlusion.samples = 8
    occlusion_weight = 0.0 if kind == 'blade' else 1.1
    lit_value = math_node('ADD', facing(main), math_node('MULTIPLY', math_node('SUBTRACT', occlusion.outputs['AO'], 1.0), occlusion_weight))
    lit = math_node('GREATER_THAN', lit_value, 0.02)
    color_out = mix(lit, constant(dark), constant(base))

    if kind in ('metal', 'blade'):
        # 金属：朝光的一小块提亮成暖白
        highlight = mix_rgb(base, hex_rgb(LIGHT_TINT), 0.5)
        spot = math_node('MULTIPLY', math_node('GREATER_THAN', facing(half), 0.93), lit)
        color_out = mix(spot, color_out, constant(highlight))
    elif kind == 'matte':
        # 布：正对光的地方稍微亮一点
        highlight = mix_rgb(base, hex_rgb(LIGHT_TINT), 0.22)
        spot = math_node('MULTIPLY', math_node('GREATER_THAN', facing(main), 0.8), lit)
        color_out = mix(spot, color_out, constant(highlight))

    # 背光一侧的细亮边
    rim_color = mix_rgb(mix_rgb(base, (1, 1, 1), 0.35), hex_rgb('#b9a8ff'), 0.2)
    rim_band = math_node('MULTIPLY', math_node('GREATER_THAN', facing(rim), 0.86), math_node('SUBTRACT', 1.0, lit))
    color_out = mix(rim_band, color_out, constant(rim_color))

    links.new(color_out, emission.inputs[0])
    MATERIALS[key] = material
    return material


# ---------------------------------------------------------------- 造型工具

FRAMES = {}      # 关节名 -> 空物体；部件挂在关节下面，摆姿势只动关节


def joint(name):
    if name not in FRAMES:
        empty = bpy.data.objects.new(f'joint_{name}', None)
        empty.empty_display_size = 1.5
        bpy.context.scene.collection.objects.link(empty)
        FRAMES[name] = empty
    return FRAMES[name]


def add_object(name, mesh_builder, parent, color, kind='matte', location=(0, 0, 0), rotation=(0, 0, 0), scale=(1, 1, 1), smooth=True):
    """建一个部件。mesh_builder(bm) 往 bmesh 里加几何体；location / rotation / scale 是相对关节的摆放。"""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    mesh_builder(bm)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    for polygon in mesh.polygons:
        polygon.use_smooth = smooth
    mesh.materials.append(cel_material(color, kind))
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    if parent:
        obj.parent = joint(parent)
    obj.location = location
    obj.rotation_euler = rotation
    obj.scale = scale
    return obj


def lathe(profile, segments=28, squash_x=1.0, squash_y=1.0):
    """旋转体：profile 是从下到上的一串 (半径, 高度)，绕 Z 轴转一圈。半径为 0 的点收成一个顶点。"""
    def build(bm):
        rings = []
        for radius, height in profile:
            if radius <= 1e-6:
                rings.append([bm.verts.new((0, 0, height))])
            else:
                rings.append([
                    bm.verts.new((math.cos(i / segments * math.tau) * radius * squash_x, math.sin(i / segments * math.tau) * radius * squash_y, height))
                    for i in range(segments)
                ])
        for lower, upper in zip(rings, rings[1:]):
            for i in range(segments):
                j = (i + 1) % segments
                if len(lower) == 1 and len(upper) == 1:
                    continue
                if len(lower) == 1:
                    bm.faces.new((lower[0], upper[j], upper[i]))
                elif len(upper) == 1:
                    bm.faces.new((lower[i], lower[j], upper[0]))
                else:
                    bm.faces.new((lower[i], lower[j], upper[j], upper[i]))
        for ring in (rings[0], rings[-1]):
            if len(ring) > 1:
                bm.faces.new(ring)
    return build


def ellipsoid(radius_x, radius_y, radius_z, rings=14, segments=28):
    profile = [(math.sin(i / rings * math.pi), -math.cos(i / rings * math.pi)) for i in range(rings + 1)]
    profile = [(max(0.0, r) if 0 < i < rings else 0.0, z * radius_z) for i, (r, z) in enumerate(profile)]
    return lathe(profile, segments, radius_x, radius_y)


def capsule(radius_top, radius_bottom, length, steps=6):
    """胶囊：从原点往 -Z 方向伸 length，两端是半球。关节在原点。"""
    profile = []
    for i in range(steps + 1):       # 下端半球
        angle = (i / steps) * math.pi / 2
        profile.append((math.sin(angle) * radius_bottom, -length - math.cos(angle) * radius_bottom))
    for i in range(steps + 1):       # 上端半球
        angle = (i / steps) * math.pi / 2
        profile.append((math.cos(angle) * radius_top, math.sin(angle) * radius_top))
    profile[0] = (0.0, profile[0][1])
    profile[-1] = (0.0, profile[-1][1])
    return lathe(profile, 20)


def box(size_x, size_y, size_z, bevel=0.0):
    def build(bm):
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=(size_x, size_y, size_z), verts=bm.verts)
        if bevel > 0:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=2, affect='EDGES')
    return build


def slab(outline, thickness, ridge=0.0):
    """把 XZ 平面上的多边形（一串 (x, z)）沿 Y 挤出成一块板。ridge > 0 时中间鼓起来（剑身的棱）。"""
    def build(bm):
        half = thickness / 2
        front = [bm.verts.new((x, -half, z)) for x, z in outline]
        back = [bm.verts.new((x, half, z)) for x, z in outline]
        count = len(outline)
        for i in range(count):
            j = (i + 1) % count
            bm.faces.new((front[i], front[j], back[j], back[i]))
        if ridge > 0:
            center_x = sum(x for x, _ in outline) / count
            center_z = sum(z for _, z in outline) / count
            for ring, side in ((front, -1), (back, 1)):
                center = bm.verts.new((center_x, side * (half + ridge), center_z))
                for i in range(count):
                    bm.faces.new((ring[i], ring[(i + 1) % count], center))
        else:
            bm.faces.new(front)
            bm.faces.new(back)
    return build


def tube(points, radius, segments=10, closed=False):
    """沿一串点扫出的圆管（镶边、盔脊、羽饰）。radius 可以是每个点各自的半径。"""
    def build(bm):
        path = [Vector(p) for p in points]
        count = len(path)
        rings = []
        normal = None
        for i, point in enumerate(path):
            before = path[(i - 1) % count] if (closed or i > 0) else point
            after = path[(i + 1) % count] if (closed or i < count - 1) else point
            tangent = (after - before).normalized()
            if normal is None:
                helper = Vector((0, 1, 0)) if abs(tangent.y) < 0.9 else Vector((1, 0, 0))
                normal = tangent.cross(helper).normalized()
            else:
                normal = (normal - tangent * normal.dot(tangent)).normalized()
            binormal = tangent.cross(normal)
            rings.append([
                bm.verts.new(point + (normal * math.cos(a / segments * math.tau) + binormal * math.sin(a / segments * math.tau))
                             * (radius[i] if isinstance(radius, (list, tuple)) else radius))
                for a in range(segments)
            ])
        pairs = list(zip(rings, rings[1:])) + ([(rings[-1], rings[0])] if closed else [])
        for lower, upper in pairs:
            for a in range(segments):
                b = (a + 1) % segments
                bm.faces.new((lower[a], lower[b], upper[b], upper[a]))
        if not closed:
            bm.faces.new(rings[0])
            bm.faces.new(rings[-1])
    return build


def ring_points(radius_x, radius_y, height, count=32):
    return [(math.cos(i / count * math.tau) * radius_x, math.sin(i / count * math.tau) * radius_y, height) for i in range(count)]


def arc_points(radius, start, end, count=14):
    """XZ 平面上的一段圆弧，角度从 +X 轴往 +Z 方向量。"""
    return [(math.cos(start + (end - start) * i / count) * radius, 0, math.sin(start + (end - start) * i / count) * radius) for i in range(count + 1)]


# ---------------------------------------------------------------- 身体尺寸（和程序模型、knightActions.ts 对得上）

HIP_Z = 17.0            # 站着时胯的高度
SHOULDER_UP = 12.0      # 肩关节在胯上面多少
SHOULDER_SIDE = 7.6     # 肩关节离身体中线多远
HIP_SIDE = 3.3
UPPER_ARM, FOREARM = 7.2, 6.8
THIGH, SHIN = 8.6, 8.4
HEAD_UP = 20.6          # 头的中心在胯上面多少
HEAD_R = 7.4
SWORD_LENGTH = 20.0
SHIELD_R = 8.4
CAPE_COLS, CAPE_ROWS = 8, 9


def build_knight(look):
    player = look['player']
    steel, trim = look['steel'], look['trim']

    # ---- 胯：腰带、战裙
    add_object('belt', lathe([(4.9, -0.2), (5.25, 0.3), (5.25, 1.9), (4.9, 2.4)], squash_y=1.28), 'pelvis', '#5a3d28')
    add_object('buckle', box(1.2, 2.6, 2.4, 0.3), 'pelvis', trim, 'metal', location=(5.2, 0, 1.1), smooth=False)
    add_object('skirt', lathe([(0.0, -5.6), (6.9, -5.8), (7.1, -5.0), (6.1, -1.5), (5.1, 0.6), (0.0, 0.6)], squash_y=1.22), 'pelvis', player)
    add_object('skirt_trim', tube(ring_points(7.1, 7.1 * 1.22, -5.4), 0.62, closed=True), 'pelvis', trim, 'metal')

    # ---- 上身：胸甲、领口
    chest_profile = [(0.0, 0.4), (4.7, 0.6), (5.0, 3.0), (5.9, 7.0), (6.1, 9.6), (5.3, 11.8), (3.4, 13.2), (0.0, 13.6)]
    add_object('chest', lathe(chest_profile, squash_y=1.3), 'chest', steel, 'metal')
    add_object('collar', tube(ring_points(3.3, 3.9, 13.3), 0.7, closed=True), 'chest', trim, 'metal')
    # 胸甲下沿的金边
    add_object('chest_trim', tube(ring_points(5.0, 5.0 * 1.3, 2.6), 0.5, closed=True), 'chest', trim, 'metal')
    for side in (-1, 1):
        name = 'L' if side > 0 else 'R'
        add_object(f'pauldron_{name}', ellipsoid(4.3, 4.0, 3.9), 'chest', steel, 'metal', location=(0, side * (SHOULDER_SIDE + 0.9), SHOULDER_UP + 0.9))
        add_object(f'pauldron_trim_{name}', tube(ring_points(4.25, 3.95, 0), 0.5, closed=True), 'chest', trim, 'metal',
                   location=(0, side * (SHOULDER_SIDE + 0.9), SHOULDER_UP - 0.6), rotation=(side * -0.35, 0, 0))

    # ---- 头：头盔（前面挖出脸的开口）、脸、眼睛、金箍、盔脊、羽饰
    helmet = add_object('helmet', ellipsoid(HEAD_R + 0.2, HEAD_R + 0.1, HEAD_R + 0.2, 18, 36), 'head', steel, 'metal')
    cutter = add_object('helmet_cutter', box(12.0, 17.0, 9.6, 1.8), 'head', INK, 'flat', location=(7.7, 0, -3.3))
    cutter.hide_render = True
    cutter.display_type = 'WIRE'
    boolean = helmet.modifiers.new('face_opening', 'BOOLEAN')
    boolean.operation = 'DIFFERENCE'
    boolean.object = cutter
    boolean.solver = 'EXACT'
    add_object('face', ellipsoid(6.6, 6.3, 6.6, 14, 28), 'head', look['skin'], location=(0.5, 0, -0.4))
    for side in (-1, 1):
        name = 'L' if side > 0 else 'R'
        add_object(f'eye_{name}', ellipsoid(0.55, 0.95, 1.55, 8, 14), 'head', '#1a1420', 'flat', location=(6.55, side * 2.5, -1.3))
        add_object(f'cheek_{name}', ellipsoid(0.4, 1.0, 0.55, 6, 12), 'head', '#f0a58c', 'flat', location=(6.2, side * 3.9, -3.3))
    add_object('brow_band', tube(ring_points(HEAD_R + 0.15, HEAD_R + 0.05, 1.7, 40), 0.75, closed=True), 'head', trim, 'metal')
    add_object('nose_guard', box(1.0, 1.4, 4.4, 0.3), 'head', steel, 'metal', location=(7.2, 0, -0.2), smooth=False)
    add_object('crest', tube(arc_points(HEAD_R + 0.35, math.radians(20), math.radians(165)), 0.75), 'head', trim, 'metal')
    plume_path, plume_radius = [], []
    for i in range(15):
        t = i / 14
        angle = math.radians(62 + 150 * t)                    # 从盔顶前面绕到脑后
        reach = HEAD_R + 2.2 + 3.2 * math.sin(t * math.pi) + 2.4 * t
        plume_path.append((math.cos(angle) * reach + 0.5, 0, math.sin(angle) * reach - 7.0 + 1.5 * t))
        plume_radius.append(0.5 + 2.9 * math.sin(min(1.0, t * 1.6) * math.pi / 2) * (1 - t) ** 0.55)
    add_object('plume', tube(plume_path, plume_radius, 12), 'plume', player, scale=(1, 0.62, 1))

    # ---- 手臂：大臂（袖子）、肘甲、小臂甲、手套
    for side in (-1, 1):
        name = 'L' if side > 0 else 'R'
        add_object(f'upper_arm_{name}', capsule(2.5, 2.3, UPPER_ARM), f'upper_arm_{name}', player)
        add_object(f'elbow_{name}', ellipsoid(2.95, 2.95, 2.95, 8, 16), f'forearm_{name}', steel, 'metal')
        add_object(f'forearm_{name}', capsule(2.5, 2.25, FOREARM - 1.2), f'forearm_{name}', steel, 'metal')
        add_object(f'cuff_{name}', tube(ring_points(2.45, 2.45, -FOREARM + 1.9, 20), 0.5, closed=True), f'forearm_{name}', trim, 'metal')
        add_object(f'hand_{name}', ellipsoid(2.35, 2.35, 2.5, 8, 16), f'hand_{name}', look['hand'])

    # ---- 腿：大腿、膝甲、小腿、靴子
    for side in (-1, 1):
        name = 'L' if side > 0 else 'R'
        add_object(f'thigh_{name}', capsule(3.0, 2.8, THIGH), f'thigh_{name}', look['legs'])
        add_object(f'knee_{name}', ellipsoid(2.95, 2.95, 2.8, 8, 16), f'shin_{name}', steel, 'metal', location=(0.4, 0, 0))
        add_object(f'shin_{name}', capsule(2.7, 2.6, SHIN - 3.0), f'shin_{name}', look['legs'])
        # 靴子：高筒靴 + 往前伸的鞋头。脚关节在脚踝，靴底在脚踝下面 2.6
        add_object(f'boot_{name}', lathe([(0.0, -2.6), (3.1, -2.6), (3.3, -1.4), (3.05, 1.0), (3.45, 4.4), (0.0, 4.4)]), f'foot_{name}', look['boots'])
        add_object(f'toe_{name}', ellipsoid(3.7, 3.0, 2.0, 8, 16), f'foot_{name}', look['boots'], location=(2.7, 0, -1.1))
        add_object(f'boot_trim_{name}', tube(ring_points(3.45, 3.45, 4.2, 20), 0.5, closed=True), f'foot_{name}', trim, 'metal')

    # ---- 剑：关节在握把中间，剑身沿 +Z，剑面朝 Y
    blade_width = 2.0
    blade_outline = [(-blade_width, 3.4), (blade_width, 3.4), (blade_width, SWORD_LENGTH - 3.2), (0, SWORD_LENGTH + 1.2), (-blade_width, SWORD_LENGTH - 3.2)]
    add_object('blade', slab(blade_outline, 0.5, ridge=0.55), 'sword', look['blade'], 'blade', smooth=False)
    add_object('guard', box(6.8, 1.7, 1.5, 0.35), 'sword', trim, 'metal', location=(0, 0, 3.1), smooth=False)
    add_object('grip', capsule(0.95, 0.95, 4.8), 'sword', '#5a3d28', location=(0, 0, 2.8))
    add_object('pommel', ellipsoid(1.35, 1.35, 1.35, 8, 14), 'sword', look['gem'], 'glow', location=(0, 0, -2.6))

    # ---- 盾：关节在盾心，盾面朝 +X
    dome = [(0.0, 2.0), (2.6, 1.85), (5.4, 1.3), (7.4, 0.6), (SHIELD_R, 0.0), (SHIELD_R, -0.9), (0.0, -0.9)]
    face_rotation = (0, math.pi / 2, 0)
    add_object('shield_face', lathe(dome, 36), 'shield', shade(player, -0.3), rotation=face_rotation)
    add_object('shield_rim', tube(ring_points(SHIELD_R, SHIELD_R, 0.0, 40), 1.0, closed=True), 'shield', trim, 'metal', rotation=face_rotation)
    add_object('shield_ring', tube(ring_points(4.9, 4.9, 1.45, 32), 0.5, closed=True), 'shield', trim, 'metal', rotation=face_rotation)
    add_object('shield_boss', ellipsoid(2.5, 2.5, 1.5, 8, 20), 'shield', '#ffd76a', 'metal', rotation=face_rotation, location=(1.9, 0, 0))
    for i in range(8):                      # 盾沿的一圈铆钉
        angle = i / 8 * math.tau + math.pi / 8
        add_object(f'shield_stud_{i}', ellipsoid(0.75, 0.75, 0.6, 6, 10), 'shield', '#fff1c2', 'metal', rotation=face_rotation,
                   location=(0.75, math.cos(angle) * 6.6, math.sin(angle) * 6.6))

    # ---- 披风：每帧按姿势重新算顶点（见 update_cape）
    cape_mesh = bpy.data.meshes.new('cape')
    bm = bmesh.new()
    grid = [[bm.verts.new((0, col, -row)) for col in range(CAPE_COLS + 1)] for row in range(CAPE_ROWS + 1)]
    for row in range(CAPE_ROWS):
        for col in range(CAPE_COLS):
            bm.faces.new((grid[row][col], grid[row][col + 1], grid[row + 1][col + 1], grid[row + 1][col]))
    bm.to_mesh(cape_mesh)
    bm.free()
    for polygon in cape_mesh.polygons:
        polygon.use_smooth = True
    cape_mesh.materials.append(cel_material(shade(player, -0.28), 'matte'))
    cape = bpy.data.objects.new('cape', cape_mesh)
    bpy.context.scene.collection.objects.link(cape)
    thickness = cape.modifiers.new('thickness', 'SOLIDIFY')
    thickness.thickness = 0.5
    return cape


# ---------------------------------------------------------------- 姿势

def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def ease_out(t):
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) * (1 - t)


def ease_in(t):
    t = max(0.0, min(1.0, t))
    return t * t


EASES = {'smooth': smooth, 'out': ease_out, 'in': ease_in}


def blend(a, b, t):
    """两个姿势参数（数、向量或它们的元组）按 t 混合。"""
    if isinstance(a, (int, float)):
        return a + (b - a) * t
    if isinstance(a, Vector):
        return a.lerp(b, t)
    return type(a)(blend(x, y, t) for x, y in zip(a, b))


def V(x, y, z):
    return Vector((x, y, z))


# 一帧的姿势参数。手的位置用“躯干坐标”：原点在两肩中点，X 朝前、Y 朝左（远侧）、Z 朝上。
# 右手（近侧，离镜头近）持剑，左手（远侧）持盾；镜头从侧前方看，盾举在身前也看得见。
REST = {
    'move': V(0, 0, 0),             # 整个人的位移（X 前后、Z 抬高）
    'pitch': 0.0,                   # 整个人绕脚底往后倒的角度（死亡）
    'drop': 0.0,                    # 胯往下沉
    'lean': 0.0,                    # 上身前倾（弧度）
    'twist': 0.0,                   # 上身绕竖轴转（正数：左肩往前）
    'head': (0.0, 0.0),             # 头相对上身：(低头, 往镜头转)
    'sword_hand': V(-2.0, -10.6, -11.0),
    'sword_dir': V(-0.8, -0.16, 0.46),   # 剑尖指向（上身坐标）
    'shield_pos': V(8.2, 3.2, -5.8),     # 盾心
    'shield_dir': V(0.8, -0.58, 0.12),   # 盾面朝向
    'foot_L': (V(2.8, HIP_SIDE + 0.4, 0), 0.0),    # (脚底位置, 脚尖上翘的角度)；远侧脚在前，两条腿在画面上才分得开
    'foot_R': (V(-2.6, -HIP_SIDE - 0.4, 0), 0.0),
    'cape': (0.0, 0.0),             # (往后扬起的程度 0..1, 摆动的相位)
    'plume': 0.0,                   # 羽饰往后甩的角度
    'sword_free': None,             # 剑脱手后的世界矩阵（死亡），None = 握在手里
    'shield_free': None,
}


def pose(**changes):
    result = dict(REST)
    result.update(changes)
    return result


def pose_idle(k):
    """待机：呼吸，披风和羽饰轻轻飘。k 是循环进度 0..1。"""
    breath = math.sin(k * math.tau)
    sway = math.sin(k * math.tau + 0.9)
    return pose(
        drop=0.25 - 0.25 * breath,
        lean=0.015 * breath,
        head=(-0.02 * breath, 0.0),
        sword_hand=REST['sword_hand'] + V(0, 0, 0.35 * breath),
        sword_dir=REST['sword_dir'] + V(0.03 * sway, 0, 0),
        shield_pos=REST['shield_pos'] + V(0, 0, 0.5 * breath),
        cape=(0.05 + 0.04 * sway, k * math.tau),
        plume=0.07 * sway,
    )


def pose_walk(k):
    """走路：一个完整的步伐循环（左右脚各一步）。"""
    phase = k * math.tau
    stride, lift = 6.4, 3.6

    def foot(offset, side):
        s = phase + offset
        ground = math.sin(s) > 0                       # 着地：脚往后蹬
        x = stride * math.cos(s)
        z = 0.0 if ground else lift * (-math.sin(s)) ** 0.8
        toe = 0.0 if ground else 0.45 * math.cos(s)    # 往前迈时脚尖先翘起，落地前放平
        if ground and math.cos(s) < -0.6:
            toe = -0.5 * (-(math.cos(s)) - 0.6) / 0.4   # 蹬离地面前脚跟先抬
        return (V(x, side * HIP_SIDE, z), toe)

    bob = math.cos(phase * 2)
    swing = math.sin(phase)
    return pose(
        drop=0.9 + 0.7 * bob,
        lean=0.1,
        twist=0.1 * swing,
        head=(-0.06, 0.0),
        foot_L=foot(0.0, 1),
        foot_R=foot(math.pi, -1),
        sword_hand=REST['sword_hand'] + V(-2.6 * swing, 0, 0.4 * bob),
        sword_dir=REST['sword_dir'] + V(-0.1 * swing, 0, 0),
        shield_pos=REST['shield_pos'] + V(0.5 * swing, 0, 0.6 * bob - 0.3),
        cape=(0.62 + 0.08 * bob, phase * 2),
        plume=0.3 + 0.06 * bob,
    )


def keyed(keys, k):
    """keys 是一串 (时刻, 缓动, 姿势)，按 k 插值。"""
    index = 0
    while index < len(keys) - 2 and k >= keys[index + 1][0]:
        index += 1
    start, _, before = keys[index]
    end, ease, after = keys[index + 1]
    t = EASES[ease]((k - start) / max(1e-6, end - start))
    result = {}
    for name in REST:
        a, b = before[name], after[name]
        result[name] = b if (a is None or b is None) else blend(a, b, t)
    return result


ATTACK_KEYS = [
    (0.0, 'smooth', pose()),
    # 蓄力：剑举过头顶往后拉，上身后仰，盾收到身侧
    (0.3, 'out', pose(
        lean=-0.2, twist=-0.3, drop=0.8, head=(0.08, 0.0),
        sword_hand=V(-3.0, -8.4, 9.5), sword_dir=V(-0.62, -0.1, 0.78),
        shield_pos=V(7.4, 4.6, -6.2),
        foot_L=(V(-3.4, HIP_SIDE, 0), 0.0), foot_R=(V(2.0, -HIP_SIDE, 0), 0.0),
        cape=(0.15, 1.0), plume=-0.12,
    )),
    # 出手：往前踏一步，从头顶劈到身前
    (0.42, 'in', pose(
        lean=0.12, twist=0.1, drop=1.4, head=(-0.05, 0.0),
        sword_hand=V(9.0, -8.2, 5.0), sword_dir=V(0.72, -0.05, 0.69),
        shield_pos=V(4.6, 6.4, -6.8), shield_dir=V(0.5, -0.82, 0.1),
        foot_L=(V(-5.0, HIP_SIDE, 0), -0.25), foot_R=(V(5.2, -HIP_SIDE, 0), 0.0),
        cape=(0.5, 2.0), plume=0.3,
    )),
    (0.55, 'out', pose(
        lean=0.3, twist=0.32, drop=2.6, head=(-0.12, 0.0),
        sword_hand=V(13.2, -7.4, -6.6), sword_dir=V(0.86, -0.02, -0.5),
        shield_pos=V(1.4, 7.6, -7.4), shield_dir=V(0.3, -0.94, 0.1),
        foot_L=(V(-5.6, HIP_SIDE, 0), -0.35), foot_R=(V(6.0, -HIP_SIDE, 0), 0.0),
        cape=(0.75, 3.0), plume=0.5,
    )),
    # 收招
    (0.74, 'smooth', pose(
        lean=0.24, twist=0.26, drop=2.2, head=(-0.1, 0.0),
        sword_hand=V(12.2, -7.8, -8.2), sword_dir=V(0.8, -0.05, -0.6),
        shield_pos=V(2.4, 7.2, -7.2), shield_dir=V(0.4, -0.9, 0.1),
        foot_L=(V(-5.2, HIP_SIDE, 0), -0.2), foot_R=(V(5.8, -HIP_SIDE, 0), 0.0),
        cape=(0.4, 4.0), plume=0.2,
    )),
    (1.0, 'smooth', pose()),
]


def pose_attack(k):
    return keyed(ATTACK_KEYS, k)


HIT_KEYS = [
    (0.0, 'out', pose()),
    (0.3, 'out', pose(
        move=V(-2.4, 0, 0), lean=-0.3, twist=-0.15, drop=1.6, head=(0.22, 0.0),
        sword_hand=V(-4.0, -11.5, -7.0), sword_dir=V(0.2, -0.3, 0.93),
        shield_pos=V(6.6, 2.0, -2.6), shield_dir=V(0.7, -0.6, 0.38),
        foot_L=(V(-4.2, HIP_SIDE, 0), 0.0), foot_R=(V(1.2, -HIP_SIDE, 0), 0.25),
        cape=(0.4, 1.5), plume=-0.3,
    )),
    (1.0, 'smooth', pose()),
]


def pose_hit(k):
    return keyed(HIT_KEYS, k)


def pose_block(_k=0.0):
    """格挡：盾举到胸前正对前方，剑收在身后斜举过肩，身体微微前压。"""
    return pose(
        lean=0.16, twist=0.22, drop=2.0, head=(-0.1, 0.0),
        sword_hand=V(-4.6, -9.6, 1.2), sword_dir=V(-0.5, -0.12, 0.86),
        shield_pos=V(10.6, 0.6, -2.8), shield_dir=V(0.9, -0.42, 0.1),
        foot_L=(V(-4.4, HIP_SIDE, 0), 0.0), foot_R=(V(4.2, -HIP_SIDE, 0), 0.0),
        cape=(0.12, 0.5),
    )


def pose_death(k):
    """死亡：被打得往后仰倒，剑和盾脱手，最后仰面躺在地上。"""
    fall = ease_in(min(1.0, k / 0.68))
    settle = smooth((k - 0.68) / 0.32)
    bounce = math.sin(min(1.0, max(0.0, (k - 0.68) / 0.2)) * math.pi) * 1.6
    stagger = math.sin(min(1.0, k / 0.3) * math.pi)
    lying = blend(0.0, 1.0, fall)
    result = pose(
        move=V(-3.0 * stagger + 9.0 * fall, 0, bounce + 2.8 * lying),
        pitch=math.radians(88) * fall,
        lean=-0.25 * stagger + 0.06 * settle,
        twist=-0.2 * fall,
        drop=1.5 * stagger,
        head=(0.25 * stagger - 0.2 * settle, 0.35 * lying),
        # 两臂摊开
        sword_hand=blend(REST['sword_hand'], V(-2.0, -15.0, 2.0), fall),
        sword_dir=blend(REST['sword_dir'], V(0.1, -0.9, 0.4), fall),
        shield_pos=blend(REST['shield_pos'], V(1.0, 13.5, 1.0), fall),
        shield_dir=blend(REST['shield_dir'], V(0.95, 0.2, 0.2), fall),
        foot_L=(blend(REST['foot_L'][0], V(1.0, HIP_SIDE + 2.2, 0.5), fall), 0.5 * fall),
        foot_R=(blend(REST['foot_R'][0], V(3.6, -HIP_SIDE - 2.6, 3.4 * math.sin(fall * math.pi) + 0.5), fall), 0.4 * fall),
        cape=(0.3 * stagger, 1.0),
        plume=-0.4 * stagger,
    )
    # 剑在倒下的过程中脱手，落在身前的地上
    release = smooth((k - 0.22) / 0.5)
    if release > 0:
        result['sword_free'] = (release, V(2.0, -15.0, 0.7), V(0.9, 0.42, 0.0))
    return result


ANIMS = {
    # 名字: (帧数, 姿势函数, 是否循环)
    'idle': (8, pose_idle, True),
    'walk': (8, pose_walk, True),
    'attack': (8, pose_attack, False),
    'hit': (4, pose_hit, False),
    'death': (8, pose_death, False),
    'block': (1, pose_block, False),
}
ANIM_FPS = {'idle': 6}


def frame_progress(name, index):
    """第 index 帧对应的动画进度。循环动画不重复首帧；一次性的动画取每格时间段的中点（最后一帧取终点）。"""
    count, _, loop = ANIMS[name]
    if loop:
        return index / count
    if name == 'death':
        return index / (count - 1)
    return (index + 0.5) / count


# ---------------------------------------------------------------- 把姿势换成每个关节的位置朝向

def rotation_y(angle):
    """绕 Y 轴转：正数让 +Z 往 +X 倒（前倾）。"""
    return Matrix.Rotation(angle, 4, 'Y')


def frame_from(origin, z_axis, x_hint):
    """由原点、Z 轴方向和大致的 X 方向拼出一个坐标系矩阵。"""
    z = z_axis.normalized()
    x = x_hint - z * x_hint.dot(z)
    if x.length < 1e-5:
        x = Vector((1, 0, 0)) - z * z.x
    x.normalize()
    y = z.cross(x)
    matrix = Matrix.Identity(4)
    for row in range(3):
        matrix[row][0], matrix[row][1], matrix[row][2], matrix[row][3] = x[row], y[row], z[row], origin[row]
    return matrix


def two_bone(root, target, first, second, pole):
    """两节骨骼的 IK：返回中间关节（肘、膝）的位置和够得着的末端位置。pole 是关节弯向的大致方向。"""
    offset = target - root
    reach = first + second - 0.05
    distance = max(1e-4, min(offset.length, reach))
    direction = offset.normalized()
    end = root + direction * distance
    along = (first * first - second * second + distance * distance) / (2 * distance)
    height = math.sqrt(max(0.0, first * first - along * along))
    side = pole - direction * pole.dot(direction)
    if side.length < 1e-5:
        side = Vector((0, 0, -1)) - direction * (-direction.z)
    side.normalize()
    return root + direction * along + side * height, end


def solve(p):
    """算出一帧里每个关节的世界矩阵。"""
    out = {}
    # 整个人：先绕脚底往后倒，再平移
    root = Matrix.Translation(p['move']) @ rotation_y(-p['pitch'])
    hip = Vector((0, 0, HIP_Z - p['drop']))
    pelvis = Matrix.Translation(hip) @ Matrix.Rotation(p['twist'] * 0.35, 4, 'Z') @ rotation_y(p['lean'] * 0.3)
    torso = Matrix.Translation(hip) @ Matrix.Rotation(p['twist'], 4, 'Z') @ rotation_y(p['lean'])
    out['pelvis'] = root @ pelvis
    out['chest'] = root @ torso

    # 头：抵消掉大部分前倾，脸保持朝前
    nod, turn = p['head']
    head = torso @ Matrix.Translation((0.4, 0, HEAD_UP - 7.0)) @ rotation_y(-p['lean'] * 0.6 + nod) \
        @ Matrix.Rotation(-p['twist'] * 0.7 - turn, 4, 'Z') @ Matrix.Translation((0.6, 0, 7.0))
    out['head'] = root @ head
    out['plume'] = root @ head @ Matrix.Translation((0, 0, 7.0)) @ rotation_y(-p['plume'])

    shoulders = torso @ Matrix.Translation((0, 0, SHOULDER_UP))     # 躯干坐标：两肩中点

    def arm(name, side, hand_target, pole):
        shoulder = shoulders @ Vector((0, side * SHOULDER_SIDE, 0))
        elbow, hand = two_bone(shoulder, hand_target, UPPER_ARM, FOREARM, pole)
        out[f'upper_arm_{name}'] = root @ frame_from(shoulder, shoulder - elbow, Vector((1, 0, 0)))
        out[f'forearm_{name}'] = root @ frame_from(elbow, elbow - hand, Vector((1, 0, 0)))
        out[f'hand_{name}'] = root @ frame_from(hand, elbow - hand, Vector((1, 0, 0)))
        return hand

    # 持剑的手（近侧）：肘往后下方、略往外弯
    sword_target = shoulders @ p['sword_hand']
    sword_hand = arm('R', -1, sword_target, torso.to_3x3() @ Vector((-0.7, -0.45, -0.55)))
    sword_dir = (torso.to_3x3() @ p['sword_dir']).normalized()
    sword = frame_from(sword_hand, sword_dir, torso.to_3x3() @ Vector((1, 0, 0.0)) + Vector((0, 0, 0.001)))
    out['sword'] = root @ sword

    # 持盾的手（远侧）：手在盾背后
    shield_center = shoulders @ p['shield_pos']
    shield_dir = (torso.to_3x3() @ p['shield_dir']).normalized()
    arm('L', 1, shield_center - shield_dir * 2.2, torso.to_3x3() @ Vector((-0.3, 0.7, -0.65)))
    shield_up = Vector((0, 0, 1)) - shield_dir * shield_dir.z
    shield = frame_from(shield_center, shield_up, shield_dir)
    out['shield'] = root @ shield

    # 腿：胯关节跟着胯走，脚踩在给定的位置上，膝盖朝前弯
    for name, side in (('L', 1), ('R', -1)):
        foot_position, toe = p[f'foot_{name}']
        hip_joint = pelvis @ Vector((0, side * HIP_SIDE, 0))
        ankle_target = foot_position + Vector((0, 0, 2.6))
        knee, ankle = two_bone(hip_joint, ankle_target, THIGH, SHIN, Vector((1, side * 0.12, 0.1)))
        out[f'thigh_{name}'] = root @ frame_from(hip_joint, hip_joint - knee, Vector((1, 0, 0)))
        out[f'shin_{name}'] = root @ frame_from(knee, knee - ankle, Vector((1, 0, 0)))
        out[f'foot_{name}'] = root @ Matrix.Translation(ankle) @ rotation_y(-toe)

    # 死亡时脱手的剑：从手里的位置过渡到地上
    if p['sword_free']:
        amount, position, direction = p['sword_free']
        held = root @ sword
        held_origin = held.to_translation()
        held_dir = (held.to_3x3() @ Vector((0, 0, 1))).normalized()
        origin = held_origin.lerp(position, amount) + Vector((0, 0, math.sin(amount * math.pi) * 4.0))
        out['sword'] = frame_from(origin, held_dir.lerp(direction, amount), Vector((0, 0, 1)) + Vector((0.3, 0, 0)))

    out['_torso'] = root @ torso
    return out


def update_cape(cape, frames, p):
    """披风：上沿钉在两肩后面，往下垂；flare 越大越往后扬，按相位起伏。"""
    torso = frames['_torso']
    flare, phase = p['cape']
    length = 22.5
    mesh = cape.data
    back = (torso.to_3x3() @ Vector((-1, 0, 0)))
    back.z = 0
    back = back.normalized() if back.length > 1e-4 else Vector((-1, 0, 0))
    lying = min(1.0, p['pitch'] / math.radians(80))
    for row in range(CAPE_ROWS + 1):
        v = row / CAPE_ROWS
        for col in range(CAPE_COLS + 1):
            u = col / CAPE_COLS * 2 - 1                 # -1 近侧 .. 1 远侧
            # 上沿：沿着肩膀后面的一段弧
            top = torso @ Vector((-3.4 - 1.6 * (1 - u * u), u * 7.2, SHOULDER_UP + 0.9))
            ripple = math.sin(phase - v * 3.2 + u * 0.9) * (0.5 + 1.6 * flare) * v
            # 垂下来的部分：越往下越散开、越往后飘
            drape_back = 2.2 * v + (3.0 + 15.0 * flare) * v * v + ripple
            drape_down = length * v * (1.0 - 0.42 * flare * v)
            spread = 1.0 + 0.32 * v
            point = Vector((top.x, top.y * spread, top.z)) + back * drape_back - Vector((0, 0, drape_down))
            if lying > 0:
                # 倒地后披风摊在身下
                flat = Vector((top.x - length * 0.55 * v, top.y * (1 + 0.6 * v), 0.5 + 0.3 * math.sin(v * 9 + u * 3)))
                point = point.lerp(flat, lying)
            point.z = max(0.4, point.z)
            mesh.vertices[row * (CAPE_COLS + 1) + col].co = point
    mesh.update()


def apply_pose(cape, p):
    frames = solve(p)
    for name, empty in FRAMES.items():
        empty.matrix_world = frames[name]
    update_cape(cape, frames, p)


# ---------------------------------------------------------------- 场景、渲染

def setup_scene(width, height, px_per_unit, anchor, yaw=None):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 24
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 0
    scene.cycles.pixel_filter_type = 'BLACKMAN_HARRIS'
    scene.cycles.filter_width = 1.2
    scene.render.film_transparent = True
    scene.render.resolution_x = width * SUPER
    scene.render.resolution_y = height * SUPER
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.display_settings.display_device = 'sRGB'

    camera_data = bpy.data.cameras.get('camera') or bpy.data.cameras.new('camera')
    camera_data.type = 'ORTHO'
    camera_data.ortho_scale = max(width, height) / px_per_unit
    camera_data.clip_start = 1
    camera_data.clip_end = 1000
    camera = bpy.data.objects.get('camera')
    if camera is None:
        camera = bpy.data.objects.new('camera', camera_data)
        scene.collection.objects.link(camera)
    scene.camera = camera
    toward, right, up = camera_axes()
    if yaw is not None:
        spin = Matrix.Rotation(yaw, 3, 'Z')
        toward, right, up = spin @ toward, spin @ right, spin @ up
    # 让脚底中心（原点）正好落在格子里的锚点上
    offset_right = (width / 2 - anchor[0]) / px_per_unit
    offset_up = (anchor[1] - height / 2) / px_per_unit
    target = right * offset_right + up * offset_up
    camera.location = target + toward * 200
    camera.rotation_euler = (-toward).to_track_quat('-Z', 'Y').to_euler()

    # 内部结构线：部件之间的遮挡线、折角、材质交界；最外圈的轮廓不画（游戏里的着色器加）
    scene.render.use_freestyle = True
    scene.render.line_thickness_mode = 'ABSOLUTE'
    scene.render.line_thickness = 1.0
    layer = scene.view_layers[0]
    layer.use_freestyle = True
    settings = layer.freestyle_settings
    settings.crease_angle = math.radians(128)
    while settings.linesets:
        settings.linesets.remove(settings.linesets[0])
    style = bpy.data.linestyles.get('ink') or bpy.data.linestyles.new('ink')
    style.color = linear_rgba(hex_rgb(INK))[:3]
    style.thickness = 1.25 * SUPER * (px_per_unit / PX_PER_UNIT)
    style.thickness_position = 'CENTER'
    lineset = settings.linesets.new('ink')
    lineset.linestyle = style
    lineset.select_by_visibility = True
    lineset.visibility = 'VISIBLE'
    lineset.select_by_edge_types = True
    lineset.edge_type_combination = 'OR'
    wanted = os.environ.get('LINES', 'silhouette,crease,border').split(',')
    for other in ('silhouette', 'border', 'crease', 'ridge_valley', 'suggestive_contour', 'material_boundary', 'contour', 'external_contour', 'edge_mark'):
        setattr(lineset, f'select_{other}', other in wanted)
    return scene


def render_to(path):
    scene = bpy.context.scene
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def load_frame(path, width, height):
    """读一张超采样的渲染图，缩到目标大小（按预乘透明度缩小，边缘不会发黑）。"""
    from PIL import Image
    image = Image.open(path).convert('RGBA')
    if image.size != (width, height):
        premultiplied = image.convert('RGBa')
        image = premultiplied.resize((width, height), Image.LANCZOS).convert('RGBA')
    return image


def build(look=LOOK):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    MATERIALS.clear()
    FRAMES.clear()
    return build_knight(look)


def render_sheet(out_dir):
    from PIL import Image
    cape = build()
    setup_scene(FRAME_W, FRAME_H, PX_PER_UNIT, ANCHOR)
    columns = max(count for count, _, _ in ANIMS.values())
    sheet = Image.new('RGBA', (columns * FRAME_W, len(ANIMS) * FRAME_H), (0, 0, 0, 0))
    manifest = {'sheet': 'characters/knight.png', 'frame': [FRAME_W, FRAME_H], 'anchor': list(ANCHOR), 'ppu': 2, 'refR': 16, 'anims': {}}
    temp = os.path.join(out_dir, '_frame.png')
    for row, (name, (count, function, _)) in enumerate(ANIMS.items()):
        entry = {'row': row, 'frames': count}
        if name in ANIM_FPS:
            entry['fps'] = ANIM_FPS[name]
        manifest['anims'][name] = entry
        for index in range(count):
            apply_pose(cape, function(frame_progress(name, index)))
            render_to(temp)
            sheet.paste(load_frame(temp, FRAME_W, FRAME_H), (index * FRAME_W, row * FRAME_H))
            print(f'[knight] {name} {index + 1}/{count}', flush=True)
    os.remove(temp)
    sheet.save(os.path.join(out_dir, 'knight.png'))
    with open(os.path.join(out_dir, 'knight.json'), 'w', encoding='utf-8') as file:
        json.dump(manifest, file, ensure_ascii=False, indent=2)


def render_poses(out_dir, scale=int(os.environ.get('SCALE', '3'))):
    """每个动画挑几帧，按 scale 倍放大渲染后拼成一张图，检查造型和姿势用。"""
    from PIL import Image
    cape = build()
    width, height = FRAME_W * scale // 2, FRAME_H * scale // 2
    anchor = (ANCHOR[0] * scale // 2, ANCHOR[1] * scale // 2)
    setup_scene(width, height, PX_PER_UNIT * scale / 2, anchor)
    picks = [('idle', 0.0), ('walk', 0.0), ('walk', 0.25), ('walk', 0.5), ('attack', 0.3), ('attack', 0.44), ('attack', 0.56),
             ('hit', 0.3), ('block', 0.0), ('death', 0.35), ('death', 0.7), ('death', 1.0)]
    only = os.environ.get('ONLY')
    if only:
        picks = [(name, float(k)) for name, k in (item.split(':') for item in only.split(','))]
    columns = min(4, len(picks))
    rows = (len(picks) + columns - 1) // columns
    sheet = Image.new('RGBA', (columns * width, rows * height), (38, 30, 46, 255))
    temp = os.path.join(out_dir, '_frame.png')
    for index, (name, k) in enumerate(picks):
        apply_pose(cape, ANIMS[name][1](k))
        render_to(temp)
        frame = load_frame(temp, width, height)
        sheet.alpha_composite(with_outline(frame, 2 * scale // 2), ((index % columns) * width, (index // columns) * height))
    os.remove(temp)
    sheet.save(os.path.join(out_dir, 'poses.png'))


def with_outline(frame, width):
    """模拟游戏里着色器加的外描边，预览用。"""
    from PIL import Image, ImageFilter
    alpha = frame.getchannel('A').filter(ImageFilter.MaxFilter(width * 2 + 1))
    outline = Image.new('RGBA', frame.size, (11, 7, 16, 255))
    outline.putalpha(alpha)
    outline.alpha_composite(frame)
    return outline


def render_turn(out_dir, views=8, scale=3):
    from PIL import Image
    cape = build()
    width, height = 150 * scale // 2, FRAME_H * scale // 2
    anchor = (width // 2, ANCHOR[1] * scale // 2)
    sheet = Image.new('RGBA', (views * width, height), (38, 30, 46, 255))
    temp = os.path.join(out_dir, '_frame.png')
    apply_pose(cape, pose_idle(0.0))
    for index in range(views):
        setup_scene(width, height, PX_PER_UNIT * scale / 2, anchor, yaw=index / views * math.tau)
        render_to(temp)
        sheet.alpha_composite(with_outline(load_frame(temp, width, height), scale), (index * width, 0))
    os.remove(temp)
    sheet.save(os.path.join(out_dir, 'turn.png'))


def save_blend(out_dir):
    cape = build()
    setup_scene(FRAME_W, FRAME_H, PX_PER_UNIT, ANCHOR)
    apply_pose(cape, pose_idle(0.0))
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(os.path.abspath(out_dir), 'knight.blend'))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'poses'
    out_dir = sys.argv[2] if len(sys.argv) > 2 else '.'
    os.makedirs(out_dir, exist_ok=True)
    {'sheet': render_sheet, 'poses': render_poses, 'turn': render_turn, 'blend': save_blend}[mode](out_dir)


if __name__ == '__main__':
    main()
