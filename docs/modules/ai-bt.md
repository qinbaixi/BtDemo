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
| `utility_selector` | 效用选择：进入时给每个子节点打分，按分数从高到低像 selector 一样尝试；**选中的子节点做完之前不重新打分**。见下面的[效用 AI](#效用-aiutilitygo) |
| task | 叶子节点，调用游戏代码，返回 Success / Failure / Running |

节点返回三种状态：`Success`、`Failure`、`Running`（还没做完，下一帧继续，比如正在追击）。

**新进入（Fresh）**：一个节点如果上一帧不是 Running，这一帧就算“新进入”。新进入时清空它的临时内存 `ctx.Mem`。例如 `wander` 在新进入时随机挑一个目标点存进 `Mem`，之后的帧沿用这个点，直到走到或超时。

**装饰器**挂在节点上：

- 条件装饰器（`has_target`、`target_in_range`、`hp_below`、`far_from_home`、`was_attacked`）：只在新进入时检查（标了 `periodic` 的每帧都检查）。不满足就直接 Failure。`inverse_check_condition` 把条件取反。
- 结果装饰器（内置，不需要游戏代码）：`cooldown`（成功后 N 秒内不能再进入）、`invert`（成功和失败互换）、`force_success`（失败也当成功，用来包装“可有可无”的步骤，比如说一句台词）。

- 打分装饰器（`utility`、`consideration`，以及游戏用 `reg.Score` 注册的）：只给父节点 `utility_selector` 打分，**不当条件**，不会让节点失败。

**服务**挂在组合节点上，按 `time_between_ticks` 定期执行，用来做后台工作，比如 `update_target` 每 0.5 秒刷新一次仇恨目标。

**Active**：每帧记录最后执行的叶子节点名，显示在角色头上（“追击”“待机”）。

**Tracing**：打开后记录这一帧访问过的每个节点、深度、结果，以及原因（被哪个装饰器挡住、哪个装饰器改了结果、哪个服务触发了）。调试面板就是用它显示决策过程的，只有被观察的实体才会打开。

### 效用 AI（utility.go）

BtTree 编辑器的 `UtilitySelector` 导出为普通组合节点 `utility_selector`，打分装饰器 `Utility`、`Consideration` 导出为 `utility`、`consideration`，导出器不用改。规则和编辑器的运行模式一致（编辑器里跑出来什么样，游戏里就什么样）：

- **什么时候打分**：`utility_selector` 新进入时给每个子节点打一次分，按分数排好顺序存在节点内存里；之后像 `random_selector` 一样从正在运行的子节点继续，不重新打分。子节点成功、或全部失败后，下次进入才重新打分。注意它不像 `selector` 那样每帧抢占，所以子任务要能自己结束（比如 `find_shot_spot` 一看得见就当帧成功）。
- **子节点的分数**：它所有打分装饰器的分数相乘。有多个打分装饰器时，0–1 之间的分数先做补偿 `s + (1 - s) × (1 - 1/n) × s`（n 为个数），免得因子越多分越低；0–1 以外的数当权重原样相乘。没有打分装饰器的子节点 0 分。
- **谁会被执行**：分数 ≤ 0 或低于 `MinScore` 的不执行；同分保持原来的顺序。子节点自己的条件装饰器照常检查，没通过就算失败。
- **属性**：`OnChildFailure`（`TryNext` 默认：选中的失败了按分数试下一个；`Fail`：只试最高分的）、`Selection`（`Highest` 默认；`WeightedRandom`：前 `RandomTop` 名按分数加权随机排序，0 = 全部，用实例的随机数）、`MinScore`（默认 0）。
- **内置打分装饰器**：`utility` 固定分数 `Score`；`consideration` 读输入 `Input`，按 `Min`–`Max` 归一化到 0–1（截断），再经响应曲线 `Curve` 得到分数。曲线（不区分大小写）：`Linear`、`InverseLinear`、`Quadratic`、`InverseQuadratic`、`Sqrt`、`InverseSqrt`、`Logistic`、`InverseLogistic`（S 形，0→0、0.5→0.5、1→1）、`Step`、`InverseStep`（0.5 处跳变）。曲线名写错启动时 `Validate` 报错。
- **输入从哪来**：`consideration` 的 `Input` 先找游戏用 `reg.Input(name, fn)` 注册的计算型输入（每次打分时现算，不写黑板），找不到再读黑板里同名的数值（布尔按 1 / 0），都没有按 0。现在注册了三个（`game/ai/utility_inputs.go`）：`TargetDistance`（到目标的边缘距离，像素；没目标时很大）、`HpPercent`（自身生命 0–100）、`TargetHpPercent`（目标生命 0–100）。它们也在 `bt/owl-bt.json` 的 `blackboard` 里声明了，编辑器里可以直接选，运行模式里可以手动改值试分数。
- **自定义打分装饰器**：`reg.Score("my_score", func(ctx *bt.Ctx) float64 {...})`，在 `bt/owl-bt.json` 里声明同名装饰器即可；函数里 `ctx.Explain` 写的依据会显示在调试面板这个分数旁边。

示例：骷髅弓手（`monster_ranged`）的“战斗”分支是 `utility_selector`：

| 子节点 | 打分 | 条件 |
| --- | --- | --- |
| 拉开距离（flee） | `Consideration TargetDistance 0–120 InverseQuadratic` × `Utility 0.9`：贴脸时接近 0.9，60 像素约 0.8，100 像素以外很低 | 目标在 90 内、冷却 4 秒 |
| 射击（cast_skill） | `Utility 0.6` | 目标在 240 内、看得见 |
| 找射击位（find_shot_spot） | `Utility 0.4` | 目标在 320 内、看不见 |
| 靠近（chase_target） | `Consideration HpPercent 0–100 Linear` × `Utility 0.2`：血越少越不想追 | — |

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

## 狼群和首领节点

第一关「黑松林道」的狼群、头狼、灰鬃狼王用到的节点，在 `internal/game/ai/pack_nodes.go`。树是 `bt/trees/monster_pack.json`、`alpha_wolf.json`、`wolf_king.json`。

| 类型 | sub_type（BtTree 里的名字） | 参数 | 做什么 |
| --- | --- | --- | --- |
| 任务 | `flank`（Flank） | `Distance`=70 | 包抄：盯着同一个目标的狼按 ID 排队，围着目标平均分角度，每只走到自己的站位（离目标 Distance），到了返回 Success。绕了 4 秒还没到（被挡住）也返回 Success，直接扑上去 |
| 条件 | `allies_near`（AlliesNear） | `Range`=200，`Count`=2 | Range 以内同阵营、同类的活同伴至少 Count 个（头狼同伴够多才嚎叫） |
| 任务 | `summon`（Summon） | `Template`、`Count`=1、`Radius`=200 | 在自己周围 Radius 处叫出 Count 只 Template。叫来的怪算进自己所在的房间（死光了房间才清完），一出来就盯上自己的目标。由场景接到关卡系统（`level.System.Summon`） |
| 任务 | `set_phase`（SetPhase） | `Phase`=2 | 把首领的阶段设成 Phase（`Entity.Brain.Phase`） |
| 条件 | `phase_at_least`（PhaseAtLeast） | `Phase`=2 | 阶段至少是 Phase。配合取反：“血量低于 60% 且还没到第 2 阶段”只进一次 |

灰鬃狼王的树（`wolf_king.json`）：

1. 血量低于 60% 且还没到第 2 阶段：设阶段 2，喊一句，叫三只狼，放狼王号令（集结）；
2. 血量低于 25% 且还没到第 3 阶段：设阶段 3，喊一句，放嗜血（长时间加攻加速）；
3. 打：第 2 阶段起身边的狼少于两只时再叫（至少隔 20 秒）；第 3 阶段起每 7 秒连扑三次；260 以内扑杀；然后重咬、咬、追。

模板可以不写 `tree`（比如荆棘丛），这样的实体没有行为树，站着不动。

## 地穴节点（视线、骷髅、机关）

第二关「亡者地穴」用到的节点，在 `internal/game/ai/sight_nodes.go` 和 `crypt_nodes.go`。树是 `bt/trees/monster_ranged.json`（弓手加了找射击位）、`skeleton_soldier.json`、`skeleton_knight.json`、`bone_pile.json`、`bone_statue.json`、`blood_hammer.json`（首领）。

| 类型 | sub_type（BtTree 里的名字） | 参数 | 做什么 |
| --- | --- | --- | --- |
| 条件 | `has_sight`（HasSight） | | 看得见目标：中间没有墓碑、墙挡着（`combat.HasSight`，和箭能不能射到用同一个判断） |
| 任务 | `find_shot_spot`（FindShotSpot） | `Range`=240 | 看不见目标时横着挪：在目标连线的两侧和目标周围找一个看得见、又在射程内的空地，挑最近的走过去；每 0.6 秒重挑一次 |
| 任务 | `raise_shield` / `lower_shield`（RaiseShield / LowerShield） | | 举盾 / 放盾，和玩家格挡同一套规则（`combat.RaiseBlock`）；破防后架势没回到一半举不起来，返回 Failure |
| 条件 | `facing_shield`（FacingShield） | | 目标举着盾，盾正对着我（从这里打会被挡住） |
| 任务 | `flank_shield`（FlankShield） | `Distance`=50 | 绕到目标的盾侧面（稍微偏后）；已经在盾挡不到的地方返回 Success，绕 2.5 秒还没绕过去也返回 Success（硬打） |
| 条件 | `skill_ready`（SkillReady） | `Slot`=1 | 第 Slot 个技能冷却好了（先确认能出手再放盾） |
| 任务 | `reassemble`（Reassemble） | `Range`=400 | 骨堆重新站起来变成模板的 `revive`（骷髅兵），盯上 Range 内最近的敌人。由场景接到关卡系统（`level.System.Reassemble`） |
| 任务 | `raise_bones`（RaiseBones） | `Template`=skeleton_archer、`X`、`Y` | 首领敲地：在 (X, Y) 刷一只 Template，和首领同一个房间、盯着首领的目标；那里站不下返回 Failure。由场景接到关卡系统（`level.System.SummonAt`） |
| 任务 | `warn_line`（WarnLine） | `Angle`=0、`Length`=600、`Seconds`=0.9 | 机关：沿 Angle 度往两头各 Length（撞墙截断）发预警（fx `line_warn` 的 CAST 事件），等 Seconds 秒 |
| 任务 | `fire_line`（FireLine） | `Slot`=1、`Angle`=0 | 机关：用第 Slot 个技能（直线穿透）沿 Angle 度往两头各射一次。阵营 `trap` 的模板才能配直线技能 |

行为树里移动用的步长（`Agent.step`）会乘上举盾减速和积水减速，和玩家一样。

食人魔首领·血槌的树（`blood_hammer.json`，和狼王一个结构）：

1. 血量低于 60% 且还没到第 2 阶段：设阶段 2，喊一句，放狂暴；
2. 血量低于 30% 且还没到第 3 阶段：设阶段 3，喊一句；
3. 打：第 2 阶段起每 15 秒敲地（`bone_knock`），坑边两处骨堆台子各站起一个骷髅弓手（`raise_bones`）；第 3 阶段起震地冲好了就震地（`skill_ready` + `blood_quake`）；第 2 阶段起狂暴冷却好了再放；目标在 110–380 之间冲撞（撞上石柱柱子碎、自己晕）；然后旋风斩、重锤、追。

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
- 服务有没有触发、做了什么，以及任务看到了什么（`notes`、`why`）；
- `utility_selector` 上还有 `scores`：每个子节点的总分和每个打分装饰器的分数（协议里是万分比整数，`score / 10000` 就是分数，可能超过 10000），以及打分装饰器的依据（如 `TargetDistance=85 → 归一 0.708 → InverseQuadratic 0.498`）；新进入那帧的 `why` 里有一句汇总 `打分：拉开距离 0、射击 0.6、找射击位 0.4、靠近 0.28 → 射击`。接着运行的帧（`fresh` 为 false）带的是进入时打的分。调试面板和行为树查看器在子节点后面显示“分 0.6”，打分装饰器用 ★ 标出，显示分数和依据，热力图上打分装饰器那一行是蓝色。

“依据”由节点函数自己写：在条件、任务、服务里调用 `ctx.Explain("到 %s 的距离 %.0f > %.0f", ...)`。不追踪时 `Explain` 直接返回，没有开销；需要先算一堆东西才能写说明时，用 `ctx.Tracing()` 判断一下。新增节点时顺手写上 Explain，调试面板就能看到它为什么成功或失败。

开始观察后的第一次（或者实体换了树）还会附上整棵树的结构 `AiTreeDef`：每个节点的类型、参数、子节点、装饰器、服务，以及编辑器里起的名字。名字取自导出文件里每个节点前的注释（`// Selector - 近战怪物`），由 `tools/btregistry` 生成到 `registry.go` 的 `Labels` 里。前端据此画出整棵树，没执行到的节点也能看到。

## 新增一个节点类型的步骤

1. 在 `bt/owl-bt.json` 里声明节点（名字、参数），用 BtTree 打开就能在树里使用。
2. 在 `internal/game/ai/nodes.go` 的 `register()` 里用 `reg.Task` / `reg.Condition` / `reg.Service`（打分装饰器用 `reg.Score`，Consideration 的输入用 `reg.Input`）注册同名（snake_case）的函数。
3. 在编辑器里把节点放进树，导出 Go（Windows 下可以用 `scripts\export-bt.bat`），再 `go generate ./internal/ai/trees`。
4. `go test ./...`；启动时如果有节点没实现，会报出是哪棵树的哪个节点。
