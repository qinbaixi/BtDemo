# BtDemo

一个在浏览器里玩的小 Demo：Go 后端实现 AOI（九宫格）、技能、属性计算和伤害计算，怪物与 NPC 的决策由 [BtTree（owl-bt）](https://github.com/qinbaixi/BtTree) 导出的 Go 行为树驱动，每个怪物 / NPC 用哪棵树由 YAML 配置。

不使用数据库和缓存，所有状态都在内存里；每个 WebSocket 连接会创建一个新角色，断开即删除。

后端各模块的架构和设计思路见 [docs/](docs/README.md)，第一次读 Go 代码建议从 [Go 速读](docs/go-primer.md) 开始。

## 运行

```sh
go run ./cmd/server            # 监听 config/world.yaml 的 addr（默认 :8090），打开 http://localhost:8090
go run ./cmd/server -addr :9000 -config ./config -open   # 临时换端口，并自动打开浏览器
```

前端是 TypeScript 工程，需要先构建一次（需要 Node.js 20+），构建产物会嵌进服务端：

```sh
cd web && npm ci && npm run build && cd ..   # 输出 web/dist
go run ./cmd/server
```

改前端时用 `cd web && npm run dev` 打开 http://localhost:5173 ，保存即刷新（同时要开着 Go 服务端）。详见 [前端文档](docs/modules/frontend.md)。

Windows 下可以直接双击根目录的 `start.bat`：先运行 `go generate ./internal/ai/trees` 更新行为树注册表，再构建前端，编译出 `dist\btdemo.exe`（连同 `config/`），启动服务并打开浏览器。需要先安装 Go 1.22+ 和 Node.js 20+（没装 Node.js 时沿用上次构建的前端）。

```bat
start.bat           :: 编译并启动，端口读 config\world.yaml 的 addr
start.bat 9000      :: 临时换端口
start.bat build     :: 只编译出 dist\btdemo.exe，不启动（exe 已内嵌前端，配合 dist\config 可以拷到没装 Go 的机器上运行）
```

操作：`WASD` / 方向键移动，鼠标点击选择目标，`1`~`5` 释放技能，`G` 切换 AOI 网格显示，`Q` 切换画质。可以开多个浏览器标签页，每个标签页是一个新玩家，互相在视野内可见。

## 目录

```text
cmd/server/          入口
bt/                  owl-bt 项目：owl-bt.json（游戏节点类型）+ trees/*.json（行为树），用 BtTree 编辑器打开
internal/ai/trees/   BtTree 导出的 Go 文件（DO NOT EDIT）与 go generate 生成的 registry.go
internal/bt/         行为树运行时：解释导出的 map[int]map[string]any
internal/game/       World：创建各系统并按顺序驱动 Step（每个系统一个包）
  core/              共享数据：Entity（按组件分组）、实体表、时钟、事件队列
  aoi/               九宫格 AOI
  attr/              属性公式、经验与升级
  nav/               碰撞形状、空间哈希、推出与视线检测、A* 寻路
  move/              移动：碰撞滑动、沿寻路路径追击
  combat/            技能、伤害、Buff、死亡、敌对查询
  ai/                行为树加载校验、节点实现、决策追踪
  spawn/             刷怪、创建玩家、复活
  session/           连接会话、输入、AOI 同步与协议转换
internal/config/     YAML 配置加载与校验
internal/server/     HTTP 与 WebSocket
config/              world.yaml（地图、AOI、阵营、玩家）、skills.yaml、monsters.yaml、map.tmj（Tiled 地图：场景物件与碰撞）
proto/btdemo.proto   客户端与服务端协议（proto2）
internal/pb/         protoc 生成的 Go 代码
web/                 前端（TypeScript + Vite，构建到 web/dist 后由 go:embed 打进二进制），见 docs/modules/frontend.md
  src/net/           协议转换与 WebSocket
  src/game/          本地状态、消息处理、事件
  src/render/        画面（PixiJS / WebGL）：world 舞台、pixi/ 角色与场景显示和描边着色器、lighting 光照、overlay 叠加层、models 模型、fx 特效、scenery 场景
  src/ui/            HUD 与调试面板
tools/btregistry/    扫描导出文件生成 registry.go
```

## 行为树：从 BtTree 到游戏

1. 用 BtTree 打开 `bt/`（例如 `owlbt open bt/trees/monster_melee.json`，或在首页「Open folder…」选择 `bt`），编辑或新建树。可用的节点类型定义在 `bt/owl-bt.json`：
   - 组合：`Selector`、`Sequence`、`Parallel`、`RandomSelector`
   - 任务：`FindTarget`、`ClearTarget`、`ChaseTarget`、`CastSkill`（`Slot` 对应怪物模板 `skills` 的序号）、`Wander`、`ReturnHome`、`Flee`、`Wait`、`Say`
   - 装饰器：`HasTarget`、`TargetInRange`、`HpBelow`、`FarFromHome`、`WasAttacked`、`Cooldown`、`ForceSuccess`
   - 服务：`UpdateTarget`
2. 导出 Go：项目的导出设置已指向 `../internal/ai/trees`、包名 `trees`。在编辑器里用「Export: Go」，或运行 `scripts/export-bt.sh`（Windows 用 `scripts\export-bt.bat`；需要 `owlbt` 命令；也可以 `OWLBT="node ../BtTree/packages/server/dist/cli.js" scripts/export-bt.sh`）。
3. `go generate ./internal/ai/trees` 重新生成 `registry.go`（脚本已包含这一步）。
4. 在 `config/monsters.yaml` 的模板里用 `tree: <树文件名>` 选择行为树。

启动时会校验：模板引用的树必须存在；树里用到的每个节点类型都必须在 `internal/game/ai/nodes.go` 中有实现，否则启动失败并指出节点。新增节点类型时，在 `owl-bt.json` 中声明、在 `nodes.go` 中用 `reg.Task` / `reg.Condition` / `reg.Service` 注册同名（snake_case）处理函数即可。

### 运行时语义

- 每个 AI tick 从根节点开始执行。`Selector` 是响应式的：每次都按优先级从第一个子节点尝试，高优先级分支（如「脱战回家」「战斗」）可以打断正在执行的低优先级分支（如「闲逛」）。
- `Sequence` 和 `RandomSelector` 记住正在执行的子节点，下一个 tick 从那里继续。
- 节点从「不在运行」进入时才检查装饰器条件并清空节点内存；运行过程中只重新检查勾选了 `periodic` 的装饰器。装饰器的 `inverse_check_condition` 会把条件取反。
- `Cooldown` 装饰器在节点成功后开始冷却；`ForceSuccess` 让节点总是成功（即使条件装饰器挡住了它），适合「说一句话」这类可选步骤；服务按 `time_between_ticks` 周期执行，节点重新进入不会打乱周期。

## 属性与伤害

- 基础属性：力量、敏捷、智力、体质；玩家每升一级按 `world.yaml` 的 `growth` 成长。
- 派生属性：生命上限、攻击、法强、防御、法抗、暴击率、暴击伤害、移速（公式见 `internal/game/attr/attr.go`），再叠加 Buff 的百分比加成。
- 伤害 = `(攻击 × 系数 + 固定值) × (1 − 防御 / (防御 + 100)) × 暴击 × 随机 0.95~1.05`；物理技能用攻击 / 防御，法术技能用法强 / 法抗。

## 协议

客户端和服务端之间每个 WebSocket 二进制帧是一个 protobuf 消息，定义在 `proto/btdemo.proto`（`syntax = "proto2"`）：浏览器发 `ClientMsg`（移动、选目标、施法），服务端发 `ServerMsg`（`Welcome`、AOI 的 `Enter` / `Leave`、10Hz 的 `Sync`、`Toast`）。

- Go 端用 `google.golang.org/protobuf`，生成代码在 `internal/pb`。修改 `.proto` 后运行 `go generate ./internal/pb`（需要 `protoc` 和 `protoc-gen-go@v1.36.6`），CI 会检查生成代码是否最新。
- 浏览器端用 protobufjs：`web` 下 `npm run proto` 从同一份 `.proto` 生成 `src/net/pb.js` 和 TypeScript 类型（`npm run build` 会自动执行），`src/net/protocol.ts` 把它转成前端用的对象。

## 美术与特效

渲染用 PixiJS（WebGL）；美术目前全部是程序化绘制的占位，没有图片资源，整体参考《哈迪斯》的冥界风格：角色有粗墨线描边和按阵营着色的轮廓光（玩家金色、怪物血红、NPC 青色），场景压暗后由火盆、营火、魂火、熔岩和技能特效动态照亮。`monsters.yaml` 模板的 `model` 字段（默认等于模板名）和 `world.yaml` 玩家的 `model`（默认 `knight`）决定客户端画哪个模型：`knight`、`slime`、`wolf`、`skeleton_archer`、`ogre_chief`、`guard`、`villager`。角色用硬阴影分层着色（固定左上光源，转身时光照不跟着翻），带膝肘关节的走路、蓄力、出手、收招、受击（击退、抖动和整体白闪）和各自的死亡动画（骷髅散成骨堆、史莱姆化成一滩、狼侧翻倒地）；技能、受击、治疗、增益、升级、死亡、复活都有粒子特效。

- `web/src/render/models.ts`：角色模型和动作
- `web/src/render/fx.ts`：技能与战斗特效（刀光、火球、骨箭、旋风斩、治疗法阵、增益光柱、暴击闪光、屏幕震动）
- `web/src/render/scenery.ts`：按区域生成的地表、场景物件和光源（大理石广场村庄、极乐草地、狼林、墓地、熔岩营地），与角色一起按纵深排序
- `web/src/render/pixi/inkFilter.ts`：角色描边、轮廓光和受击白闪（GPU 着色器）
- `web/src/render/lighting.ts`：GPU 光照（暗色层挖出光斑，加彩色光晕）
- `web/src/render/pixi/postFilter.ts`、`grade.ts`：后期处理，泛光 + LUT 调色（`B` 键开关）

画质：按 `Q` 在高画质和简化画质（不描边、不打光、无后期处理）之间切换，地址加 `?low` 默认用简化画质；帧率持续偏低时会自动切到简化画质。按 `B` 单独开关泛光和调色（`?nopost` 默认关闭）。

## 地图碰撞与寻路

`config/map.tmj` 是地图的唯一数据源，用 [Tiled](https://www.mapeditor.org) 编辑（打开 `config/btdemo.tiled-project`）：

- `props` 图层摆物件（对象的类是物件种类，属性 `s` 缩放、`v` 外观变体、`flip` 翻转；两点折线是墙）；
- 地图属性 `shape.<种类>` 给出每种物件的碰撞形状（`circle cx cy r`、`rect x0 y0 x1 y1`、墙用的 `capsule r`，`none` 表示只是装饰）；
- `zones`、`roads` 图层决定前端怎么画地表（各区域的位置、石板路）。

服务端启动时读它、校验，转成 `internal/game/nav` 的碰撞体；浏览器从 `/map.tmj` 下载同一个文件来画场景，两边看到的阻挡一致。格式和编辑方法见 [docs/modules/map.md](docs/modules/map.md)。

- 移动：玩家和怪物按自身半径与碰撞体做推出，贴着墙会沿墙滑动而不是卡住；出生、复活、游荡和逃跑的落点都会挪到最近的空地。
- 寻路：怪物追击时先做视线检测，看得见就直走；被挡住时在 16px 网格上跑 A*（按单位半径分档膨胀障碍，八方向、不切墙角），再把路径拉直。目标移动超过 24px、每隔 0.75 秒、或卡住 0.4 秒都会重新规划；目标走不到时走到离它最近的可达点。
- 调试：按 `G` 用红色描出所有碰撞体；在调试面板里选中一个怪物，会用青色虚线画出它当前的寻路路线。

## AOI

地图按 `aoi.cell` 切成格子，玩家只接收自己所在格子和周围 8 格内的实体：进入视野时收到 `enter`（静态信息），离开时收到 `leave`，视野内实体的状态和事件（伤害、技能、说话、死亡）随 10Hz 的 `sync` 下发。前端按 `G` 可以看到格子和当前视野范围。

## 调试面板

按 `` ` `` 键或右上角的「调试」按钮打开调试抽屉：

- **AI 决策**：点击一个怪物或 NPC，服务端开始下发它每一帧的行为树执行记录（只发给打开了面板的客户端，没人看时不产生额外开销）。面板会显示当前帧访问过的节点及其结果（成功、失败、运行中），以及条件未通过、装饰器改写结果、服务触发等原因，还有黑板和目标、生命、离家距离等状态。决策日志只在行为树切换分支时记一行，并注明被跳过的分支和原因。
- **协议收发**：列出每一帧收发的 protobuf 消息，包括方向、类型、字节数和 JSON 预览，点开可以看完整内容。支持暂停、清空、按类型过滤，可以单独显示收或发，默认隐藏 sync。

控制台里可以通过 `btdemo.state` 查看客户端状态。

## 测试

```sh
go vet ./...
go test ./...
```

## GitHub Actions

- `.github/workflows/ci.yml`：每次推送和 PR 都会运行 gofmt、`go vet`、检查 `registry.go` 是否最新、`go test -race`、构建并冒烟启动服务、检查前端语法；另一个任务拉取 BtTree，用它的导出器重新导出 `bt/`，确认提交的 `internal/ai/trees` 与树文件一致（BtTree 若为私有仓库，需要添加有读权限的 `BTTREE_TOKEN` secret）。
- `.github/workflows/release.yml`：推送 `v*` 标签时构建 Linux / macOS / Windows 的可执行文件（附带 `config/` 与 README），发布到 GitHub Releases。
