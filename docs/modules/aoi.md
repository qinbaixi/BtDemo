# aoi：九宫格视野

代码：`internal/game/aoi/grid.go`

## 职责

1. 决定每个玩家能看见哪些实体，并在视野变化时通知 session（`Shown` / `Hidden`）。
2. 给其他系统提供快速的范围查询（“我周围 250 像素内有没有敌人”）。
3. 给广播提供“能看到某个点的玩家”：每个格子单独存一份玩家，广播不用遍历怪物和 NPC。

## 算法

地图按 `world.yaml` 的 `aoi.cell`（默认 320 像素）切成格子。实体只记录在它圆心所在的那一个格子里。玩家能看到的范围是**自己所在格子加周围 8 格**，共 9 格，所以叫九宫格。

```text
┌────┬────┬────┐
│ 看 │ 看 │ 看 │
├────┼────┼────┤
│ 看 │ 我 │ 看 │     格子边长 320，视野约为 960×960
├────┼────┼────┤
│ 看 │ 看 │ 看 │
└────┴────┴────┘
```

## 数据结构

```go
type Grid struct {
    Cell       float64
    Cols, Rows int
    cells      []map[int]*core.Entity  // 每个格子里的全部实体
    players    []map[int]*core.Entity  // 每个格子里的玩家（cells 的子集）
    where      map[int]int             // 实体 id → 所在格子
    watcher    Watcher                 // 视野变化通知（session 实现）
}
```

`where` 让实体本身不需要保存任何 AOI 字段：实体移动后调用 `grid.Moved(entity)`，它查出旧格子、算出新格子，不同才搬家。这个调用由 `move.By` / `move.Place` 负责，其他系统改位置都应该通过 move。

`players` 是 `cells` 的子集：广播一条消息（事件、状态增量）只需要遍历九宫格里的玩家，不用把格子里的实体全扫一遍再挑出玩家。

## 接口

| 方法 | 用途 | 调用者 |
| --- | --- | --- |
| `Add / Remove` | 实体进入或离开世界，并通知 `Shown` / `Hidden` | spawn |
| `Moved` | 位置变了，更新格子；换格子时通知视野变化 | move、session.Flush（保险） |
| `Around(cell)` | 格子和它周围的格子（九宫格，边上更少） | 各处 |
| `Neighbors(cell, fn)` | 遍历九宫格内的实体 | session（重连发全量）、测试 |
| `EachIn(cells, fn)` / `PlayersIn(cells, fn)` | 遍历这些格子里的实体 / 玩家 | session（视野进出） |
| `PlayersAround(x, y, fn)` | 遍历能看到 (x, y) 的玩家 | session.Broadcast |
| `InRange(x, y, r, fn)` | 遍历圆心在半径 r 内的实体，只查覆盖到的格子 | combat（找最近敌人、AOE） |
| `Sees(a, b)` | 格子 a 的观察者能否看到格子 b | 各处 |
| `CellOf(x, y)` | 坐标所在格子 | 各处 |
| `SetWatcher` | 设置接收视野变化的对象 | session.New |

## 视野变化怎么下发

“玩家 P 能看到实体 E”等价于“两者所在格子相邻”，这是对称的，所以 Grid 不需要为每个玩家维护可见集合，只要在实体变化时告诉 `Watcher`“它在哪些格子里出现 / 消失了”：

- `Add`：`Shown(entity, 周围九宫格)`；`Remove`：`Hidden(entity, 周围九宫格)`。
- `Moved` 换了格子：旧九宫格有、新九宫格没有的格子 `Hidden`，新九宫格有、旧九宫格没有的格子 `Shown`。两个九宫格重叠的部分什么都不通知。

session 收到通知后（`view.go`）：

1. 通知里那些格子里的玩家（`PlayersIn`）：看到 / 看不到 `entity`，发 `Enter`（`EntityInfo`：名字、模型、半径等静态信息加完整状态）/ `Leave`。
2. `entity` 自己是玩家时：它也看到 / 看不到那些格子里的所有实体，发一条 `Enter` / `Leave`。

之后实体的变化不再走 Grid：状态变化靠脏标记，每个同步帧把增量 `EntityState` 按实体位置广播给 `PlayersAround`，事件按发生位置广播（见 [session 和 server](session-server.md)）。静态信息只在进入视野时发一次，动态信息只发变化的字段，这是 AOI 节省流量的关键。`Session.visible` 记着发过 `Enter` 的实体，避免重复。

## 设计取舍

- 视野是方形的九宫格而不是圆形，判断只需要比较格子坐标，非常便宜。
- 死亡的实体留在格子里直到复活，所以周围的人能看到尸体倒地。
- 按 `G` 键前端会画出格子和当前视野，方便观察进出视野。
- 格子越小，视野越小、同步越省，但跨格越频繁。320 像素配合 1280×800 的画面，刚好比屏幕大一圈。
