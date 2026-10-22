# session 和 server：连接与同步

代码：`internal/server/server.go`（网络）、`internal/game/session/`（会话逻辑）、`proto/btdemo.proto`（协议）、`internal/pb/`（生成的 Go 代码）

## 分工

- **server** 只管网络：HTTP、WebSocket、protobuf 编解码、读写 goroutine。它不碰游戏状态，所有操作都通过 `world.Do` 交给世界 goroutine。
- **session** 是游戏里的“连接”：把客户端消息变成游戏操作，并在同步时决定每个玩家该收到什么。它运行在世界 goroutine 里。

## 一个连接的生命周期（server.go）

```text
浏览器连 /ws
  └─ serve(conn)
       ├─ w.Do(Join)：创建角色、发 Welcome，拿到 *Session
       ├─ 写 goroutine：for data := range s.Out { conn.Write(data) }
       ├─ 读循环（当前 goroutine）：
       │     收到二进制帧 → proto.Unmarshal 成 pb.ClientMsg → w.Do(Input)
       └─ 读出错（断开）→ w.Do(Leave)：删除角色，关闭 s.Out → 写 goroutine 结束
```

`Session.Out` 是一个容量 64 的 channel，世界 goroutine 往里放编码好的字节，写 goroutine 取出来发送。世界 goroutine **从不阻塞在网络上**：如果客户端太慢、Out 满了，直接断开它（丢一帧会让客户端的 AOI 状态错乱，不如让它重连拿一份全新的视野），见 `session.send`。

## 协议（proto/btdemo.proto）

用 protobuf（proto2）二进制编码。服务端用 `protoc` 生成的 `internal/pb`；前端用 protobufjs 从同一份 `.proto` 生成 JS 代码和 TypeScript 类型（`web` 下 `npm run proto`），字段对不上时编译期就报错。服务端仍在 `/btdemo.proto` 提供原文，方便查看；地图文件在 `/map.tmj` 原样提供（见 [地图](map.md)）。

客户端 → 服务端 `ClientMsg`（oneof 六选一）：

| 消息 | 含义 |
| --- | --- |
| `Move{dx, dy}` | 移动方向（服务端归一化，0 表示停） |
| `SetTarget{id}` | 选中目标 |
| `Cast{slot, target, dx, dy}` | 释放第 slot 个技能；`dx`、`dy` 是瞄准方向，给 dash（闪现往哪）和 line（飞斧往哪）用，服务端归一化 |
| `Watch{id}` | 调试面板要观察这个实体的行为树（0 表示不看） |
| `Block{on}` | 按下 / 松开右键格挡 |
| `Loadout{skills}` | 挑技能：按顺序放到第 2 格起的技能 id 列表（见下面 Input） |

服务端 → 客户端 `ServerMsg`：

| 消息 | 何时发 | 内容 |
| --- | --- | --- |
| `Welcome` | 连接时一次 | 自己的 id、地图尺寸、AOI 格子、技能栏、碰撞体 `obstacles`（调试显示用；场景物件前端从 `/map.tmj` 读）、技能池 `pool`（slot 为 0）、要挑几个 `pick` |
| `Enter` | 实体进入视野 | 静态信息：名字、种类、模型、半径、颜色、等级、血量 |
| `Leave` | 实体离开视野 | id 列表 |
| `Sync` | 每次同步（10Hz） | 视野内实体的位置、血量、动作、外观（`looks`，Buff 外观的位），视野内的事件，自己的属性冷却 Buff，被观察实体的 AI 追踪 |
| `SkillBar` | 挑技能被接受后 | 新的技能栏（`skills`，slot 从 1 起） |
| `Toast` | 技能放不出来、挑技能被拒绝等 | 一行提示 |

技能信息 `SkillInfo` 的 `kind` 是 `target`、`aoe`、`self`、`dash`、`line` 之一，`desc` 是选技能面板上的说明。

事件 `Event` 用 `kind` 区分：施法、伤害、治疗、Buff、死亡、复活、说话、升级。几个字段是后加的：

- `DAMAGE` 的 `immune`：目标无敌，没受伤（`value` 为 0）；`blocked`、`absorbed` 分别是格挡和护盾吸收的量，都不计入 `value`。
- `CAST` 的 `tx`、`ty`：闪现和飞斧的终点（`x`、`y` 是起点）。

**改协议的步骤**：改 `proto/btdemo.proto` → `go generate ./internal/pb`（需要 protoc，CI 会检查生成代码是否最新）→ 服务端填字段（`session/proto.go`）→ 前端 `npm run proto`，在 `web/src/net/types.ts` 加字段、`web/src/net/protocol.ts` 里转换（见 [前端](frontend.md)）。proto2 的可选字段在 Go 里是指针，用 `core.I32`、`core.F32`、`proto.String` 生成。

## 会话逻辑（session.go）

### Join / Leave

`Join` 调 `spawn.Player()` 创建角色，组装 `Welcome`，并把角色的 `CanPick` 设为真（还没放过技能，可以挑）。碰撞体在 `session.New` 时用 `obstacles` 转换一次，之后每个 Welcome 直接复用。

### Input

在世界 goroutine 里执行，所以可以直接改实体：

- `Move`：归一化方向写进 `entity.MoveX/MoveY`，下一帧 `move.Tick` 才真正移动（输入和移动解耦，移动速度只由服务端决定）。
- `Cast`：选中的目标无效时自动找最近的怪（只对 `target` 类技能），然后 `combat.CastAimed` 带上 `dx`、`dy`，失败就回一个 `Toast`。
- `Loadout`：挑技能，见下面的规则。
- `Block`：写进 `entity.Blocking`，伤害结算和移动会读它。
- `SetTarget`、`Watch`：记下来。

#### 挑技能（Loadout）

`loadout()` 检查，任何一条不满足都回 `Toast`，全部通过就换上技能并回 `SkillBar`：

1. 角色的 `CanPick` 为真：刚进游戏还没放过技能，或者死亡期间。放过一次技能之后就不能再挑，直到下次死亡。
2. 数量正好是 `Pick()`，不多不少。不对回 “技能选择无效”。
3. 每个 id 都在 `skill_pool` 里，且不重复。不对回 “技能选择无效”。

第 1 格的普攻不变，挑出来的依次放到第 2 格起。第 1 条不满足时回 “只能在刚进游戏或死亡时更换技能”，第 2、3 条不满足时回 “技能选择无效”。

### Flush：同步

每 `tick_rate / sync_rate` 帧调用一次，对每个玩家：

1. 九宫格内实体 vs 上次可见集合 → 发 `Leave`、`Enter`。
2. 组一个 `Sync`：视野内每个实体的 `EntityState`、发生在视野格子里的事件、`SelfInfo`、被观察实体的 `AiTrace`。
3. 全部发完后清空事件队列和 AI 追踪缓存。

所以一个事件只会被发送一次，且只发给看得见它发生的人。

### proto.go

把 `core.Entity` 转成协议消息的几个函数：`entityInfo`（进入视野的静态信息）、`entityState`（每次同步的动态信息，含 `looks`）、`selfInfo`（自己的详细属性）、`skillInfo` / `skillBar`（技能栏和技能池里的一条技能、整个技能栏）、`obstacles`（碰撞体）。坐标保留一位小数，血量向上取整，减少数据量。

## 前端在哪里接这些消息

`web/src/net/protocol.ts` 的 `decode` 把 `ServerMsg` 转成前端用的普通对象，`web/src/game/sync.ts` 更新本地状态，`web/src/render/` 每帧绘制。前端只做表现和插值，所有判定（碰撞、伤害、冷却）都以服务端为准。
