# 整体架构

## 进程里跑着什么

```text
main goroutine ── http.Server.Serve ──► 每个 WebSocket 连接 2 个 goroutine
                                         ├─ 读：收 ClientMsg → session.Inbox.Push(msg)
                                         └─ 写：等 Link.Wake → Link.Take 取走 Frame 字节 → 发给浏览器（另有 5 秒一次的 ping）

world goroutine ── World.Run：每个 tick：执行 Do 排队的命令 → 处理各会话 Inbox → Step()
                    每个同步帧：Step 末尾 Sessions.Flush，把攒下的消息按会话合成一个 Frame 推进 Link
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
session.Inbox.Push(msg)                    // 玩家输入：放进这个会话自己的输入队列
world.Do(func() { world.Attach(link, token) })  // 其他命令（连接、断开）：放进世界的命令队列
```

输入和命令队列都是“互斥锁 + 切片”，提交永远不阻塞、也不会因为满了丢掉。`World.Run` 每个 tick 开头先执行命令、再按到达顺序处理每个会话的输入，然后才跑各系统，所以输入总在固定的时机生效。反方向（世界 → 网络）也是同样的做法：每个连接一个 `session.Link`（互斥锁 + 切片，按字节算积压），世界 goroutine 只管 `Push` 编码好的 `Frame`，从不阻塞在网络上；客户端跟不上时清掉积压、改发全量，而不是丢帧或阻塞。
连接断开时角色不删，保留 `session.keep`（30 秒），客户端首帧 `Hello` 带上 `Welcome.token` 就能接回原来的角色，服务端发全量（见 [session 和 server](modules/session-server.md)）。
输入队列里连续的同类“状态型”消息（移动、选目标、格挡、观察）只留最新的一条；一个会话两个 tick 之间排了超过 `session.InboxLimit` 条就判定为异常客户端，断开它。
停服时 `Run` 会先跑完已经接受的命令，再断开所有会话；之后 `Do` 返回 false。好处：

- 游戏代码里一把锁都没有，读写实体不用考虑并发。
- 一帧之内状态是一致的：AI 看到的位置和战斗结算用的位置一定相同。
- 测试简单：不起服务器、不开 goroutine，直接 `world.Step()` 一帧一帧推进（见 `internal/game/*_test.go`）。

代价是所有逻辑共用一个 CPU 核心；这个 Demo 的规模（几十个实体，一帧约 20µs）远远够用。

## 一帧（tick）里发生什么

`config/world.yaml` 的 `tick_rate: 20` 表示每秒 20 帧，`sync_rate: 10` 表示每秒给客户端同步 10 次（每 2 帧一次）。`World.Step()`：

```go
w.State.Clock.Advance()        // 时间前进 Dt = 1/20 秒
w.Spawn.Tick()                 // 1. 复活时间到了的实体
w.Combat.Tick()                // 2. 去掉过期的 Buff，重算属性；装备的持续回血
w.Zone.Tick()                  // 3. 回血区：去掉到时间的，给站在里面的友方回血
w.Move.Tick()                  // 4. 玩家按方向键移动（带碰撞）
w.AI.Tick(w.Sessions.Watched())// 5. 每个怪物 / NPC 跑一次行为树：选目标、追击、放技能……
if 该同步了 { w.Sessions.Flush() } // 6. 推送脏实体的增量、事件、自身属性，每个会话合成一个 Frame
```

顺序是有意的：先复活和清 Buff，让本帧的移动和 AI 用到最新的属性；AI 在玩家移动之后跑，追的是玩家这一帧的新位置；同步放在最后，把本帧所有变化一起发出去。

玩家的技能不在 Step 里处理，而是在 tick 开头的 `DrainInputs` 里由 `Input` 结算（`combat.Cast`），产生的伤害事件进入事件队列，下一次 Flush 发出；对玩家操作本身的回应（`Toast`、`SkillBar` 等）用 `SendNow` 立即发。

## 一次按键的完整旅程

玩家按 `1`（斩击）攻击一只史莱姆：

1. **浏览器** `input.ts` 调 `protocol.ts` 的 `encode({t:'cast', slot:1, target:id})`，编码成 protobuf `ClientMsg{cast}` 通过 WebSocket 发出。
2. **server** 读 goroutine 解码成 `pb.ClientMsg`，放进 `session.Inbox`。
3. **world goroutine** 在下一个 tick 开头（`Sessions.DrainInputs`）执行 `session.Input`：找到技能槽 1；目标无效时自动选最近的怪；调用 `combat.Cast`。
4. **combat.Cast** 检查冷却、距离，算伤害（`CalcDamage`），扣血（`applyDamage`），往 `State.Events` 里放 `CAST`、`DAMAGE` 事件；血量归零就 `Kill`：标记死亡、安排复活、给玩家加经验（可能触发 `LEVEL_UP` 事件）。
5. 到了同步帧，**session.Flush**：
   - 实体进出视野不在这里算：`aoi.Grid` 在实体换格子时已经通知 session（`Shown` / `Hidden`），相关玩家的待发列表里已经有 `Enter` / `Leave`；
   - 血量变了的实体带着脏标记，`Flush` 生成只含变化字段的 `EntityState` 增量，`Broadcast` 给九宫格里的玩家；
   - 事件按发生位置 `Broadcast`，自己的属性变了发 `SelfInfo`；
   - 每个玩家这一帧攒下的消息合成一个 `Frame`，一次写进他的连接。
6. **浏览器** 收到 `Frame`，逐条处理里面的 `EntityState`、`Event`：更新实体、插值移动角色，播放刀光、飘伤害数字。

## 包之间的依赖

```text
cmd/server ──► config, game, server, web
server     ──► game, pb, proto
game(world)──► 所有系统包，只负责创建和按顺序调用

session ──► combat, ai, spawn, item, aoi, nav, core
spawn   ──► move, ai, aoi, attr, core
ai      ──► combat, move, bt, ai/trees, core
combat  ──► item, attr, aoi, core
item    ──► attr, core
move    ──► nav, aoi, core
zone    ──► aoi, core
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
| `Inventory` | 玩家的物品（背包和装备）、待发的提示 | item（session 读标记并发消息） |

## 配置与数据从哪来

| 文件 | 内容 | 读取者 |
| --- | --- | --- |
| `config/world.yaml` | 端口、地图尺寸、AOI 格子、帧率、阵营敌对表、玩家模板 | config → 各系统 |
| `config/skills.yaml` | 技能 | combat |
| `config/monsters.yaml` | 怪物 / NPC 模板和刷怪点 | spawn、ai |
| `config/items.yaml` | 装备 | item、attr、combat、session |
| `config/map.tmj` | Tiled 地图：场景物件、碰撞形状、地表区域和道路 | nav；server 原样提供给前端（`/map.tmj`） |
| `bt/trees/*.json` → `internal/ai/trees/*.go` | 行为树（BtTree 编辑、导出） | bt、ai |
| `proto/btdemo.proto` → `internal/pb` | 协议 | session、server、前端 |

## 测试

- `internal/bt/runner_test.go`：行为树运行时的语义（选择器打断、序列恢复、装饰器、服务）。
- `internal/game/nav/nav_test.go`：碰撞推出、视线、A*。
- `internal/game/*_test.go`：在真实配置或手搭的小世界上逐帧推进，检查追击、技能、升级、AOI 进出、寻路绕墙、出生点不在物件里等。
- `internal/game/sync_consistency_test.go`：模拟客户端只吃收到的消息（`Enter` / `Leave` / 增量），每个同步帧后断言它的可见集合和实体状态与服务端九宫格里的完整状态一致，含断线重连。
- `internal/server/server_test.go`：起一个真的 HTTP 服务，用 WebSocket 客户端走完 Hello 握手、同步和 token 重连。
- `cmd/bench`：带宽压测工具（`go run ./cmd/bench -url ws://127.0.0.1:8090/ws -bots 200 -seconds 60`），开一批机器人随机移动、放技能，只统计收到的字节数和帧数。
- `internal/ai/trees/trees_test.go`：`bt/trees/` 里的每棵树都已导出并登记在 `registry.go` 里。
