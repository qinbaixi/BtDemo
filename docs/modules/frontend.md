# 前端：浏览器客户端

代码：`web/`（TypeScript + Vite），构建产物 `web/dist` 由 `web/embed.go` 嵌进服务端。

## 职责

服务端是权威，前端只做三件事：

1. 把键盘鼠标变成 `ClientMsg` 发给服务端；
2. 把服务端的 `ServerMsg` 变成本地状态（实体、自己的属性、事件）；
3. 每帧把本地状态画出来：位置在两次同步之间插值，动作、特效、飘字由事件驱动。

碰撞、伤害、冷却这些判定都不在前端做。

## 技术栈

| 层 | 现在 | 计划 |
| --- | --- | --- |
| 语言 | TypeScript | |
| 构建 | Vite（开发热更新，`npm run build` 输出到 `web/dist`） | |
| 协议 | protobufjs：`npm run proto` 从 `proto/btdemo.proto` 生成 `src/net/pb.js` 和类型 | |
| 渲染 | PixiJS 8（WebGL）：地表、物件、角色、光照；描边和轮廓光是着色器。技能特效和头顶文字暂时画在叠加的 2D 画布上 | 特效改成 Pixi 粒子；模型换成美术贴图 / Spine |
| 地图 | 服务端 `config/map.yaml` 下发物件 | Tiled 编辑器（`config/map.tmj`），前后端读同一份（已完成，见 [地图](map.md)） |
| 界面 | DOM（HUD、调试面板） | 保持 DOM |

选型理由：Pixi 只管渲染、不带游戏逻辑，适合“服务端权威、客户端只做表现”的结构；2D 性能好，描边光照可以写成着色器；Spine 骨骼动画有官方运行时。

## 目录

```text
web/
  index.html            页面骨架：画布、HUD、调试抽屉；入口 /src/main.ts
  package.json          npm 脚本和依赖
  vite.config.ts        构建输出 dist；开发服务器 5173 端口，/ws 代理到 localhost:8090
  tsconfig.json
  embed.go              go:embed dist
  public/.gitkeep       构建时复制到 dist，保证没构建前端也能编译服务端
  src/
    main.ts             入口：把各模块接起来，每帧主循环
    input.ts            键盘鼠标：移动、选目标、放技能、G/Q/` 开关
    net/
      types.ts          前端用的消息类型（Welcome、Sync、事件……）
      protocol.ts       protobuf ⇄ types.ts 的转换，协议收发都经过 tap（调试面板用）
      connection.ts     WebSocket，断线 2 秒重连
      pb.js / pb.d.ts   生成的代码，不提交（npm run proto）
    game/
      config.ts         插值时长、动画时长、配色、属性表等常量
      math.ts           clamp、lerp、hypot、fmt
      state.ts          State 和 ClientEntity 类型、全局 state、插值 posOf、头顶位置 headY
      sync.ts           处理 welcome / enter / leave / sync / toast；welcome 后下载地图建场景
      map.ts            下载并解析 /map.tmj（Tiled 地图，和服务端读同一份）
      events.ts         事件 → 动画、特效、飘字
    render/
      world.ts          Pixi 舞台和一帧的绘制：镜头、地面标记、角色、光照
      overlay.ts        叠加的 2D 画布：技能特效、环境粒子、名字血条、气泡、飘字、调试线条、暗角
      lighting.ts       GPU 光照：暗色层（擦除混合挖出光斑）+ 彩色光（加法混合）
      pixi/
        actorView.ts    一个角色：阴影、自己脚下的印记、身体精灵 + 墨线着色器
        inkFilter.ts    墨线着色器：描边、轮廓光、受击白闪
        sceneView.ts    地表切块贴图、物件精灵、动态物件（火焰）
        canvasSprite.ts 用 Canvas 2D 画内容的精灵（程序化模型、火焰、地面特效用它接进 Pixi）
      models.ts         角色模型和动作（程序化绘制，美术到位后替换）
      fx.ts             技能和战斗特效、粒子、屏幕震动（Canvas 2D）
      scenery.ts        地表、场景物件、环境光源（Canvas 2D 生成贴图）
    ui/
      hud.ts            自己 / 目标面板、技能栏、死亡遮罩、提示条、连接状态
      debug.ts          调试抽屉：AI 决策追踪
      debug-proto.ts    调试抽屉：协议收发列表
    styles/             CSS，由 main.ts 引入
```

分工：`game/` 根据服务端消息改 `state`；`render/` 每帧读 `state` 画出来，只顺带更新动画用的字段（走路相位、过期的气泡和飘字），不碰游戏逻辑；`ui/` 是 DOM。

## 画面分层

```text
#game（WebGL，Pixi）
  world        跟随镜头：地表 → 地面标记（AOI、边界、射程、目标圈）→ 地面特效 → 角色和物件（按脚底 y 排序）
  darkness     光照暗色层（屏幕空间，半分辨率渲染纹理）
  glow         光源彩色叠加（跟随镜头）
#overlay（2D 画布，鼠标穿透）
  技能特效 → 环境粒子 → 目标连线 → 碰撞体 / AI 路径 → 名字血条 → 气泡 → 飘字 → 暗角
```

- 程序化画的东西（模型、火焰、地面特效）先画到小画布，再作为贴图交给 Pixi（`CanvasSprite`）。角色和火焰每秒重画 24 次，位置每帧跟随插值。
- 描边、轮廓光、受击白闪在 `inkFilter.ts` 的着色器里做，作用在角色精灵上；以后换成美术贴图或 Spine 动画，滤镜照样能用。
- 简化画质（Q 键 / `?low`）关掉着色器和光照。
- 美术接入时：角色在 `ActorView` 里把 `CanvasSprite` 换成贴图动画；物件在 `SceneView` 里换成图集里的精灵；特效以后改成 Pixi 粒子。

## 一帧做什么（main.ts 的 frame）

1. `watchFrameRate`：持续低帧率时自动切到简化画质；
2. `runPending`：播放到时间的受击（弹道飞到目标时才显示伤害数字）；
3. 调试面板跟随当前选中的目标；
4. `updateCamera` 镜头跟随自己；
5. `drawWorld` 画世界；
6. 刷新目标面板、技能冷却、死亡倒计时。

收到消息不在帧里处理，而是 WebSocket 回调里直接改 `state`（`game/sync.ts`）。

## 开发

需要 Node.js 20+。浏览器需要支持 WebGL（不支持时连接状态会提示画面初始化失败）。

```sh
cd web
npm ci                # 第一次，或 package-lock.json 变了之后
npm run dev           # Vite 开发服务器 http://localhost:5173，改 TS/CSS 立即生效
                      # 另开一个终端 go run ./cmd/server 提供 /ws（默认 8090 端口）
npm run typecheck     # 生成协议代码 + 类型检查
npm run build         # 生成协议代码 + 类型检查 + 输出 web/dist
```

发布或只跑服务端时：先 `npm run build`，再 `go build`，前端就嵌在二进制里了。`start.bat` 会自动做这两步。没构建前端就编译服务端时，首页会提示先构建。

## 改协议

`proto/btdemo.proto` 改完后：

1. `go generate ./internal/pb`（服务端）；
2. `npm run proto`（前端；`npm run build` 也会自动跑）；
3. 在 `src/net/types.ts` 加字段，在 `src/net/protocol.ts` 的 `decode` / `encode` 里转换。

字段名对不上时 `tsc` 会直接报错。

## 加东西时改哪里

- 新怪物模型：`render/models.ts` 加画法，`game/config.ts` 的 `MODEL_H` 加头顶高度。
- 新技能特效：`render/fx.ts` 的 `cast()` 按 `fx` 字段分支。
- 新场景物件：`render/scenery.ts` 的 `KINDS`，同时在 `config/map.tmj` 加碰撞形状并摆放（见 [地图](map.md#加一种新物件)）。
- 新 HUD 元素：`index.html` 加元素，`ui/hud.ts` 取元素并刷新。
- 新事件：`net/types.ts` 的 `EventKind`、`protocol.ts` 的 `EVENT_KIND`，再在 `game/events.ts` 处理。
