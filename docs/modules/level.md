# 关卡（副本）：房间、门、波次、存档点

代码：`internal/game/level`（房间进度）、`internal/config/level.go`（配置和地图图层）、`internal/game/manager.go`（副本开实例）、
`internal/game/nav/map.go`（门的动态碰撞 `SetSolid`）。前端：`web/src/ui/level.ts`（横幅、进度）、`web/src/render/gates.ts`（木桩门、门上奖励图标）。
配置：`config/scenes.yaml` 里 `kind: dungeon` 的场景，地图 `config/maps/wolf_trail.tmj`。

设计稿见项目文件 `btdemo/levels/levels-design.html`（两关的完整方案）。第 0 期做了关卡框架，第 1 期做完了第一关「黑松林道」（正式布局、狼群、头狼、灰鬃狼王、秘密房、猎人）。

## 第一关「黑松林道」的流程

从村子北边狼林的传送门进来，出生在林口营地（篝火泉水是第一个存档点），一路往北：

| 房间 | 名字 | 遭遇 | 教什么 / 新写法 |
| --- | --- | --- | --- |
| r0 | 林口营地 | 安全，篝火存档点 | |
| r1 | 落叶小径 | 史莱姆 3 + 4 | 热身。房间西北角有一丛荆棘挡着小门 |
| secret | 古树洞 | 安全，奖励一件装备 | 秘密房：门是一丛荆棘（`breakable`），砍掉才开 |
| r2 | 狼迹空地 | 灰狼 2 + 3，清完回满血 | 狼群包抄（`flank`）：几只狼分散到四面再扑 |
| r3a / r3b | 倒木隘口 / 蘑菇洼地 | 岔路二选一：祝福 / 装备 | r3a 窄道里狼从两头同时进来（波次指定刷怪点）；r3b 第一次见头狼，同伴够多时嚎叫加攻加速（`allies_near` + `rally`） |
| r4 | 猎人小屋 | 猎人老陈被狼围住，清完回满血 | 友方 NPC（`allies`），第二个存档点；清完打开回林口的捷径 |
| r5 | 狼穴前 | 三波，最后一波两只头狼 | 首领前的考试 |
| r6 | 灰鬃狼王 | 首领 | 三阶段（`set_phase`）、扑杀撞石头会晕（`charge` + `self_stun`）、叫狼（`summon`）、连扑 |
| r7 | 狼穴深处 | 安全 | 去第二关（墓园）的传送门 |

首领房四角各有一块大石头：站在石头后面，狼王的扑杀会撞上去晕 2 秒。

地图 `config/maps/wolf_trail.tmj` 是脚本生成的（房间、通道矩形 → 四周的墙、外面一圈树、房间里的装饰），以后在 Tiled 里直接改。

## 玩法（参考 Hades 的房间制）

- **副本是自己一个人的**：从村子北边狼林的传送门进去，服务端单独开一份场景，不分线（副本里不能换线），人走光 5 秒后关掉。
- **进房锁门**：走进房间（离房间边 48 像素以上，已经走过门了），通往这个房间的门关上，怪一波一波刷出来，上一波死光 1.5 秒后刷下一波。刷出来的怪直接盯上离得最近的玩家，**不复活**，尸体留一会儿就移除。
- **清完开门**：最后一波死光，房间清完，后面的门打开，房间里的玩家拿到奖励。
- **岔路**：清完一个房间，后面可能有两扇门，门上浮着奖励图标（绿色十字回血、金色宝剑装备、橙色火苗祝福）。走进其中一边，另一边的门永远关上（房间的 `excludes`）。
- **安全屋**：没配波次的房间，走进去就算清完（比如猎人小屋，清完会打开捷径的门）。
- **存档点**：带 `checkpoint: true` 的回血区（泉水）。走进去以后（提示“已记录存档点”），死了在那里复活。离开场景就作废。
- **卡住的怪**：一波怪 20 秒没有倒下一只，离玩家 240 像素以外的活怪被挪到玩家附近（防止怪卡在走不到的角落，门关着房间永远清不完）。
- **团灭**：打着的房间里 1.5 秒没有活着的玩家（都倒了），房间重置：怪移走，门打开，可以从存档点回来再打。
- **关内祝福**：房间奖励 `boon` 从场景的 `boons` 里随机抽一个 Buff。祝福死了不掉（`Buff.Keep`），离开副本时和其他 Buff 一起清掉。

## 配置

### 地图（Tiled）

副本地图比普通地图多两个对象图层：

| 图层 | 对象 | 含义 |
| --- | --- | --- |
| `rooms` | 矩形 | 一个房间。名字是房间 id（`scenes.yaml` 的 `rooms` 用它），属性 `title` 是走进去时打出来的名字 |
| `gates` | 矩形 | 一扇门，关着时整个矩形挡路。属性 `after`：这个房间清完之后才开（不写就一开始开着）；`to`：门通往的房间，那个房间打起来时门关上，被岔路排除后永远关着，门上画那个房间的奖励；`breakable`：门里放一个这个模板的东西（比如 `bramble` 荆棘丛），它活着门就关着，砍掉才开 |

门放在房间边上的通道里，厚 16 像素左右。房间之间只能经过门走，所以房间和通道四周要用 `wall` 围起来。

### scenes.yaml

```yaml
  - id: wolf_trail
    name: 黑松林道
    kind: dungeon                 # 副本：每人一份，不分线
    map: wolf_trail.tmj
    spawn: { x: 800, y: 3290, spread: 40 }
    heal_zones:
      - { name: 林口篝火, x: 860, y: 3300, radius: 90, heal: 800, faction: player, look: spring, checkpoint: true }
    rooms:
      - id: r1                    # 地图 rooms 图层里的房间名
        waves:                    # 一波一波，每波可以有几种怪
          - [{ template: slime, count: 3 }]
          - [{ template: slime, count: 4 }]
      - id: r3a
        reward: boon              # heal 回满血 | gear 一件装备 | boon 关内祝福
        excludes: [r3b]           # 走进来以后，r3b 再也去不了
        waves:                    # 写了 x、y 的从那个点刷（spread 是散开多远），不写的在房间里离玩家远的地方刷
          - [{ template: pack_wolf, count: 2, x: 1010, y: 1900, spread: 30 }, { template: pack_wolf, count: 2, x: 1010, y: 2320, spread: 30 }]
      - id: r4
        allies:                   # 第一次有人走进来时刷出的友方 NPC，只刷一次，房间重置也不移走
          - { template: hunter, count: 1, x: 1080, y: 1540, spread: 10 }
        waves: [...]
      - id: secret                # 没有波次：安全屋，走进去就清完（有奖励照样给）
        reward: gear
    boons:                        # 写法同 skills.yaml 的 buff；duration 写长一点（祝福在副本里一直有效）
      - { name: 狼血, duration: 3600000, atk_pct: 2500, look: fire }
```

启动时会检查：房间和门引用的房间都在地图里、波次和友方 NPC 的模板存在、门的 `breakable` 模板存在、有 `boon` 奖励就必须有 `boons`、默认场景不能是副本、普通场景不能有房间和门。

## 服务端怎么做的

- **开实例**：`Manager.pick` 遇到副本模板时总是 `openLine` 开新的一份（副本的分线规则固定为 `min 0`，空了 5 秒就关）。`SwitchLine` 在副本里直接拒绝。
- **门的碰撞**：场景建寻路图时，地图物件的障碍物后面接上每扇门的矩形（`level.GateShapes`）。`nav.Map.SetSolid(下标, 挡不挡)` 开关门，开关时路径网格作废，下次寻路重建。关门时站在门里的东西会被碰撞推出去。
- **每个 tick**（`level.System.Tick`，在回血区之后、移动之前）：
  1. 存档点：活着的玩家站进 `checkpoint` 回血区，记下 `Entity.Checkpoint`，`spawn` 复活时用它；
  2. 房间：没人进过的房间有玩家走进来就开打（或者安全屋直接清完）；打着的房间检查团灭、这一波死没死光、要不要刷下一波；
  3. 门：按房间进度算每扇门开不开，变了就改寻路图。
- **怪物**：`Entity.Room` 记着是哪个房间刷的，`spawn.Tick` 不复活它们，到 `RespawnAt` 就从场景移除。首领叫来的狼（`Summon`）也记在首领的房间里，算进这一波。
- **可破坏的门**：建场景时在门的中心刷出 `breakable` 模板的实体（`Room` 记成 `gate:门 id`，不会复活），它死了门才算开。荆棘丛的阵营是 `wild`，玩家能打它，它谁也不打。
- **同步**：`core.Level` 存房间和门的状态，有变化 `Version` 加一，会话发现版本变了就整份发 `LevelState`（和回血区一样）。房间和门的位置在 `Welcome.scene` 里（`dungeon`、`rooms`、`gates`）。奖励和存档点的提示用 `Toast`。

## 协议

| 消息 | 字段 | 含义 |
| --- | --- | --- |
| `SceneInfo` | `dungeon`、`rooms`、`gates` | 是不是副本、房间（id、名字、矩形、几波、奖励）、门（id、矩形、通往哪个房间） |
| `ServerMsg.level` | `LevelState` | 整份进度：每个房间的 `phase`（`ROOM_IDLE` / `ROOM_FIGHT` / `ROOM_CLEAR` / `ROOM_SKIPPED`）和第几波，开着的门 |

## 前端

- `ui/level.ts`：收到 `LevelState` 和上一份比较：没人进过 → 打着，打出房间名和“第 1 / N 波”；波数变了打出下一波；打着 → 清完，打出“清除”和奖励，播清场慢放（`director.levelClear`）；安全屋打出名字和“安全”；打着 → 没人进过（团灭重置）打出“败退”。打着的时候场景牌子下面挂一条“房间名 · 第几波 · 还剩几只”。
- 首领：`ui/boss.ts` 在附近有首领（`BOSS_MODELS`）时在屏幕上方挂一条首领血条，刻线是阶段分界，掉的血先留白色残影。狼王扑杀的预警带、冲刺和撞晕的星星在 `render/fx.ts`（`chargeWarn`、`pounce_go`、`dizzy`）和 `game/events.ts`（`pounceTo`）。
- 模型：`render/models.ts` 的 `alpha_wolf`、`wolf_king`（同一套狼的画法加 `WOLF_STYLES`：颈毛、高鬃、伤疤、冰蓝眼睛和裂纹）、`hunter`（猎人老陈，猎叉、背弓）、`bramble`（荆棘丛）。
- `render/gates.ts`：每扇门是一排削尖的木桩，每根木桩一张小画布放进深度层（按桩脚 y 排序）。关门时木桩 0.38 秒升起、符文发红光，伴随一声闷响（`director.gateSlam`）；开门时沉进土里只剩桩头。门开着、通往的房间还没人去过且有奖励时，门上方浮一个奖励圆牌。

## 以后（设计稿里的第 2–3 期）

- 第二关的视线遮挡、骷髅兵和骨堆复活、机关和点灯、暗房照明、食人魔·血槌；
- 组队进副本（现在只做了单人，`Manager.pick` 留了口子：按队伍开实例即可）。
