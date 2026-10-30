# config：配置

代码：`internal/config/config.go`、`internal/config/items.go`、`internal/config/layout.go`；数据：`config/*.yaml`

## 职责

启动时读入所有 YAML，补默认值，并**做完所有能提前做的检查**。原则是：配置有错就启动失败，并说清楚是哪个文件、哪一项、错在哪，而不是运行到一半才出现奇怪的行为。

## 数值单位约定

配置、战斗结算和协议里**没有浮点数**。Go 里用两个别名表示单位（`internal/config/units.go`）：

- **时间**（时长、冷却、时刻）：整数毫秒，`config.Millis`。例：`cooldown: 700` 是 0.7 秒。服务器时钟 `State.Now()` 也是毫秒。`tick_rate` 必须能整除 1000，因为每帧长 `Clock.Dt = 1000 / tick_rate` 也要是整数毫秒（`config.validate` 会检查）。
- **比例、概率、倍率**：万分比，`config.BasisPoints`，`10000` = 100%。例：`ratio: 12000` 是攻击 × 1.2；`crit: 500` 是 5%；`block.reduce: 8000` 是减伤 80%；`mass: 12000` 是 1.2 倍；`loot.chance: 3000` 是 30%；buff 的 `atk_pct: 4000` 是 +40%；回血区的 `heal: 500` 是每次 5%。
- **属性、生命、伤害、治疗、护盾**：整数。公式中间可以算出小数，最终结果向下取整（伤害最少 1）。概率判定是 `rand.Intn(10000) < 万分比`（`core.Roll`、`State.Lucky`）。
- **成长** `growth`：万分之一点 / 级，`15000` = 每级 +1.5 点。等级 L 的属性 = `attrs + ⌊growth × (L-1) / 10000⌋`（`config.Attrs.Grown`；实体的 `Born` 字段存 1 级属性）。
- **派生属性**：公式见 `internal/game/attr/attr.go` 顶部的注释（整数版）。
- **坐标、距离、半径**：配置里是整数像素。服务器内部的移动、碰撞、寻路仍用 `float64` 计算，下发时用 `core.FloorI32` 向下取整。速度是像素 / 秒。

协议（`proto/btdemo.proto`）遵守同一套约定，没有 `float`。前端只在 `web/src/net/protocol.ts` 一处换算回秒和小数。**例外**：行为树的运行时和编辑器参数（`Seconds`、`time_between_ticks`）仍按秒，见 [bt 和 ai](ai-bt.md)。

## 文件与类型

| 文件 | Go 类型 | 内容 |
| --- | --- | --- |
| `scenes.yaml` | `Scenes` | 场景模板：每个场景的地图、出生点、刷怪点、回血区，分线规则（见 [场景与分线](scene.md)）；`kind: dungeon` 的副本还有房间玩法 `rooms`、关内祝福 `boons`（见 [关卡](level.md)）。每个场景有一份自己的 `Config`（`Scene.Cfg`）：和全局配置共用技能、模板、物品，地图、刷怪、回血区、出生点换成这个场景的 |
| `world.yaml` | `World` | `addr` 监听地址、`aoi.cell`、`tick_rate`、`sync_rate`、`hostile` 阵营敌对表、`player` 玩家模板（公共字段 + `classes` 职业列表）、`loot` 装备掉落、`pet` 宠物、`session` 断线保留、`hit` 命中分量和韧性 |
| `skills.yaml` | `map[string]*Skill` | 技能，key 是技能 id |
| `monsters.yaml` | `map[string]*Template` | 怪物 / NPC 模板（刷怪点在 `scenes.yaml` 里） |
| `items.yaml` | `[]*Item` | 装备，按文件里的顺序（`Config.Item(id)` 按 id 查），详见 [item](items.md) |
| `maps/*.tmj` | `Layout` | Tiled 地图：物件摆放、碰撞形状、传送门（JSON，不是 YAML；详见 [地图](map.md)） |

YAML 字段和 Go 字段的对应写在结构体标签里，例如：

```go
type Skill struct {
    Range    int         `yaml:"range"`
    Cooldown Millis      `yaml:"cooldown"` // 毫秒
    Ratio    BasisPoints `yaml:"ratio"`    // 万分比
    ...
}
```

`yaml.v3` 按标签把 YAML 解码进结构体。技能和模板的 id 来自 map 的 key，加载后由 `validate` 写回 `ID` 字段（标签是 `yaml:"-"`，表示不从 YAML 读）。

## Load 做了什么

```go
cfg, err := config.Load("config", game.TreeNames())
```

1. 读 YAML、`scenes.yaml` 和每个场景的地图。没有 `scenes.yaml` 时按旧的单场景方式：读 `map.tmj`（缺失时视为空地图）、`monsters.yaml` 的 `spawns`、`world.yaml` 的 `map`、`heal_zones` 和 `player.spawn`。有 `scenes.yaml` 时 `Config` 顶层的 `Layout`、`Spawns`、`World.HealZones`、`World.Player.Spawn`、`World.Map` 是默认场景的。
2. `validate` 补默认值并检查：
   - 地图尺寸、AOI 格子为正；`tick_rate` 默认 20（必须能整除 1000）、`sync_rate` 默认 10、`addr` 默认 `:8080`（只写端口时补冒号）；`session.keep` 默认 30000 毫秒。
   - 敌对表里引用的阵营都存在，且必须有 `player`。
   - 技能的 `kind` 是 target、aoe、self、dash、line、zone、rain 之一；`rain` 要有 `range`、`radius`、`distance`；`pierce: true` 只能用在 `line` 上；`damage` 是 physical、magic 或空；`zone` 技能要有 `zone` 且 `duration` 大于 0。
   - `heal_zones` 的阵营在敌对表里、不写 `duration`；回血区的 `radius`、`heal` 为正，`interval` 默认 1000 毫秒，`look` 默认 `rune`（见 [zone](zone.md)）；`checkpoint: true` 的是副本存档点。
   - 副本：房间和门引用的房间都在地图的 `rooms` 图层里，波次的怪物模板存在，有 `boon` 奖励就要有 `boons`，默认场景不能是副本（见 [关卡](level.md)）。
   - 技能的 `buff` 和 `debuff` 里，`look` 为空或者是 haste、holy、fire、frost 之一。
   - `player.classes` 至少一个职业：`id` 非空且不重复，`speed`、`radius` 为正，`model` 不写时默认用 `id`；每个职业的 `skills` 至少一个，第 2 个起的默认技能都在 `skill_pool` 里，`skills` 和 `skill_pool` 里的技能都存在。
   - 模板引用的技能都存在，且怪物不能用 `dash`、`line`、`rain`（行为树放技能不给方向）；模板的 `kind` 是 monster 或 npc；`tree` 是编译进程序的行为树（由调用方传入 `knownTrees`）；`faction` 在敌对表里。
   - 刷怪点引用的模板存在。
   - 每个职业的 `skins` 至少一个（第一个是默认），`id`、`name`、`color` 都有，`id` 不重复。
   - `items.yaml`：`id`、`name` 都有且 `id` 不重复；`slot` 是 weapon、armor、trinket 之一；`class` 为空或是已有职业；`rarity` 是 common、rare、epic 之一；`stats` 的名字在 `config.StatNames` 里（换算成 `Item.Bonus`）；`effect` 的 `kind` 已知且参数齐（概率在 (0, 10000]，比例、时长为正，chill 的 `speed` 在 -10000 和 0 之间；chill 的减速 Buff 在这里生成）。
   - `player.bag` 默认 24；`player.starter` 和职业的 `starter` 里的物品存在，职业的还要本职业能用。
   - `loot`：`chance`、`bosses` 的概率、`class_bias` 在 0..10000，`bosses` 的模板存在，`rarity` 的 key 是已知稀有度、权重不为负且有物品时至少一个为正。
   - 每个场景（`validateScenes`）：地图物件都在地图范围内、刷怪点的模板存在、回血区合法；传送门在地图内、`to` 是别的已有场景；分线规则补默认值（soft 40、hard 60、min 1、idle_close 120000 毫秒），`hard` 不小于 `soft`。
3. `loadLayout` 检查 `map.tmj`：每个 `shape.*` 属性格式正确、数值合法；`props` 里每个物件的种类都有 `shape.*`（`none` 表示不挡路的装饰）；缩放为正；物件是点或两点折线，墙必须是折线；不允许 NaN、无穷大。

还有一项检查放在 ai 包里，因为它需要行为树：模板的技能数量要覆盖树里 `cast_skill` 用到的所有槽位。

## 职业、技能和技能池

`world.yaml` 的 `player` 保留公共字段（`name_prefix`、`spawn`、`level`、`respawn`、`block`），职业相关的都在 `player.classes` 里。它是有序列表，**第一个是新玩家的默认职业**（`Player.DefaultClass()`，`Player.Class(id)` 按 id 查）。每个职业（`config.Class`）有：`id`、`name`、`desc`、`model`、`color`、`can_block`（能不能右键格挡）、`attrs`、`growth`（每级增长）、`speed`、`radius`、`skills`、`skill_pool`、`skins`（外观，第一个是默认，`Class.DefaultSkin()`、`Class.Skin(id)`）、`starter`（第一次当这个职业时放进背包的物品）。`player` 的公共字段还有 `bag`（背包格数）和 `starter`（每个新玩家都有的物品）。现在有 `knight`（骑士，能格挡）和 `ranger`（游侠，不能格挡）。

每个职业有两组技能：

- `skills`：默认技能。第 1 个固定是普攻（J 键 / 左键），不用挑；其余是没选技能时的默认选择，放在第 2 格起。
- `skill_pool`：玩家进游戏和死亡时可以挑的技能。

挑的数量由 `Class.Pick()` 决定：`len(skills) - 1`，也就是默认技能数减一（第 1 格普攻不算）。例如默认 6 个、挑 5 个。挑出来的依次放到第 2 格起，覆盖默认选择。默认的技能（第 2 个起）必须同时在 `skill_pool` 里，否则启动失败。

## skills.yaml 的字段

- `kind`：`target` 单体、`aoe` 范围、`self` 自身、`dash` 位移（用 `distance`）、`line` 直线投掷（用 `range`；`pierce: true` 时穿透，命中直线上所有敌人）、`rain` 箭雨（用 `range`、`radius`、`distance`）、`zone` 在脚下放回血区（用 `zone`，见 [zone](zone.md)）、`charge` 冲锋（用 `range`、`distance`、`windup`，撞到障碍物自己晕 `self_stun` 毫秒）、`rally` 给周围同伴加 Buff（用 `radius`、`buff`）。
- `desc`：选技能面板上的一句话说明。
- `debuff`：命中时加在目标身上的效果，格式同 `buff`。没被免疫、也没被打死才会加上。
- `weight`：命中分量 `light` / `medium` / `heavy`（默认 light），效果在 `world.yaml` 的 `hit.weights`。`knock`、`stun`、`poise_dmg` 可以单独覆盖这一档的击退距离、硬直毫秒数和打掉的韧性。
- `windup`：前摇毫秒数，只能给 `target`、`aoe` 和 `charge` 技能（启动时检查，`charge` 必须有）。出招后过这么久才结算，期间可以被打断、可以被躲开。
- `buff` 的新字段：`invulnerable`（期间不受任何伤害）、`bonus_magic`（物理技能每次命中额外造成法术伤害）、`look`（客户端外观）。`look` 只能是 `haste`、`holy`、`fire`、`frost`，对应 `config.Looks` 里的位。

这些字段的作用见 [attr 和 combat](attr-combat.md)。

## 命中、韧性和格挡（world.yaml 的 hit 和 player.block）

- `hit.weights`：每档的 `knock`（击退像素）、`stun`（硬直毫秒）、`poise`（打掉的韧性）、`guard`（被挡住时扣的架势）。少写的档、或者老配置没写 `guard`，用代码里的默认值（`internal/config/hit.go`）。
- `hit.knock_time`（击退用时，默认 180 毫秒）、`hit.wall_stun`（撞墙额外硬直，毫秒）、`hit.poise_reset`（多少毫秒没挨打韧性回满，默认 2000）、`hit.reach`（前摇结束时目标比射程多跑出多远仍算命中）。
- 韧性和重量：monsters.yaml 模板、pets.yaml 和 `player` 的 `poise`、`mass`（重量是万分比，默认 10000 = 1 倍，击退距离 × 10000 ÷ mass）。
- `player.block`：格挡 2.0 的参数（减伤、移速、正面角度、架势上限和回复、破防、完美格挡窗口等），不写或写 0 的用默认值（`internal/config/block.go`）。含义见 [attr 和 combat](attr-combat.md) 的格挡。

## 默认值和约定

- 模板不写 `model` 时默认用模板 id 作为前端模型名；职业默认用职业 id。
- 模板和玩家等级不写时为 1。
- 物件缩放 `s` 不写时为 1。

## 改配置时

- 只改数值：改 YAML 后重启服务即可，不用重新编译（配置不打包进二进制）。
- 加新字段：结构体里加字段和 `yaml` 标签 → 在 `validate` 里补默认值或检查 → 在用到它的系统里读。
- `Config.Hostile(a, b)` 是唯一判断阵营敌对的地方，各系统通过 `core.State.Hostile` 调用它。
