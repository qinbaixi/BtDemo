# core：共享数据

代码：`internal/game/core/`（`entity.go`、`state.go`、`pbutil.go`）

## 职责

所有系统都要用到的数据放在这里：实体、实体表、时钟、随机数、事件队列、配置。**core 不包含任何游戏规则**，规则都在各系统包里。这样每个系统只依赖 core，而不需要互相依赖。

## State：交给每个系统的“世界状态”

```go
type State struct {
    Cfg    *config.Config   // 所有配置
    Rand   *rand.Rand       // 唯一的随机数源（带种子，测试可复现）
    Clock  Clock            // 游戏时间
    Ents   Entities         // 实体表
    Events Events           // 本次同步前发生的事件
}
```

每个系统的 `New` 都接收同一个 `*core.State`。

- **Clock**：`Now` 是游戏开始后的秒数，`Dt` 是每帧秒数（1/tick_rate），`Tick` 是帧号。所有冷却、Buff、复活时间都用 `Now` 计算，不用系统时钟，所以测试里可以手动推进时间。
- **Rand**：所有随机（暴击、伤害浮动、刷怪散布、随机选择器）都走这一个随机源。同样的种子、同样的输入，跑出同样的结果。
- **Entities**：`map[id]*Entity` 加一个排好序的 id 切片。`Each` 按 id 顺序遍历（Go 的 map 遍历顺序是随机的，直接遍历会让结果不可复现），并先复制 id 列表，所以回调里增删实体是安全的。
- **Events**：`Emit(e, ev)` 把事件和发生位置（实体当前坐标）一起入队；`session.Flush` 只把发生在玩家九宫格内的事件发给他，然后 `Clear`。

## Entity：用组件组织字段

玩家、怪物、NPC 都是同一个 `Entity` 类型，用 `Kind` 区分。字段按关注点分成组件，通过结构体嵌入组合（`e.X` 等价于 `e.Transform.X`）：

```go
type Entity struct {
    Identity   // 是谁：ID、Kind、Name、Faction、Color、Model、Tmpl（模板，玩家为 nil）
    Transform  // 在哪：X/Y、出生点 HomeX/HomeY、Radius
    Stats      // 等级、经验、Base 基础属性、Growth 成长、Speed、Attr 派生属性、HP
    Combat     // Skills、Cooldowns、Buffs、Target、LastAttacker、LastHitAt
    Life       // Dead、RespawnAt
    Control    // 玩家输入方向 MoveX/MoveY
    Steering   // 寻路：Path、Goal、Reaches、Planned、RepathAt、StuckFor
    Brain      // 行为树实例 AI、当前动作 Action、调试追踪 AITicks
}
```

为什么不用真正的 ECS（每种组件一张表）？这个规模下一个结构体最直观，调试时打印一个实体就能看到全部状态；分组件只是为了让“谁负责哪些字段”一目了然（见[整体架构](../architecture.md#数据归属谁能改什么)）。

## 常用辅助函数

| 函数 | 含义 |
| --- | --- |
| `e.Alive()` | 不为 nil 且没死。对 nil 调用也安全，所以 `s.Ents.Get(id).Alive()` 可以直接写 |
| `core.Dist(a, b)` | 圆心距离 |
| `core.EdgeDist(a, b)` | 边缘距离（圆心距离减两个半径）。技能射程、追击停止距离都用它，所以体型大的怪不会“贴脸才打得到” |
| `e.HomeDist()` | 离出生点多远（脱战回家用） |
| `e.HPRatio()` | 血量百分比 |
| `core.I32 / F32` | 生成 proto2 的可选字段指针 |
| `core.Round1` | 保留一位小数，减少下发的数据量 |

`MaxRadius = 64` 是实体半径的上限。按圆心做范围查询时多查这么一圈，再用边缘距离精确判断，就不会漏掉体型大的目标。

## 想加新字段时

1. 先想它属于哪个组件（或者新建一个组件结构体，嵌入到 `Entity`）。
2. 在组件注释里写清楚由哪个系统负责。
3. 如果复活时需要重置，在 `spawn.respawn` 里处理。
4. 如果客户端需要看到，在 `session/proto.go` 里加到 `entityInfo` / `entityState` / `selfInfo`，并改 `proto/btdemo.proto`。
