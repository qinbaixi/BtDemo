# BtDemo 实现计划

目标：一个可以在浏览器里玩的小 Demo，演示 AOI、技能、属性计算、伤害计算，以及由 BtTree（owl-bt）导出的 Go 行为树驱动的怪物 / NPC 决策。

## 技术栈

| 部分 | 选择 | 理由 |
| --- | --- | --- |
| 后端 | Go 1.22+，标准库 `net/http` | 与 BtTree 的 Go 导出直接对接 |
| 通信 | WebSocket（`github.com/gorilla/websocket`），JSON 消息 | 简单、浏览器原生支持，方便调试 |
| 配置 | YAML（`gopkg.in/yaml.v3`） | 按需求用简单 YAML 配置怪物 / NPC 的行为树、属性、技能、刷怪点 |
| 前端 | 原生 HTML5 Canvas + 原生 JavaScript（ES 模块），用 `go:embed` 打进服务端 | 无需 Node 构建，`go run` 一条命令即可启动；表现足够画角色、血条、技能特效、AOI 网格 |
| 行为树 | 在 `bt/` 下放一个 owl-bt 项目（`owl-bt.json` + `trees/*.json`），用 BtTree 编辑器打开编辑，导出 Go 到 `internal/ai/trees/` | 树的“数据”由 BtTree 生成，Demo 只写一个解释执行这些数据的运行时 |

不使用数据库和缓存，所有状态在内存中；每个 WebSocket 连接创建一个新角色，断开即删除。

## 目录结构

```text
cmd/server/            入口：加载配置、启动世界循环和 HTTP/WebSocket 服务
bt/                    owl-bt 项目（用 BtTree 打开），导出设置指向 ../internal/ai/trees
  owl-bt.json          游戏专用节点类型（FindTarget、ChaseTarget、CastSkill、Wander、ReturnHome、Flee、Say…）
  trees/*.json         monster_melee / monster_ranged / npc_guard / npc_villager 等行为树
internal/ai/trees/     BtTree 导出的 Go 文件（DO NOT EDIT）+ 自动生成的 registry.go（树名 → 节点表）
internal/bt/           行为树运行时：解释导出的 map[int]map[string]any，组合节点 / 装饰器 / 服务 / 黑板
internal/game/         世界循环、实体、AOI 九宫格、属性计算、技能、伤害、Buff、AI 节点实现
internal/config/       YAML 配置加载与校验
internal/server/       WebSocket 会话与消息协议
config/                monsters.yaml（模板、刷怪点、阵营）、skills.yaml（技能）、player.yaml（玩家初始属性）
tools/btregistry/      扫描导出的 Go 文件生成 registry.go（go generate）
web/                   index.html、main.js（Canvas 渲染、输入、网络）
```

## 模块设计

1. **行为树运行时（internal/bt）**
   - 读取导出条目的 `type`（composite / task / decorator / service）、`sub_type`、`children`、`decorators`、`services`、`properties`。
   - 组合节点：Selector、Sequence、Parallel（RequireOne/RequireAll）、RandomSelector。
   - 每次 AI tick 从根节点重新评估（响应式行为树），高优先级分支可打断低优先级分支；需要跨 tick 的状态（Wait、冷却）存放在每个 Agent 的节点内存中。
   - 装饰器：条件类（HasTarget、HpBelow、TargetInRange、FarFromHome）支持 `inverse_check_condition`；结果类（Cooldown、Invert）。
   - 服务：按 `time_between_ticks` 周期执行（如 UpdateTarget）。
   - 任务节点和条件通过注册表按 `sub_type` 绑定到游戏代码，未知类型在加载时报错。
2. **AOI（internal/game/aoi.go）**：网格（九宫格）算法，格子大小可配置；实体移动时更新格子，每个玩家维护可见集合，差量下发 enter / leave，只同步视野内实体。
3. **属性计算**：基础属性（力量、敏捷、智力、体质）+ 等级成长 → 派生属性（生命、攻击、防御、暴击率、暴击伤害、移速），再叠加 Buff 的固定值 / 百分比修正；属性变化时重算并推送。
4. **伤害计算**：`(攻击 × 技能系数 + 技能固定值) × 防御减免(防御 / (防御 + K)) × 暴击 × 浮动(0.95~1.05)`；支持治疗技能。
5. **技能系统**：skills.yaml 配置单体（近战 / 远程）、自身范围 AOE、自我治疗、增益 Buff；冷却、射程、范围；玩家与怪物共用同一套技能。
6. **怪物 / NPC 配置**：monsters.yaml 中每个模板指定 `tree`（使用哪棵导出的行为树）、阵营、属性、技能、仇恨范围、复活时间；`spawns` 指定刷怪点和数量。阵营表决定谁会攻击谁（怪物攻击玩家和守卫，守卫攻击怪物，村民中立并在被攻击时逃跑）。
7. **玩家**：连接即创建角色；WASD 移动（服务端权威），鼠标点选目标，数字键 1~4 释放技能；击杀获得经验并升级（展示属性重算）；死亡后复活。
8. **前端**：相机跟随主角，画地图网格和 AOI 格子，角色圆形 + 名字 + 血条 + 当前行为树动作名，技能特效线 / 圆圈、伤害飘字、NPC 气泡说话，右侧面板显示属性与技能冷却。

## 消息协议（JSON）

- 客户端 → 服务端：`move {dx, dy}`、`cast {skill, target}`、`target {id}`
- 服务端 → 客户端：`welcome`（自身 id、地图、技能列表）、`enter` / `leave`（AOI 进出）、`sync`（视野内实体位置、血量、动作，10Hz）、`event`（伤害、技能、死亡、说话）、`self`（自身属性）

## 验证

- `go vet ./...`、`go test ./...`：行为树运行时、AOI、属性、伤害的单元测试；导出的 Go 文件与 `bt/trees` 一致性检查。
- 用 BtTree 的 `owlbt export bt --format go` 实际重新导出，确认生成文件可编译、可被注册。
- 启动服务，用 Playwright（Chromium）打开页面：移动、攻击、怪物追击并攻击主角，截图确认。
- 验证通过后推送到远程分支 `claude/btdemo-aoi-skill-prototype-6krgu1`，暂不开 PR。
