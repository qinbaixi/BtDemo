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

和怪物类似，但模板来自 `world.yaml` 的 `player`：名字是 `name_prefix + id`，有成长值 `Growth`；如果配置的初始等级大于 1，就循环调用 `attr.LevelUp` 升上去。玩家没有行为树（`AI == nil`），由客户端输入驱动。

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
