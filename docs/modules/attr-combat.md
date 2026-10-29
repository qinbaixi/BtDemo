# attr 和 combat：属性与战斗

代码：`internal/game/attr/attr.go`，`internal/game/combat/combat.go`，`internal/game/combat/effects.go`（装备特效，见 [item](items.md)）

## attr：属性

### 两层属性

- **基础属性** `Base`：力量 Str、敏捷 Agi、智力 Int、体质 Vit。来自配置，升级时按 `Growth` 增长。
- **派生属性** `Attr`：由基础属性算出来，再乘上 Buff 加成。

```text
MaxHP   = 80 + Vit×12 + Str×2
Atk     = 8 + Str×2 + ⌊Agi/2⌋          物理攻击
MAtk    = 8 + ⌊Int×5/2⌋                  法术攻击
Def     = 4 + Vit + ⌊Str/2⌋          物理防御
MDef    = 4 + Int + ⌊Vit/2⌋          法术防御
Crit    = min(6000, 500 + Agi×40)   暴击率
CritDmg = 15000 + Agi×50              暴击伤害倍数
Speed   = 配置的移速

装备：str/agi/int/vit 先加到基础属性上再套上面的公式；max_hp、atk 等直接加在结果上；
      CDR = min(4000, Σcdr)，技能冷却 ×(10000 − CDR) / 10000
Buff：Atk、MAtk 按 (10000+ΣAtkPct) / 10000 缩放，Def、MDef 按 (10000+ΣDefPct) / 10000，Speed 按 (10000+ΣSpeedPct) / 10000（向下取整；装备加的部分也一起缩放）
```

整数版与 `attr.go` 顶部注释一致（全部向下取整）。暴击率、暴击伤害是万分比：`6000` = 60%，`15000` = 1.5 倍。

### 关键函数

| 函数 | 作用 |
| --- | --- |
| `Compute(base, speed, buffs)` | 纯函数：输入基础属性、移速和 Buff，返回派生属性（不算装备）。方便单独测试 |
| `ComputeWithGear(base, speed, buffs, gear)` | 同上，另外加上装备的属性加成 `config.StatBonus` |
| `GearBonus(entity)` | 实体身上所有装备着的物品的加成之和 |
| `Recalc(entity)` | 重算 `entity.Attr`（含装备）。最大生命变化时**保持血量百分比**，而不是保持血量数值 |
| `Init(entity)` | 重算并回满血（出生、复活、升级） |
| `LevelUp(entity)` | 等级 +1，基础属性加上成长值 |
| `System.GainExp(entity, n)` | 加经验，够了就连续升级，每升一级发 `LEVEL_UP` 事件 |

升级所需经验：`100 × 当前等级`。

属性只在会变化的时候重算（Buff 增减、升级、复活、穿脱装备），不是每帧算。

## combat：技能与伤害

### 技能配置（skills.yaml）

```yaml
# 时间是毫秒（700 = 0.7 秒），比例是万分比（10000 = 100%）
slash:    { kind: target, range: 70,  cooldown: 700, damage: physical, ratio: 10000, base: 4 }
whirlwind:{ kind: aoe,    radius: 110, cooldown: 5000, damage: physical, ratio: 12000, base: 6 }
heal:     { kind: self,   cooldown: 8000, heal: 3500 }
warcry:   { kind: self,   cooldown: 15000, buff: { duration: 6000, atk_pct: 4000, speed_pct: 2500 } }
```

- `target`：单体，需要一个敌对的目标，在射程内（边缘距离）。
- `aoe`：以自己为中心，半径内所有敌对单位。
- `self`：作用于自己，治疗（`heal` = 最大生命的万分比）和 / 或 Buff。
- `dash`：闪现，朝瞄准方向位移 `distance` 像素，撞墙就停在墙前，不伤害任何人。
- `line`：投掷物（飞斧），朝瞄准方向飞 `range` 像素，打中直线上第一个敌人，被墙挡住就停在墙前。伤害按 `damage`、`ratio`、`base` 算。带 `pierce: true`（穿云箭）时不因命中停下：直线上的每个敌人都挨一下，飞到射程尽头或墙前。
- `rain`：箭雨。落点是选中的目标（存活、敌对、边缘距离不超过 `range`）所在的位置；没有这样的目标，就是施法者沿瞄准方向 `distance` 处（夹在地图内）。对落点 `radius` 内（边缘距离）的所有敌人造成伤害。

- `zone`：在自己脚下放一块回血区（`zone` 字段），同一个人再放时旧的消失；回血由 zone 系统做，见 [zone](zone.md)。

`dash` 和 `line` 需要方向，`rain` 在没有目标时需要方向；玩家的方向从 `Cast` 消息的 `dx`、`dy` 来，没有方向就返回 `ErrNoAim`。怪物放技能不给方向，所以配置校验不让怪物用 `dash`、`line`、`rain`。

`debuff` 是命中时加在目标身上的 Buff（比如冰霜新星的减速），格式和 `buff` 一样，见下面的 Buff 字段。

Buff 的字段（`config.Buff`）：

- `shield_pct`：护盾，吸收最大生命 × `shield_pct` / 10000 的伤害。
- `invulnerable`：持续期间不受任何伤害（圣光庇护）。
- `bonus_magic`：武器附魔，物理技能每次命中额外造成 法强 × `bonus_magic` / 10000 的法术伤害（烈焰附魔）。
- `look`：客户端外观，只能是 `haste`、`holy`、`fire`、`frost` 之一，同步成 `EntityState.looks` 里的一位，画法见 [前端](frontend.md)。

玩家和怪物用的是同一套技能和同一个 `CastAimed` 函数，区别只是谁来调用：玩家由 `session.Input` 调，怪物由行为树的 `cast_skill` 节点调。`Cast(e, skill, targetID)` 就是没有方向的 `CastAimed`。

### Cast 的流程

```text
CastAimed(e, skill, targetID, aimX, aimY)
  ├─ 死了 → ErrDead；格挡中 → ErrBlocking；硬直或被击退中 → ErrStunned；前摇中 → ErrBusy；冷却中 → ErrCooldown
  ├─ target：目标无效或不敌对 → ErrNoTarget；太远 → ErrTooFar
  │          发 CAST 事件 → 有 windup：开始前摇（CAST 带 hit_at），到点再结算（见下面“命中的分量”）
  │                          没有：马上 strike → CalcDamage → applyDamage（可能挂上 debuff）
  ├─ aoe：   发 CAST 事件（带半径）→ 有 windup 同上；结算时先收集半径内的敌人，再逐个结算
  ├─ dash：  没有方向 → ErrNoAim；nav.Reach 沿方向走到最远（最多 distance，撞墙停住）；
  │          一步都走不了 → ErrNoRoom；移动到终点，发 CAST（x、y 是起点，tx、ty 是终点）；不伤害
  ├─ line：  没有方向 → ErrNoAim；从身体边缘出发，nav.Reach 算出飞行距离（最多 range + 自身半径，
  │          墙前就是最远）；hostilesOnLine 按先后顺序找出飞行线上的所有敌人；
  │          普通：只取第一个，CAST 终点是命中点；穿透（pierce）：CAST 终点是射程尽头或墙前，
  │          dst 是第一个命中的（可空）；CAST 之后按沿线顺序给每个命中的敌人 CalcDamage → applyDamage
  ├─ rain：  选定落点（目标位置，或瞄准方向 distance 处；都没有 → ErrNoAim）；
  │          发 CAST（fx rain，x、y 是落点，radius，dst 是目标或空），再按 id 顺序给落点 radius 内的敌人结算
  ├─ self：  发 CAST 事件 → 治疗（HEAL 事件）/ 加 Buff（BUFF 事件，重放刷新不叠加；
  │          Buff 有 shield_pct 时带一个护盾，能吸收 最大生命 × shield_pct 的伤害）
  └─ 成功后：Cooldowns[技能] = 现在 + cooldown × (10000 − CDR) / 10000（毫秒，向下取整）；CanPick = false（放过技能就不能再换技能了）
```

返回的 error 是给玩家看的中文提示，session 会把它作为 `Toast` 发给客户端；行为树里失败就让节点返回 Failure。

AOE 先收集目标再结算，是因为结算可能杀死目标，而遍历 AOI 格子时不能修改它。

### 命中的分量：前摇、韧性、击退、硬直（combat/impact.go）

每个技能有一个分量档位 `weight`（`light` / `medium` / `heavy`，skills.yaml，默认 light），每档的效果在 `world.yaml` 的 `hit.weights`：击退距离 `knock`、硬直毫秒数 `stun`、打掉的韧性 `poise`、被挡住时扣的架势 `guard`。技能也可以用自己的 `knock`、`stun`、`poise_dmg` 覆盖档位的值（`HitRules.Hit`）。DAMAGE 事件带上 `weight`，前端按它选顿帧、震屏和音效（`web/src/feel/profiles.ts`）。

- **前摇**（`windup`，只有 `target` 和 `aoe` 技能能有）：出招时发 CAST（带 `hit_at`，命中的服务端时间），实体身上记 `Impact.Windup`，过 `windup` 毫秒后由 `resolveWindups` 结算（每个 tick 先收集到点的再结算）。结算时目标可以比射程多跑出 `hit.reach`，再远就打空。前摇期间被打出硬直（或者举盾）会被打断（`CancelWindup`），发 `INTERRUPT` 事件，这一下不结算。前摇中不能再出招（`ErrBusy`），怪物的行为树暂停。现在所有怪物技能都有前摇，玩家只有旋风斩有一点。
- **韧性**（`poise`，monsters.yaml 的模板、pets.yaml、`world.yaml` 的 `player.poise`）：每次命中扣掉档位的 `poise`，扣空了才会被击退和硬直，然后重新算；`hit.poise_reset` 毫秒没挨打韧性回满。没扣空就是霸体，这一下不退不停（首领食人魔韧性 120，普通怪 0～10）。
- **击退**：距离 = 档位的 `knock` × 10000 ÷ 目标的重量 `mass`（万分比，10000 = 1 倍）。`push` 用 `nav.Reach` 沿“攻击者 → 目标”的方向算出能推到哪（被墙和物件挡住就停在跟前），实体身上记 `Impact.Knock`，由 move 在 `hit.knock_time` 毫秒内先快后慢地推过去（见 [nav 和 move](nav-move.md)）。没推满就是撞墙：事件带 `wall`，硬直再加 `hit.wall_stun`。DAMAGE 事件里 `kx`、`ky` 是落点，`knock_time` 是用时。
- **硬直**：`Impact.StunUntil` 之前不能移动、不能出招，行为树暂停，同时打断前摇。DAMAGE 事件带 `stun` 毫秒数。尸体只被打飞，不硬直。
- 被普通格挡挡住的命中只推开 30%，不硬直、不扣韧性；完美格挡和破防见下面的格挡。

### 伤害公式

```text
原始伤害 = 攻击 × ratio / 10000 + base               （法术技能用 MAtk 对 MDef）
减伤后   = 原始伤害 × (1 − 防御 / (防御 + 100))
附魔     = 物理技能才有：身上每个带 bonus_magic 的 Buff，各加 法强 × bonus_magic / 10000 × (1 − 目标法防/(目标法防+100))
暴击     = 随机 < 暴击率 时 × CritDmg / 10000 （附魔那份也一起乘）；ambush 特效生效时必定暴击
浮动     = × 0.95 ~ 1.05
最终     = max(1, 向下取整)
```

防御减免是 `防御/(防御+100)`：100 防御减伤 50%，300 防御减伤 75%，永远到不了 100%，堆防御收益递减。

附魔是武器着火时的效果（烈焰附魔）：物理技能每次命中，额外打一份法术伤害，按目标的法术防御减免。法术技能不受影响。

### 格挡和护盾

`applyDamage` 按顺序处理，伤害事件里分别记下来，前端据此飘“免疫”“格挡”“吸收 N”：

0. **无敌**：目标身上有 `invulnerable` 的 Buff（圣光庇护）时，整次伤害免掉，事件 `immune` 为真、`v` 为 0，后面的格挡、护盾、debuff 都不再处理。
1. **格挡**（格挡 2.0，代码在 `combat/guard.go`）：玩家按住右键时 `entity.Blocking` 为真。只挡盾正面 `player.block.arc`（默认 140°）以内来的攻击，选了敌对目标时盾朝着目标，否则朝举盾时面向的那一侧（`Block.face`）；背后挨打照常扣血。挡住时：
   - **完美格挡**（`PARRY`）：举盾后 `block.parry`（180 毫秒）内挡住近战技能，伤害全挡、不扣架势，攻击者被弹开 `parry_knock`、硬直 `parry_stun`（无视韧性，打断它的前摇）。远程（投射物、飞斧、箭雨，见 `Skill.Ranged`）只能普通格挡；盾放下不到 `parry_rearm` 毫秒再举起没有完美格挡窗口。
   - **普通格挡**（`BLOCK`）：伤害减少 `block.reduce`（默认 8000 = 80%），按命中档位扣架势（`hit.weights.*.guard`，架势上限 `block.guard`）。
   - **破防**（`GUARD_BREAK`）：架势扣空的那一下仍按普通格挡减伤，然后盾被打开放下、被推开 `break_knock`、硬直 `break_stun`；硬直中举不起盾。
   - 架势 `guard_delay` 毫秒没挡到东西后开始回：放下盾每秒回 `guard_regen`，举着盾每秒回 `guard_regen_held`。剩余架势（万分比）按 500（5%）取整同步到 `EntityState.guard`。
   挡掉的量记在 `Event.blocked`，结果记在 `Event.result`（完美格挡时事件里的击退和硬直说的是攻击者）。格挡时移速乘 `player.block.speed`（默认 5000 = 0.5 倍），不能放技能。
2. **护盾**：剩下的伤害先由护盾 Buff 的 `Absorb` 吸收，记在 `Event.absorbed`；护盾打完这个 Buff 就被移除（时间到也会移除）。

剩下的才扣生命（`Event.v`），可能是 0。

扣血、发事件、击杀都在 `damage` 里做；`applyDamage` 是技能命中的入口：先 `damage`，没被无敌免掉的话再 `afterHit` 触发双方的装备特效（吸血、点燃、冰冻、多重射击、格挡回血、反伤，见 [item](items.md)），最后挂 debuff。特效自己造成的伤害也走 `damage`（事件带 `proc`），但不再触发特效。

扣完血如果目标还活着，且技能配了 `debuff`，就把它加到目标身上（同名刷新，同 `addBuff`）。被无敌免掉、或者这一下把目标打死的，都不加。

### 死亡

`applyDamage` 扣血、记录最后攻击者和受击时间（行为树的 `was_attacked`、`update_target` 会用到），血量归零调用 `Kill`：

- 标记死亡，清空目标和 Buff，发 `DIE` 事件。
- 玩家的 `CanPick` 设为真，死亡期间可以重新挑技能（挑的规则见 [session 和 server](session-server.md)）；怪物不会。
- 安排复活时间：怪物用模板的 `respawn`，玩家用 `world.yaml` 的 `player.respawn`。真正的复活由 spawn 系统在时间到时执行。
- 怪物被**玩家**击杀时，给玩家加模板配置的经验，并由 `item.Loot` 按 `world.yaml` 的 `loot` 掉落装备（见 [item](items.md)）。
- 尸体留在 AOI 格子里，周围的人能看到倒地动画。

### 其他接口

- `Tick()`：每帧清掉过期的 Buff，有变化就重算属性；给带 regen 装备的实体回血。
- `NearestHostile(entity, r)`：半径内最近的敌对单位（行为树找目标用）。距离相同时选 id 小的，保证结果稳定。
- `NearestMonster(entity, r)`：玩家没选目标就放技能时，自动选最近的怪。
- 敌对关系来自 `world.yaml` 的 `hostile` 表，按阵营判断，`State.Hostile(a, b)`。

## 想改什么去哪

- 改公式：`attr.Compute`（顺便改它上方的注释和 README）、`combat.CalcDamage`。
- 加技能：在 `skills.yaml` 里加；如果是新的 `kind`，在 `CastAimed` 的 switch 里加分支，并在 `config.validate` 里允许这个 kind。
- 加 Buff 效果（例如减伤）：`config.Buff` 加字段 → `attr.Compute` 里累加 → 前端面板显示。
