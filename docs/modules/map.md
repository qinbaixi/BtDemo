# 地图：config/maps/*.tmj（Tiled）

地图用 [Tiled 地图编辑器](https://www.mapeditor.org)（1.10 或更新版本）编辑，保存成 JSON 格式。每个场景一张（`config/scenes.yaml` 的 `map`，见 [场景与分线](scene.md)）：
`config/maps/village.tmj`（晨曦村）和 `config/maps/graveyard.tmj`（亡者墓园），两张图用传送门连起来。
**前后端读的是同一个文件**：

- 服务端启动时读它（`internal/config/layout.go`），把物件换算成碰撞体，用来做移动碰撞和 A* 寻路（见 [nav 和 move](nav-move.md)）。
- 浏览器从服务端的 `/maps/<文件名>` 下载同一个文件（`web/src/game/map.ts`，地址在 Welcome 的 `scene.map` 里），按它画地表和物件。

没有 `scenes.yaml` 时还按旧的单场景方式：只有一张 `config/map.tmj`，浏览器从 `/map.tmj` 下载。

所以在 Tiled 里挪一棵树，保存后重启服务端、刷新页面，树的位置和它挡路的位置会一起变。

## 怎么编辑

1. 用 Tiled 打开 `config/btdemo.tiled-project`（菜单“文件 → 打开项目”），再打开 `maps/` 里要改的地图。
   项目文件里定义了每种物件的“类”（class）和它们的属性 `s`、`v`、`flip`，选对象时可以直接下拉选。
2. 改完保存（Ctrl+S），重启服务端（`start.bat` 或 `go run ./cmd/server`），刷新浏览器。
3. 服务端启动时会检查地图，写错了会直接报出是哪个对象、哪里不对，不会带着错误地图跑起来。

现在还没有美术贴图，所以在 Tiled 里物件显示成带名字的点和线；接入美术后可以换成带图片的图块对象，格式说明见文末。

## 文件结构

地图尺寸 = 格子数 × 格子边长（现在两张都是 40×50 格、每格 32 像素，即 1280×1600），场景的大小就按地图来（旧的单场景方式下必须和 `world.yaml` 的 `map` 一致）。地图里没有图块层，全是对象图层：

| 图层 | 对象 | 谁用 | 含义 |
| --- | --- | --- | --- |
| `zones` | 点 | 前端 | 区域中心。名字是区域种类：`village` 圣所广场、`meadow` 极乐草地、`forest` 柏树林、`graveyard` 墓地（雾和亡魂）、`camp` 塔尔塔罗斯营地（岩浆和火星）。同一种可以放多处 |
| `roads` | 折线 | 前端 | 石板路，沿折线铺 |
| `props` | 点 / 两点折线 | 前后端 | 场景物件，见下 |
| `portals` | 点 | 前后端 | 传送门（类 `portal`）：属性 `to` 是去的场景 id，`r` 是半径（默认 36）。玩家站进去 600 毫秒就被送过去，落在那边通回来的门外面 |

### props 图层

- 对象的**类**就是物件种类（`house`、`tree`、`brazier`……），种类的画法在前端 `web/src/render/scenery.ts` 的 `KINDS`。
- **点对象**：物件放在点的位置（物件脚下的点）。
- **两点折线**：墙（`wall`），从第一点连到第二点。
- 自定义属性（都可以不写）：

| 属性 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `s` | float | 1 | 缩放，图像和碰撞形状一起缩放 |
| `v` | int | 0 | 外观变体（比如石柱 0 完整、1 挂旗、2 断柱） |
| `flip` | bool | false | 水平翻转，碰撞形状也左右镜像 |

### 碰撞形状：地图属性 `shape.<种类>`

每种物件的碰撞形状写在**地图属性**里（菜单“地图 → 地图属性”），名字是 `shape.` 加种类，值是字符串，坐标相对物件脚下的点（缩放前）：

| 值 | 含义 | 例子 |
| --- | --- | --- |
| `circle cx cy r` | 圆 | `shape.well` = `circle 0 -8 30` |
| `rect x0 y0 x1 y1` | 轴对齐矩形 | `shape.house` = `rect -62 -44 62 6` |
| `capsule r` | 墙专用：沿墙段、半径为 r 的胶囊体 | `shape.wall` = `capsule 8` |
| `none` | 只是装饰，不挡路 | `shape.amphora` = `none` |

`props` 里用到的每个种类都必须有 `shape.` 属性，漏写会报错，避免手误打错种类名时物件悄悄变成“能穿过去”。

草丛和魂火不在地图里：前端用固定种子在路和物件之外自动撒，不挡路。

## 加一种新物件

1. 前端 `scenery.ts` 的 `KINDS` 加画法（尺寸、脚底偏移、绘制函数）。
2. 场景地图（`config/maps/*.tmj`）加地图属性 `shape.新种类`。
3. `btdemo.tiled-project` 加同名的类（在 Tiled 的“视图 → 自定义类型编辑器”里加，带 `s`、`v`、`flip` 三个成员），以后在 Tiled 里就能直接选。
4. 在 `props` 图层里摆放。

## 代码在哪

| 位置 | 做什么 |
| --- | --- |
| `internal/config/layout.go` | 解析场景地图：`shape.*` 属性 → `Layout.Shapes`，`props` 图层 → `Layout.Props`；检查数值、种类、墙的折线 |
| `internal/config/config.go` | 检查地图尺寸和 `world.yaml` 一致、物件都在地图内 |
| `internal/game/nav` | `ShapesFromLayout` 把物件换算成碰撞体 |
| `internal/server/server.go` | 在 `/maps/<文件名>` 原样提供各场景的地图（`/map.tmj` 是默认场景的） |
| `web/src/game/map.ts` | 下载并解析地图（和服务端同样的规则） |
| `web/src/game/sync.ts` | 收到 `welcome` 后下载地图、建场景（内容没变就不重画） |
| `web/src/render/scenery.ts` | 按区域画地表、按物件画场景 |

## 以后接入美术

现在的点对象没有图片。美术到位后的计划：

- 每种物件做成 Tiled 的“图片集合图块集”（一张图一个图块），在 `props` 图层里摆**图块对象**，Tiled 里就能看到真实的样子；碰撞形状可以改成图块自带的碰撞编辑器里画。
- 解析代码要相应支持图块对象（Tiled 的图块对象以图片左下角为锚点，需要换算到脚下的点）。
- 地表可以改成图块层（地砖、草地图块）代替现在程序生成的地表。
