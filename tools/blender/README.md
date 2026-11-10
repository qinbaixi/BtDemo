# 用 Blender 做角色动画表

骑士（玩家主角）的模型是用 Blender 建的 3D 模型，渲染成游戏用的动画表（一张图里排着所有动作的每一帧）。
模型、动作、渲染全部写在 `knight.py` 里，不需要打开 Blender 的界面，也不需要显卡。

## 安装

Blender 以 Python 模块的方式运行（需要 Python 3.13）：

```sh
python -m venv .venv
.venv/bin/pip install bpy pillow        # Windows 上是 .venv\Scripts\pip
```

## 常用命令

```sh
# 渲染一套外观的动画表：输出 <皮肤>-<武器>.webp 和清单片段 knight.json
python tools/blender/knight.py sheet out paladin knight_sword

# 全部外观（4 套皮肤 × 3 把武器）渲染到 web/public/art/characters/knight/，四核约 20 分钟
tools/blender/render-all.sh python 4

# 挑几帧放大看（改造型、调动作时用）。ONLY 写“动画@进度”，SCALE 是放大倍数
ONLY=idle@0,act:circle@0.4,block@0 SCALE=4 python tools/blender/knight.py poses out obsidian blood_blade

# 转一圈的展示图 / 保存 .blend（可以用 Blender 打开看模型）
python tools/blender/knight.py turn out
python tools/blender/knight.py blend out
```

渲染完把 `knight.json` 的内容更新到 `web/public/art/manifest.json` 的 `characters.knight`，再重新构建前端。

## 文件

| 文件 | 内容 |
| --- | --- |
| `knight.py` | 模型（皮肤、头盔样式、武器）、姿势、着色、渲染、拼表 |
| `knight-actions.json` | 技能动作的关键帧数据，从 `web/src/render/knightActions.ts` 导出 |
| `export-actions.mjs` | 导出上面那个 JSON：`node tools/blender/export-actions.mjs > tools/blender/knight-actions.json` |
| `render-all.sh` | 渲染全部外观 |

## 怎么改

- **改配色、加皮肤**：`knight.py` 的 `SKINS`。头盔样式在 `build_helm` 里（`open` 露脸圆盔、`winged` 带金翼、`horned` 全封闭带角、`skull` 骷髅面盔）。
- **加武器外观**：`SWORDS`。
- **改基础动作**（待机、走、攻击、受击、死亡、格挡、完美格挡、破防）：`pose_xxx` 函数和 `ATTACK_KEYS` 这类关键帧表。
- **改技能动作**：改 `web/src/render/knightActions.ts` 的关键帧，重新导出 JSON，再重新渲染。技能的出手时刻、特效的时机都在那个文件里，两边共用同一份数据。
- 加了皮肤或武器后，游戏配置（`config/world.yaml` 的皮肤、`config/items.yaml` 的武器外观）里的名字要和这里的键一致，清单的 `variants` 会自动带上。

## 画面是怎么来的

- 相机是正交的，从侧前方 30°、俯视 16° 看；角色朝右，游戏里朝左时整体水平翻转。
- 着色是赛璐璐：每块颜色分亮面、暗面两层，金属多一块高光，背光侧有一条细亮边。暗面往冷紫偏。
- 内部的结构线用 Blender 的 Freestyle 画。最外圈的描边、轮廓光、受击白闪由游戏里的着色器加。
- 不发光的颜色亮度压在 72% 以内，免得被游戏的泛光晕开；眼睛里的光、发光的剑刃不压。
