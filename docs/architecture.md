# 整体架构

## 进程里跑着什么

```text
main goroutine ── http.Server.Serve ──► 每个 WebSocket 连接 2 个 goroutine
                                         ├─ 读：收 ClientMsg → world.Do(Input)
                                         └─ 写：从 Session.Out 取字节 → 发给浏览器

world goroutine ── World.Run：for { select { inbox 里的函数 | 定时器到了就 Step() } }
```

入口是 `cmd/server/main.go`，它只做四件事：

1. `config.Load` 读 `config/*.yaml` 并校验（行为树名要存在、技能要存在、阵营要对得上……）。
2. `game.NewWorld` 创建所有系统、加载行为树、按配置刷出怪物和 NPC。
3. `go world.Run(ctx)` 在独立的 goroutine 里开始跑世界循环。
4. 启动 HTTP 服务：`/` 是前端静态文件（打包在二进制里），`/ws` 是游戏 WebSocket，`/btdemo.proto` 是协议定义（前端用它解码）。

## 单线程世界：为什么没有锁

游戏状态（所有实体、AOI 格子、事件队列……）**只由 world goroutine 读写**。网络层收到消息后不直接改状态，而是：

```go
// internal/server/server.go
w.Do(func() { w.Input(s, msg) })   // 把“要做的事”丢进 inbox
```

`World.Run` 的 `select` 会在两帧之间把 inbox 里的函数逐个执行。好处：

- 游戏代码里一把锁都没有，读写实体不用考虑并发。
- 一帧之内状态是一致的：AI 看到的位置和战斗结算用的位置一定相同。
- 测试简单：不起服务器、不开 goroutine，直接 `w.Step()` 一帧一帧推进（见 `internal/game/*_test.go`）。

代价是所有逻辑共用一个 CPU 核心；这个 Demo 的规模（几十个实体，一帧约 20µs）远远够用。

## 一帧（tick）里发生什么

`config/world.yaml` 的 `tick_rate: 20` 表示每秒 20 帧，`sync_rate: 10` 表示每秒给客户端同步 10 次（每 2 帧一次）。`World.Step()`：

```go
w.State.Clock.Advance()        // 时间前进 Dt = 1/20 秒
w.Spawn.Tick()                 // 1. 复活时间到了的实体
w.Combat.Tick()                // 2. 去掉过期的 Buff，重算属性
w.Move.Tick()                  // 3. 玩家按方向键移动（带碰撞）
w.AI.Tick(w.Sessions.Watched())// 4. 每个怪物 / NPC 跑一次行为树：选目标、追击、放技能……
if 该同步了 { w.Sessions.Flush() } // 5. 给每个玩家发 AOI 变化、视野内实体状态、事件
```

顺序是有意的：先复活和清 Buff，让本帧的移动和 AI 用到最新的属性；AI 在玩家移动之后跑，追的是玩家这一帧的新位置；同步放在最后，把本帧所有变化一起发出去。

玩家的技能不在 Step 里处理，而是在两帧之间由 `Input` 立即结算（`combat.Cast`），产生的伤害事件进入事件队列，下一次 Flush 发出。

## 一次按键的完整旅程

玩家按 `1`（斩击）攻击一只史莱姆：

1. **浏览器** `input.ts` 调 `protocol.ts` 的 `encode({t:'cast', slot:1, target:id})`，编码成 protobuf `ClientMsg{cast}` 通过 WebSocket 发出。
2. **server** 读 goroutine 解码成 `pb.ClientMsg`，调用 `w.Do(func(){ w.Input(s, msg) })`。
3. **world goroutine** 执行 `session.Input`：找到技能槽 1；目标无效时自动选最近的怪；调用 `combat.Cast`。
4. **combat.Cast** 检查冷却、距离，算伤害（`CalcDamage`），扣血（`applyDamage`），往 `State.Events` 里放 `CAST`、`DAMAGE` 事件；血量归零就 `Kill`：标记死亡、安排复活、给玩家加经验（可能触发 `LEVEL_UP` 事件）。
5. 到了同步帧，**session.Flush** 给每个玩家：
   - 算出九宫格内的实体，和上次比较，发 `Leave`（离开视野）和 `Enter`（进入视野，带名字、模型等静态信息）；
   - 发 `Sync`：视野内实体的位置血量、发生在视野内的事件、自己的属性和冷却；
   - 清空事件队列。
6. **浏览器** 收到 `Sync`：插值移动角色，播放刀光、飘伤害数字。

## 包之间的依赖

```text
cmd/server ──► config, game, server, web
server     ──► game, pb, proto
game(world)──► 所有系统包，只负责创建和按顺序调用

session ──► combat, ai, spawn, aoi, nav, core
spawn   ──► move, ai, aoi, attr, core
ai      ──► combat, move, bt, ai/trees, core
combat  ──► attr, aoi, core
move    ──► nav, aoi, core
attr, aoi, nav ──► core / config
core    ──► config, bt, nav(只用 Vec), pb
bt      ──► 无（纯行为树运行时，不认识游戏）
```

规则是**只往下依赖，不往上**：`core` 不知道任何系统，`combat` 不知道 `ai`。需要上层能力时由构造函数把下层系统的指针传进来，例如 `ai.New(state, combat, move)`。Go 本身禁止循环 import，这个约束会被编译器强制执行。

## 数据归属（谁能改什么）

实体 `core.Entity` 由几个组件组成，每个组件有一个“主人”系统，其他系统原则上只读：

| 组件 | 字段 | 主人 |
| --- | --- | --- |
| `Identity` | ID、种类、名字、阵营、模型 | spawn（创建时写好，之后不变） |
| `Transform` | 位置、出生点、半径 | move（位置）、aoi 跟着更新格子 |
| `Stats` | 等级、经验、基础属性、派生属性、HP | attr（combat 扣血） |
| `Combat` | 技能、冷却、Buff、目标、最后攻击者 | combat（ai 和 session 设置目标） |
| `Life` | 是否死亡、复活时间 | combat 标记死亡，spawn 负责复活 |
| `Control` | 玩家输入方向 | session 写，move 读 |
| `Steering` | 当前路径、寻路状态 | move |
| `Brain` | 行为树实例、当前动作、调试追踪 | ai |

## 配置与数据从哪来

| 文件 | 内容 | 读取者 |
| --- | --- | --- |
| `config/world.yaml` | 端口、地图尺寸、AOI 格子、帧率、阵营敌对表、玩家模板 | config → 各系统 |
| `config/skills.yaml` | 技能 | combat |
| `config/monsters.yaml` | 怪物 / NPC 模板和刷怪点 | spawn、ai |
| `config/map.tmj` | Tiled 地图：场景物件、碰撞形状、地表区域和道路 | nav；server 原样提供给前端（`/map.tmj`） |
| `bt/trees/*.json` → `internal/ai/trees/*.go` | 行为树（BtTree 编辑、导出） | bt、ai |
| `proto/btdemo.proto` → `internal/pb` | 协议 | session、server、前端 |

## 测试

- `internal/bt/runner_test.go`：行为树运行时的语义（选择器打断、序列恢复、装饰器、服务）。
- `internal/game/nav/nav_test.go`：碰撞推出、视线、A*。
- `internal/game/*_test.go`：在真实配置或手搭的小世界上逐帧推进，检查追击、技能、升级、AOI 进出、寻路绕墙、出生点不在物件里等。
- `internal/server/server_test.go`：起一个真的 HTTP 服务，用 WebSocket 客户端走完握手和同步。
- `internal/ai/trees/trees_test.go`：`bt/trees/` 里的每棵树都已导出并登记在 `registry.go` 里。
