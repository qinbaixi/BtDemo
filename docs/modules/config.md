# config：配置

代码：`internal/config/config.go`、`internal/config/layout.go`；数据：`config/*.yaml`

## 职责

启动时读入所有 YAML，补默认值，并**做完所有能提前做的检查**。原则是：配置有错就启动失败，并说清楚是哪个文件、哪一项、错在哪，而不是运行到一半才出现奇怪的行为。

## 文件与类型

| 文件 | Go 类型 | 内容 |
| --- | --- | --- |
| `world.yaml` | `World` | `addr` 监听地址、`map` 尺寸、`aoi.cell`、`tick_rate`、`sync_rate`、`hostile` 阵营敌对表、`player` 玩家模板 |
| `skills.yaml` | `map[string]*Skill` | 技能，key 是技能 id |
| `monsters.yaml` | `map[string]*Template` + `[]Spawn` | 怪物 / NPC 模板和刷怪点 |
| `map.tmj` | `Layout` | Tiled 地图：物件摆放和碰撞形状（JSON，不是 YAML；详见 [地图](map.md)） |

YAML 字段和 Go 字段的对应写在结构体标签里，例如：

```go
type Skill struct {
    Range    float64 `yaml:"range"`
    Cooldown float64 `yaml:"cooldown"`
    ...
}
```

`yaml.v3` 按标签把 YAML 解码进结构体。技能和模板的 id 来自 map 的 key，加载后由 `validate` 写回 `ID` 字段（标签是 `yaml:"-"`，表示不从 YAML 读）。

## Load 做了什么

```go
cfg, err := config.Load("config", game.TreeNames())
```

1. 读三个 YAML 和 `map.tmj`（`map.tmj` 缺失时视为空地图）。
2. `validate` 补默认值并检查：
   - 地图尺寸、AOI 格子为正；`tick_rate` 默认 20、`sync_rate` 默认 10、`addr` 默认 `:8080`（只写端口时补冒号）。
   - 敌对表里引用的阵营都存在，且必须有 `player`。
   - 技能的 `kind`、`damage` 是已知值。
   - 玩家和模板引用的技能都存在；模板的 `kind` 是 monster 或 npc；`tree` 是编译进程序的行为树（由调用方传入 `knownTrees`）；`faction` 在敌对表里。
   - 刷怪点引用的模板存在。
   - `map.tmj` 的尺寸和 `world.yaml` 的 `map` 一致，地图物件都在地图范围内。
3. `loadLayout` 检查 `map.tmj`：每个 `shape.*` 属性格式正确、数值合法；`props` 里每个物件的种类都有 `shape.*`（`none` 表示不挡路的装饰）；缩放为正；物件是点或两点折线，墙必须是折线；不允许 NaN、无穷大。

还有一项检查放在 ai 包里，因为它需要行为树：模板的技能数量要覆盖树里 `cast_skill` 用到的所有槽位。

## 默认值和约定

- 模板不写 `model` 时默认用模板 id 作为前端模型名；玩家默认 `knight`。
- 模板和玩家等级不写时为 1。
- 物件缩放 `s` 不写时为 1。

## 改配置时

- 只改数值：改 YAML 后重启服务即可，不用重新编译（配置不打包进二进制）。
- 加新字段：结构体里加字段和 `yaml` 标签 → 在 `validate` 里补默认值或检查 → 在用到它的系统里读。
- `Config.Hostile(a, b)` 是唯一判断阵营敌对的地方，各系统通过 `core.State.Hostile` 调用它。
