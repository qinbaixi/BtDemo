# bt 和 ai：行为树

代码：`internal/bt/`（运行时）、`internal/game/ai/`（游戏节点与调试追踪，宠物节点在 `pet_nodes.go`）、`internal/ai/trees/`（导出的树）、`bt/`（BtTree 工程）、`tools/btregistry/`（生成注册表）

## 三层分工

```text
bt/trees/*.json            ← 在 BtTree 编辑器里画的树（数据）
      │ BtTree "Export: Go"
      ▼
internal/ai/trees/*.go     ← 导出的 Go 文件：每棵树一个 map[int]map[string]any（仍然是数据）
      │ go generate → registry.go：树名 → 数据
      ▼
internal/bt                ← 运行时：把数据变成 Tree，按行为树语义执行；不认识游戏
      │ 通过 Registry 按 sub_type 调用
      ▼
internal/game/ai           ← 游戏节点：find_target、chase_target、cast_skill……真正操作实体
```

关键思想：**树的结构是数据，节点的行为是代码**。策划在编辑器里改树、重新导出，只要没用到新的节点类型，Go 代码一行都不用改。

## 导出的数据长什么样

```go
// internal/ai/trees/monster_melee.go（自动生成，不要手改）
var MonsterMeleeNodes = map[int]map[string]any{
    1: {"type": "composite", "sub_type": "selector", "services": []int{2}, "children": []int{4, 9, 15}},
    2: {"type": "service", "sub_type": "update_target", "time_between_ticks": 0.5,
        "properties": map[string]any{"Range": 220}},
    ...
}
```

每个条目有 `type`（composite / task / decorator / service）、`sub_type`（节点类型名）、`properties`（节点参数），通过 id 引用子节点、装饰器和服务。

`tools/btregistry` 扫描这些文件，生成 `registry.go`：

```go
var All = map[string]Exported{
    "monster_melee": {RootID: MonsterMeleeRootID, Nodes: MonsterMeleeNodes},
    ...
}
```

`monsters.yaml` 里模板的 `tree: monster_melee` 就是按这个名字找树。

## bt：运行时

### 加载与校验（tree.go）

- `bt.Load(name, rootID, nodes)`：把 map 数据变成 `*Node` 组成的树，检查引用的 id 都存在。
- `tree.Validate(registry)`：检查每个节点的 `sub_type` 都有对应的实现。**启动时校验**，树里用了没实现的节点会直接启动失败并指出节点 id，不会等到运行时才出错。
- `Node.Num("Range", 250)` / `Node.Str(...)`：读节点参数，缺省时用默认值。

### 执行语义（runner.go）

每个实体有自己的 `bt.Instance`（同一棵树共享 `Tree`，各自的运行状态分开）。每帧调用一次 `Instance.Tick(now)`，**从根节点重新开始评估**。行为树里的时间（`Seconds`、`time_between_ticks`）仍按秒，和编辑器里一样；`game/ai` 用 `seconds(ms)` 把游戏时钟换成秒，再传给 `Instance.Tick`。

例外：被击退、硬直中、前摇中（见 [attr 和 combat](attr-combat.md) 的“命中的分量”）这一帧不跑行为树（`ai.pauseReason`），动作设成 `stagger` 或 `windup`；前摇的那一下由 combat 到点结算。调试面板上这一帧只显示根节点和暂停原因。

节点语义：

| 节点 | 行为 |
| --- | --- |
| `selector` | 按顺序试子节点，第一个不失败的结果就是自己的结果。**每帧都从第一个开始试**，所以高优先级分支（比如“血少逃跑”）能打断正在运行的低优先级分支（比如“游荡”） |
| `sequence` | 依次执行子节点，有一个不成功就停。运行中的序列下一帧**从上次运行的那个子节点继续** |
| `random_selector` | 进入时随机打乱顺序，再按 selector 的方式执行 |
| `parallel` | 同时执行所有子节点；`Policy: RequireAll` 全部成功才成功，`RequireOne` 一个成功就成功 |
| task | 叶子节点，调用游戏代码，返回 Success / Failure / Running |

节点返回三种状态：`Success`、`Failure`、`Running`（还没做完，下一帧继续，比如正在追击）。

**新进入（Fresh）**：一个节点如果上一帧不是 Running，这一帧就算“新进入”。新进入时清空它的临时内存 `ctx.Mem`。例如 `wander` 在新进入时随机挑一个目标点存进 `Mem`，之后的帧沿用这个点，直到走到或超时。

**装饰器**挂在节点上：

- 条件装饰器（`has_target`、`target_in_range`、`hp_below`、`far_from_home`、`was_attacked`）：只在新进入时检查（标了 `periodic` 的每帧都检查）。不满足就直接 Failure。`inverse_check_condition` 把条件取反。
- 结果装饰器（内置，不需要游戏代码）：`cooldown`（成功后 N 秒内不能再进入）、`invert`（成功和失败互换）、`force_success`（失败也当成功，用来包装“可有可无”的步骤，比如说一句台词）。

**服务**挂在组合节点上，按 `time_between_ticks` 定期执行，用来做后台工作，比如 `update_target` 每 0.5 秒刷新一次仇恨目标。

**Active**：每帧记录最后执行的叶子节点名，显示在角色头上（“追击”“待机”）。

**Tracing**：打开后记录这一帧访问过的每个节点、深度、结果，以及原因（被哪个装饰器挡住、哪个装饰器改了结果、哪个服务触发了）。调试面板就是用它显示决策过程的，只有被观察的实体才会打开。

## ai：游戏节点（nodes.go）

`ai.System.register()` 把每个 `sub_type` 绑定到一个 Go 函数。节点函数通过 `ctx.Agent.(*Agent)` 拿到自己控制的实体：

| 类型 | sub_type | 做什么 |
| --- | --- | --- |
| task | `find_target` | 找 Range 内最近的敌人设为目标 |
| task | `clear_target` | 清空目标 |
| task | `chase_target` | 沿寻路路径追目标，边缘距离 ≤ StopRange 时成功 |
| task | `cast_skill` | 对目标释放第 Slot 个技能（槽位对应模板 `skills` 的顺序，从 1 开始） |
| task | `wander` | 在出生点 Radius 范围内随机找一个空地走过去 |
| task | `return_home` | 走回出生点并回满血、清目标 |
| task | `flee` | 朝远离威胁的方向逃 Distance 像素 |
| task | `wait` | 等 Seconds 秒 |
| task | `say` | 头顶冒一句 Text |
| 条件 | `has_target` / `target_in_range` / `hp_below` / `far_from_home` / `was_attacked` | 见名知意 |
| 服务 | `update_target` | 当前目标跑太远就放弃；优先反击最近 5 秒内打过自己的人；否则找最近的敌人 |
| 宠物 | `follow_owner` 等 7 个 | 见下面的[宠物节点](#宠物节点) |

移动类节点都调用 `move.Toward`，所以都会自动绕开障碍；技能节点调用 `combat.Cast`，和玩家走的是同一条路径。

启动时 `ai.New` 还会检查：每个模板的树里 `cast_skill` 用到的槽位，模板都配了对应数量的技能。

## 宠物节点

宠物（`kind = pet`，见 [pet](pet.md)）用同一套运行时，节点在 `internal/game/ai/pet_nodes.go`。宠物的主人是 `entity.Owner`；主人不在场（死了、已删除）时这些节点都返回失败 / 不成立，`guard_owner` 会清掉目标。其余已有节点（`has_target`、`target_in_range`、`cast_skill`、`chase_target`、`wait`、`say`、`cooldown`……）照常用；宠物的 `home` 没有意义，所以树里不用 `return_home` / `far_from_home`。

| 类型 | sub_type（BtTree 里的名字） | 参数 | 做什么 |
| --- | --- | --- | --- |
| 服务 | `guard_owner`（GuardOwner） | `Range`=300，`Leash`=450 | 每次 tick 选目标。优先级：主人当前攻击的目标（敌对，离主人 ≤ Range）> 最近 5 秒内打过主人的敌人（离主人 ≤ Leash）> 主人 Range 内最近的敌人。都没有时，已有的目标离主人超过 Leash 就清掉，否则保持。Explain 写明选了谁、为什么 |
| 任务 | `follow_owner`（FollowOwner） | `Distance`=60 | 走到主人身边 Distance 以内（主人在走时站在侧后方，按宠物 id 分左右），到了返回 Success，路上 Running；离主人超过 `world.yaml` 的 `pet.teleport` 时直接传送到主人身边，发 `fx = pet_teleport` 的 `CAST` 事件，返回 Success。落得很远（> Distance × 3）时加速追赶 |
| 任务 | `keep_distance`（KeepDistance） | `Min`=120，`Max`=220 | 和目标的边缘距离保持在 Min ~ Max：太近后退，太远靠近（走向目标线上区间中点的位置），在区间内返回 Success，路上 Running |
| 任务 | `cast_on_owner`（CastOnOwner） | `Slot`=1 | 对主人释放第 Slot 个技能（`ally` 技能，比如 `pet_mend`）；冷却、超出射程时失败 |
| 条件 | `owner_far`（OwnerFar） | `Distance`=350 | 离主人超过 Distance |
| 条件 | `owner_hp_below`（OwnerHpBelow） | `Percent`=60 | 主人生命百分比低于 Percent |
| 条件 | `owner_in_combat`（OwnerInCombat） | 无 | 主人最近 5 秒内攻击过（`LastDealtAt`）或被攻击过（`LastHitAt`） |

启动时 `checkSlots` 对宠物同样检查：树里 `cast_skill` / `cast_on_owner` 用到的槽位，`pets.yaml` 里的宠物都配了对应数量的技能。

## 以近战怪为例读一棵树

```text
selector（根）   服务：update_target Range=220，每 0.5 秒
├─ sequence  [far_from_home 450]       离家太远：清目标、喊一句、回家
│   ├─ clear_target
│   ├─ say
│   └─ return_home
├─ selector  [has_target]              有目标：能打就打，打不到就追
│   ├─ cast_skill Slot=2  [target_in_range]   重击，冷却中会失败，轮到下一个
│   ├─ cast_skill Slot=1  [target_in_range]   普攻
│   └─ chase_target
└─ sequence                            没事做：游荡一下，停一会
    ├─ wander
    └─ wait
```

每帧从根开始：离家太远的分支优先级最高，会打断追击；有目标时先尝试重击（技能冷却中 `cast_skill` 返回失败），再尝试普攻，都打不到就追；什么都没有就游荡。

## 调试追踪（trace.go）

前端调试面板选中一个实体后，客户端发 `Watch{id}`。`session.Watched()` 收集所有被观察的实体，`AI.Tick` 只给它们打开 Tracing，`recordTrace` 把每帧的执行记录转成 `pb.AiTick` 缓存起来，下次同步时由 `Trace(entity, defSent)` 打包成 `AiTrace`（执行记录、目标、血量、离家距离、黑板、当前路径）发给观察者，然后清空。没人观察时这部分没有任何开销。下发给调试面板的 `AiTick.time` 是毫秒（游戏时钟），`AiTreeNode.interval` 也是毫秒（`trace.go` 把树里的秒换算过来），`AiTrace.path` 是交错排列的整数像素 x、y。

每个访问过的节点记录：

- 结果，以及是新进入还是接着上一帧运行（`fresh`；接着运行时只复查 `periodic` 条件）；
- 检查过的每个条件装饰器（含冷却）过没过、依据是什么（`checks`）；
- 服务有没有触发、做了什么，以及任务看到了什么（`notes`、`why`）。

“依据”由节点函数自己写：在条件、任务、服务里调用 `ctx.Explain("到 %s 的距离 %.0f > %.0f", ...)`。不追踪时 `Explain` 直接返回，没有开销；需要先算一堆东西才能写说明时，用 `ctx.Tracing()` 判断一下。新增节点时顺手写上 Explain，调试面板就能看到它为什么成功或失败。

开始观察后的第一次（或者实体换了树）还会附上整棵树的结构 `AiTreeDef`：每个节点的类型、参数、子节点、装饰器、服务，以及编辑器里起的名字。名字取自导出文件里每个节点前的注释（`// Selector - 近战怪物`），由 `tools/btregistry` 生成到 `registry.go` 的 `Labels` 里。前端据此画出整棵树，没执行到的节点也能看到。

## 新增一个节点类型的步骤

1. 在 `bt/owl-bt.json` 里声明节点（名字、参数），用 BtTree 打开就能在树里使用。
2. 在 `internal/game/ai/nodes.go` 的 `register()` 里用 `reg.Task` / `reg.Condition` / `reg.Service` 注册同名（snake_case）的函数。
3. 在编辑器里把节点放进树，导出 Go（Windows 下可以用 `scripts\export-bt.bat`），再 `go generate ./internal/ai/trees`。
4. `go test ./...`；启动时如果有节点没实现，会报出是哪棵树的哪个节点。
