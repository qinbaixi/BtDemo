# BtDemo

一个在浏览器里玩的小 Demo：Go 后端实现 AOI（九宫格）、技能、属性计算和伤害计算，怪物与 NPC 的决策由 [BtTree（owl-bt）](https://github.com/qinbaixi/BtTree) 导出的 Go 行为树驱动，每个怪物 / NPC 用哪棵树由 YAML 配置。

不使用数据库和缓存，所有状态都在内存里；每个 WebSocket 连接会创建一个新角色，断开即删除。

## 运行

```sh
go run ./cmd/server            # 打开 http://localhost:8080
go run ./cmd/server -addr :9000 -config ./config
```

操作：`WASD` / 方向键移动，鼠标点击选择目标，`1`~`5` 释放技能，`G` 切换 AOI 网格显示。可以开多个浏览器标签页，每个标签页是一个新玩家，互相在视野内可见。

## 目录

```text
cmd/server/          入口
bt/                  owl-bt 项目：owl-bt.json（游戏节点类型）+ trees/*.json（行为树），用 BtTree 编辑器打开
internal/ai/trees/   BtTree 导出的 Go 文件（DO NOT EDIT）与 go generate 生成的 registry.go
internal/bt/         行为树运行时：解释导出的 map[int]map[string]any
internal/game/       世界循环、实体、AOI、属性、技能 / 伤害、AI 节点实现
internal/config/     YAML 配置加载与校验
internal/server/     HTTP 与 WebSocket
config/              world.yaml（地图、AOI、阵营、玩家）、skills.yaml、monsters.yaml
web/static/          前端（原生 Canvas + JavaScript，由 go:embed 打进二进制）
tools/btregistry/    扫描导出文件生成 registry.go
```

## 行为树：从 BtTree 到游戏

1. 用 BtTree 打开 `bt/`（例如 `owlbt open bt/trees/monster_melee.json`，或在首页「Open folder…」选择 `bt`），编辑或新建树。可用的节点类型定义在 `bt/owl-bt.json`：
   - 组合：`Selector`、`Sequence`、`Parallel`、`RandomSelector`
   - 任务：`FindTarget`、`ClearTarget`、`ChaseTarget`、`CastSkill`（`Slot` 对应怪物模板 `skills` 的序号）、`Wander`、`ReturnHome`、`Flee`、`Wait`、`Say`
   - 装饰器：`HasTarget`、`TargetInRange`、`HpBelow`、`FarFromHome`、`WasAttacked`、`Cooldown`、`ForceSuccess`
   - 服务：`UpdateTarget`
2. 导出 Go：项目的导出设置已指向 `../internal/ai/trees`、包名 `trees`。在编辑器里用「Export: Go」，或运行 `scripts/export-bt.sh`（需要 `owlbt` 命令；也可以 `OWLBT="node ../BtTree/packages/server/dist/cli.js" scripts/export-bt.sh`）。
3. `go generate ./internal/ai/trees` 重新生成 `registry.go`（脚本已包含这一步）。
4. 在 `config/monsters.yaml` 的模板里用 `tree: <树文件名>` 选择行为树。

启动时会校验：模板引用的树必须存在；树里用到的每个节点类型都必须在 `internal/game/ai.go` 中有实现，否则启动失败并指出节点。新增节点类型时，在 `owl-bt.json` 中声明、在 `ai.go` 中用 `reg.Task` / `reg.Condition` / `reg.Service` 注册同名（snake_case）处理函数即可。

### 运行时语义

- 每个 AI tick 从根节点开始执行。`Selector` 是响应式的：每次都按优先级从第一个子节点尝试，高优先级分支（如「脱战回家」「战斗」）可以打断正在执行的低优先级分支（如「闲逛」）。
- `Sequence` 和 `RandomSelector` 记住正在执行的子节点，下一个 tick 从那里继续。
- 节点从「不在运行」进入时才检查装饰器条件并清空节点内存；运行过程中只重新检查勾选了 `periodic` 的装饰器。装饰器的 `inverse_check_condition` 会把条件取反。
- `Cooldown` 装饰器在节点成功后开始冷却；`ForceSuccess` 让节点总是成功（即使条件装饰器挡住了它），适合「说一句话」这类可选步骤；服务按 `time_between_ticks` 周期执行，节点重新进入不会打乱周期。

## 属性与伤害

- 基础属性：力量、敏捷、智力、体质；玩家每升一级按 `world.yaml` 的 `growth` 成长。
- 派生属性：生命上限、攻击、法强、防御、法抗、暴击率、暴击伤害、移速（公式见 `internal/game/attr.go`），再叠加 Buff 的百分比加成。
- 伤害 = `(攻击 × 系数 + 固定值) × (1 − 防御 / (防御 + 100)) × 暴击 × 随机 0.95~1.05`；物理技能用攻击 / 防御，法术技能用法强 / 法抗。

## AOI

地图按 `aoi.cell` 切成格子，玩家只接收自己所在格子和周围 8 格内的实体：进入视野时收到 `enter`（静态信息），离开时收到 `leave`，视野内实体的状态和事件（伤害、技能、说话、死亡）随 10Hz 的 `sync` 下发。前端按 `G` 可以看到格子和当前视野范围。

## 测试

```sh
go vet ./...
go test ./...
```
