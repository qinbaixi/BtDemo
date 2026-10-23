# spawn：出生与复活

代码：`internal/game/spawn/spawn.go`

## 职责

- 启动时按 `monsters.yaml` 的 `spawns` 刷出所有怪物和 NPC（`SpawnConfigured`）。
- 有玩家连接时创建玩家角色（`Player`），断开时移除（`Remove`）。
- 每帧检查死亡的实体，复活时间到了就复活（`Tick`）。

## 从模板创建怪物：Template

```go
func (sp *System) Template(t *config.Template, x, y float64) *core.Entity
```

1. `Ents.New()` 分配新 id。
2. 填 `Identity`（名字、阵营、模型……，模板指针存在 `Tmpl` 里，之后经验、复活时间都从模板读）。
3. `move.FreeSpot` 把出生点挪到最近的空地，并把它记为**家**（`HomeX/HomeY`）：游荡围绕它，脱战回到这里。
4. 设置等级、基础属性、移速、技能，`attr.Init` 算出派生属性并回满血。
5. `ai.Attach` 给它挂上模板指定的行为树。
6. 加入实体表和 AOI 格子。

刷怪点的 `count` 个实体在 `spread` 半径内随机散布（`State.Scatter`，用的是带种子的随机数）。

## 创建玩家：Player

和怪物类似，但公共部分来自 `world.yaml` 的 `player`（名字是 `name_prefix + id`，初始等级 `level`），职业部分来自默认职业（`player.classes` 的第一个），由 `ApplyClass` 套上。玩家没有行为树（`AI == nil`），由客户端输入驱动。

## 换职业：ApplyClass

```go
func (sys *System) ApplyClass(entity *core.Entity, class *config.Class)
```

把 `entity.Class` 设为职业 id，并换掉模型、颜色、皮肤（重置为职业默认）、半径、移速、成长和技能栏（默认技能）。装备的处理（卸下新职业用不了的）不在这里，见 [item](items.md)。基础属性从职业的初始值开始，按当前等级重放成长，所以等级保留、属性按新职业重算；`attr.Recalc` 让血量按比例保留。冷却清零，不能格挡的职业会取消格挡。位置不动，所以 AOI 格子不用改（半径只影响碰撞和边缘距离，每次判断时现读）。

`ApplyClass` 不管其他玩家怎么看到新模型，那是 session 的事（`Loadout` 换职业时给能看到它的玩家重发 `Enter`），见 [session-server](session-server.md)。

## 复活：respawn

`combat.Kill` 只负责标记死亡和设置 `RespawnAt`。`spawn.Tick` 每帧检查，时间到了就：

- 怪物回到家，玩家回到玩家出生点附近（随机散布）；
- 清空冷却、寻路状态、最后攻击者；
- `attr.Init` 回满血；
- `ai.Reset` 重新创建行为树实例（树的运行状态、冷却、服务计时全部重来）；
- `move.Place` 放到最近的空地；
- 发 `RESPAWN` 事件，前端播放复活特效。

## 为什么出生和复活单独一个系统

创建实体要同时碰 move（找空地）、attr（初始属性）、ai（挂树）、aoi（入格子），放在任何一个系统里都会让那个系统依赖一堆别的系统。单独成包后，“一个实体怎么来到这个世界”集中在一个文件里，其他系统都不需要知道。

## 想改什么去哪

- 加新怪：`monsters.yaml` 加模板和刷怪点；用新模型的话前端 `web/src/render/models.ts` 加画法。
- 想让怪物死后在别处复活、或不复活：改 `respawn` / `Tick`。
- 新增需要在复活时重置的字段：在 `respawn` 里加一行。
