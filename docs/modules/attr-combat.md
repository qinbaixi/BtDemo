# attr 和 combat：属性与战斗

代码：`internal/game/attr/attr.go`，`internal/game/combat/combat.go`

## attr：属性

### 两层属性

- **基础属性** `Base`：力量 Str、敏捷 Agi、智力 Int、体质 Vit。来自配置，升级时按 `Growth` 增长。
- **派生属性** `Attr`：由基础属性算出来，再乘上 Buff 加成。

```text
MaxHP   = 80 + Vit×12 + Str×2
Atk     = 8 + Str×2 + Agi×0.5          物理攻击
MAtk    = 8 + Int×2.5                  法术攻击
Def     = 4 + Vit×1 + Str×0.5          物理防御
MDef    = 4 + Int×1 + Vit×0.5          法术防御
Crit    = min(0.6, 0.05 + Agi×0.004)   暴击率
CritDmg = 1.5 + Agi×0.005              暴击伤害倍数
Speed   = 配置的移速

Buff：Atk、MAtk ×(1+ΣAtkPct)，Def、MDef ×(1+ΣDefPct)，Speed ×(1+ΣSpeedPct)
```

### 关键函数

| 函数 | 作用 |
| --- | --- |
| `Compute(base, speed, buffs)` | 纯函数：输入基础属性、移速和 Buff，返回派生属性。方便单独测试 |
| `Recalc(e)` | 重算 `e.Attr`。最大生命变化时**保持血量百分比**，而不是保持血量数值 |
| `Init(e)` | 重算并回满血（出生、复活、升级） |
| `LevelUp(e)` | 等级 +1，基础属性加上成长值 |
| `System.GainExp(e, n)` | 加经验，够了就连续升级，每升一级发 `LEVEL_UP` 事件 |

升级所需经验：`100 × 当前等级`。

属性只在会变化的时候重算（Buff 增减、升级、复活），不是每帧算。

## combat：技能与伤害

### 技能配置（skills.yaml）

```yaml
slash:    { kind: target, range: 70,  cooldown: 0.7, damage: physical, ratio: 1.0, base: 4 }
whirlwind:{ kind: aoe,    radius: 110, cooldown: 5,  damage: physical, ratio: 1.2, base: 6 }
heal:     { kind: self,   cooldown: 8, heal: 0.35 }
warcry:   { kind: self,   cooldown: 15, buff: { duration: 6, atk_pct: 0.4, speed_pct: 0.25 } }
```

- `target`：单体，需要一个敌对的目标，在射程内（边缘距离）。
- `aoe`：以自己为中心，半径内所有敌对单位。
- `self`：作用于自己，治疗（`heal` = 最大生命的百分比）和 / 或 Buff。

玩家和怪物用的是同一套技能和同一个 `Cast` 函数，区别只是谁来调用：玩家由 `session.Input` 调，怪物由行为树的 `cast_skill` 节点调。

### Cast 的流程

```text
Cast(e, skill, targetID)
  ├─ 死了 → ErrDead；冷却中 → ErrCooldown
  ├─ target：目标无效或不敌对 → ErrNoTarget；太远 → ErrTooFar
  │          发 CAST 事件 → CalcDamage → applyDamage
  ├─ aoe：   发 CAST 事件（带半径）→ 先收集半径内的敌人，再逐个结算
  ├─ self：  发 CAST 事件 → 治疗（HEAL 事件）/ 加 Buff（BUFF 事件，重放刷新不叠加）
  └─ 成功后设置冷却：Cooldowns[技能] = 现在 + cooldown
```

返回的 error 是给玩家看的中文提示，session 会把它作为 `Toast` 发给客户端；行为树里失败就让节点返回 Failure。

AOE 先收集目标再结算，是因为结算可能杀死目标，而遍历 AOI 格子时不能修改它。

### 伤害公式

```text
原始伤害 = 攻击 × ratio + base               （法术技能用 MAtk 对 MDef）
减伤后   = 原始伤害 × (1 − 防御 / (防御 + 100))
暴击     = 随机 < 暴击率 时 × CritDmg
浮动     = × 0.95 ~ 1.05
最终     = max(1, 四舍五入)
```

防御减免是 `防御/(防御+100)`：100 防御减伤 50%，300 防御减伤 75%，永远到不了 100%，堆防御收益递减。

### 死亡

`applyDamage` 扣血、记录最后攻击者和受击时间（行为树的 `was_attacked`、`update_target` 会用到），血量归零调用 `Kill`：

- 标记死亡，清空目标和 Buff，发 `DIE` 事件。
- 安排复活时间：怪物用模板的 `respawn`，玩家用 `world.yaml` 的 `player.respawn`。真正的复活由 spawn 系统在时间到时执行。
- 怪物被**玩家**击杀时，给玩家加模板配置的经验。
- 尸体留在 AOI 格子里，周围的人能看到倒地动画。

### 其他接口

- `Tick()`：每帧清掉过期的 Buff，有变化就重算属性。
- `NearestHostile(e, r)`：半径内最近的敌对单位（行为树找目标用）。距离相同时选 id 小的，保证结果稳定。
- `NearestMonster(e, r)`：玩家没选目标就放技能时，自动选最近的怪。
- 敌对关系来自 `world.yaml` 的 `hostile` 表，按阵营判断，`State.Hostile(a, b)`。

## 想改什么去哪

- 改公式：`attr.Compute`（顺便改它上方的注释和 README）、`combat.CalcDamage`。
- 加技能：在 `skills.yaml` 里加；如果是新的 `kind`，在 `Cast` 的 switch 里加分支，并在 `config.validate` 里允许这个 kind。
- 加 Buff 效果（例如减伤）：`config.Buff` 加字段 → `attr.Compute` 里累加 → 前端面板显示。
