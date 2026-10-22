# item：装备、皮肤与掉落

代码：`internal/game/item/item.go`（背包、穿脱、皮肤、换职业、掉落），`internal/game/combat/effects.go`（装备特效），
`internal/game/attr/attr.go`（属性加成）；数据：`config/items.yaml`、`config/world.yaml`（`player.bag`、`player.starter`、职业的 `starter` 和 `skins`、`loot`）；
测试：`internal/game/items_test.go`、`internal/config/items_test.go`

## 数据

- 物品定义 `config.Item`（items.yaml，按文件顺序）：`id`、`name`、`slot`（weapon / armor / trinket）、`class`（空 = 通用）、`rarity`（common / rare / epic）、`desc`、`stats`、`effect`、`look`（武器外观）。
- 玩家拥有的物品 `core.OwnedItem`：`UID`（每个玩家自己从 1 开始编号）、`Cfg`、`Slot`（空 = 在背包里）。都在实体的 `Inventory` 组件里（`entity.Items`），按 UID 排好。
- 背包 `player.bag` 格（默认 24），**装备着的不占格子**（`BagCount` 只数 `Slot` 为空的）。
- 皮肤存在 `entity.Skin`（总是具体的 id，比如 `paladin`），职业的第一个皮肤是默认。

## 属性加成（attr）

`attr.Recalc` 会把所有装备着的物品的 `Bonus`（`config.StatBonus`，由 `stats` 在校验时换算）加进去：

1. `str`、`agi`、`int`、`vit` 先加到基础属性上，再套派生公式；
2. `max_hp`、`atk`、`matk`、`def`、`mdef`、`crit`、`crit_dmg`、`speed` 直接加在公式结果上（暴击率 0.6 的上限只管公式那部分）；
3. `cdr` 求和后限制在 `config.MaxCDR`（0.4）以内，存进 `Attr.CDR`；
4. 最后 Buff 照常缩放（装备加的那部分也一起缩放）。

`combat.CastAimed` 设冷却时乘 `(1 - Attr.CDR)`。穿脱装备后调 `Recalc`，血量按比例保留。

## 穿脱和皮肤（item.System）

| 操作 | 规则 | 拒绝时的 Toast |
| --- | --- | --- |
| `Equip(uid)` | 物品在背包里，`class` 为空或等于当前职业；原来槽位里的回到背包。任何时候都行（包括死亡期间） | 「这件装备不在背包里」「当前职业用不了这件装备」 |
| `Unequip(slot)` | 槽位里有东西，背包没满 | 「没有这个装备槽位」「这个槽位没有装备」「背包满了」 |
| `SetSkin(skin)` | 当前职业的皮肤，空 = 默认；任何时候都行 | 「当前职业没有这个皮肤」 |

换职业（`Loadout` 带 `class`）时：`spawn.ApplyClass` 把皮肤重置为新职业的默认，然后 `item.ClassChanged`：

- 新职业用不了的已装备物品卸回背包；背包满了就丢掉，提示「背包满了，丢掉了「物品名」」；
- 第一次当这个职业时，把职业的 `starter`（本职业的普通武器）放进背包。每个职业只发一次（`entity.StartersGiven`）。

新玩家进游戏时（`GiveStarter`）背包里有 `player.starter`（皮革护甲、生命护符）和默认职业的 `starter`（骑士的新兵长剑），都不装备。

## 怎么通知客户端

item 和 combat 不直接发消息，只在实体上做标记，由 session 的 `publishGear` 统一发：

- `entity.InventoryDirty` → 发一份完整的 `Inventory`（所有物品 + `capacity`）；
- `entity.LookDirty`（皮肤或武器外观变了）→ 把实体从所有会话的可见集合里删掉，下次 `Flush` 重发 `Enter`（带 `skin`、`gear`），和换职业一样；
- `entity.Notices` → 每条发一个 `Toast`。

`publishGear` 在每条客户端消息处理完之后、以及每次 `Flush` 开头调用。所以 Equip / Unequip / SetSkin / Loadout 马上就有回应；战斗里的掉落最晚随下一次同步发出。

`EntityInfo.gear` 是装备着的武器的 `look`（没有武器或 `look` 为空时为空）。

## 装备特效（combat/effects.go）

技能每次命中（`applyDamage`，没被无敌免掉）结算完之后，`afterHit` 依次触发：

| 谁的 | kind | 条件和效果 | 事件 |
| --- | --- | --- | --- |
| 攻击者 | `lifesteal` | 实际扣血 > 0：回复 扣血 × pct | `HEAL` dst=自己 proc=lifesteal |
| 攻击者 | `ignite` | 目标活着，chance：追加 攻击 × ratio 的魔法伤害（按目标法防减免） | `DAMAGE` proc=ignite |
| 攻击者 | `chill` | 目标活着，chance：挂「冰冻」减速（和冰霜箭同名，互相刷新），外观 frost | `BUFF` proc=chill |
| 攻击者 | `multishot` | 技能是 1 号位普攻，chance：对射程内离自己最近的另一个敌人再射一箭（没有就射同一个，它死了就不射） | `CAST` fx=arrow proc=multishot，然后 `DAMAGE` proc=multishot |
| 受击者 | `block_heal` | 活着、这次有格挡掉的伤害：回复 最大生命 × pct | `HEAL` proc=block_heal |
| 受击者 | `thorns` | 活着、实际扣血 > 0、攻击者活着且边缘距离 ≤ 120：反弹 扣血 × pct（物理，按攻击者防御减免） | `DAMAGE` src=自己 dst=攻击者 proc=thorns |

另外两个不在命中时触发：

- `ambush`：放完位移技能（dash）后 `AmbushUntil = 现在 + dur`；在那之前的下一次 `CalcDamage` 必定暴击（`DAMAGE crit=true`），用掉就清零。
- `regen`：`combat.Tick` 每帧给活着的实体回复 最大生命 × pct × 帧长，不发事件。

**特效不连锁**：特效自己造成的伤害走 `damage`，不再调 `afterHit`，所以反伤不会再被反伤，追加的伤害也不吸血、不再触发别的特效。

有概率的特效和掉落都用 `State.Luck` 掷骰子（`State.Lucky(chance)`），它和战斗用的 `State.Rand` 分开：加了装备不会打乱原来的随机序列。测试把 `State.Luck` 换成固定的来源，就能强制触发或不触发（见 `items_test.go` 的 `forceLuck`）。

## 掉落（item.Loot）

怪物被玩家打死（`combat.Kill` 里，击杀者是打出致命一击的玩家，反伤打死的也算）时：

1. 按 `loot.bosses[模板 id]`（没有就用 `loot.chance`）掷是否掉落；
2. `class_bias` 的概率只从击杀者职业能用的物品（本职业或通用）里抽，否则从所有物品里抽；
3. 按 `loot.rarity` 权重抽稀有度（只算候选里有的稀有度），再在这个稀有度里等概率抽一件；
4. 放进击杀者的背包，发 `LOOT` 事件（位置是怪物，`src` = 怪物，`dst` = 玩家，`item` = 物品 id，AOI 里的人都看得到）；背包满了只提示「背包满了」，不给，也不发 `LOOT`。

## 想改什么去哪

- 加物品：items.yaml 加一条；用新的武器外观要让前端加画法。
- 加新特效：`config.Effect*` 常量 → `checkEffect` 检查参数 → `combat/effects.go` 里挂钩 → 前端按 `proc` 飘字。
- 加新属性：`config.StatNames` 和 `StatBonus`（含 `statField`、`Add`）→ `attr.ComputeWithGear`。
