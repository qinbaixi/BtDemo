# pet：宠物

代码：`internal/game/pet/pet.go`（召唤、收回、换宠物、复活、等级），`internal/game/ai/pet_nodes.go`（宠物行为树的节点），
`internal/game/combat/combat.go`（`ally` 技能、击杀记给主人），`internal/game/session/`（`SetPet`、`PetStatus`、`Welcome.pets`）；
数据：`config/pets.yaml`、`config/skills.yaml`（宠物技能）、`config/world.yaml` 的 `pet` 段、`bt/trees/pet_*.json`；
测试：`internal/game/pet_test.go`、`internal/config/pets_test.go`

每个玩家可以带一只宠物。宠物是普通实体（`kind = pet`），完全由行为树驱动：跟随主人、协助主人打怪、治疗主人。调试面板可以像看怪物一样看宠物的行为树（宠物和怪物一样有 `ServerMsg.ai` 追踪）。

## 数据

- 宠物模板 `config.Pet`（`pets.yaml`，顺序就是面板顺序，**第一个是进游戏默认召唤的**）：`id`、`name`、`model`、`color`、`desc`，以及和怪物模板一样的 `tree`、`skills`、`attrs`、`speed`、`radius`，另外有 `growth`（每比 1 级高一级增加的属性，万分之一点：12000 = 1.2 点）。
- 随附 3 种宠物，所有职业都能用：

| id | 名字 | 定位 | 行为树 | 技能（槽 1, 2） |
| --- | --- | --- | --- | --- |
| `wolf_pup` | 小狼 | 近战，咬主人的目标 | `pet_melee` | `pet_bite`、`pet_howl`（自身加速加攻 buff） |
| `ember` | 火灵 | 远程法术，保持距离 | `pet_caster` | `pet_firebolt`、`pet_flare`（身边小范围） |
| `sprout` | 林精 | 治疗，主人血少时给主人回血 | `pet_healer` | `pet_thorn`（弱攻击）、`pet_mend`（`ally` 回血） |

- `world.yaml` 的 `pet` 段（`config.PetRules`，缺省或 ≤ 0 时用默认值）：`respawn: 10000`（宠物死后多少毫秒复活）、`swap_cooldown: 5000`（换宠物的冷却，毫秒）、`teleport: 600`（离主人超过多少像素直接传送）。
- 宠物实体：`Kind = core.KindPet`，`Owner` = 主人实体 id，`PetCfg` = 模板，阵营 = 主人的阵营（`player`）。玩家实体上的 `core.Companion` 组件记录：`PetID`（选的宠物，空 = 不带）、`PetEntity`（场上的宠物实体 id，0 = 现在没有）、`PetSwapAt`（这个时间之前不能换）、`PetDeadSeen`、`PetDirty`（要给玩家发 `PetStatus`）。

启动时校验：宠物的树必须存在，技能必须存在且不是 `dash` / `line` / `rain`（行为树放技能时不给方向），树里 `CastSkill` / `CastOnOwner` 的槽位不能超过宠物的技能数。

## 属性和等级

宠物等级 = 主人等级；基础属性 = 模板 `attrs` + ⌊`growth` × (等级 - 1) / 10000⌋（`config.Attrs.Grown`），再走一遍和玩家、怪物一样的属性公式（`attr.Recalc`）。`pet.Tick` 每帧比较宠物和主人的等级，主人升级后宠物跟着刷新（血量按比例保留）；复活时也按主人当前等级重算。宠物自己不拿经验。

## 阵营和战斗

- 宠物阵营是 `player`：怪物会打宠物（`monster` 敌对 `player`），玩家和守卫不会（`player` 只敌对 `monster`，`guard` 也只敌对 `monster`）。所以玩家的技能（单体、范围、直线、箭雨）都伤害不到宠物，也不能把宠物当目标；`NearestMonster`（自动选目标）只选怪物。
- **击杀记给主人**：`combat.Kill(entity, killer)` 发现 `killer` 是宠物，就把 `killer` 换成它的主人，所以经验和装备掉落（`LOOT` 事件的 `dst`）都归主人。
- 宠物死亡时 `Kill` 按 `pet.respawn` 设 `RespawnAt`（`spawn.Tick` 不复活宠物，由 `pet.Tick` 复活）。
- `ally` 技能（`pet_mend`）：`kind: ally` 的技能对行为树指定的友方目标回血，回复量 = ⌊目标最大生命 × `heal` / 10000⌋；目标必须存活、与施法者不敌对、边缘距离在 `range` 内，否则返回 `ErrNoTarget` / `ErrTooFar`。
- `core.Combat.LastDealtAt`：实体最近一次出手打人的时间，`damage` 里设置，`OwnerInCombat` 用它判断主人是否在战斗。

## 生命周期（pet.System）

| 时机 | 做什么 |
| --- | --- |
| 进游戏（`session.Join`） | `pet.Join`：召唤 `pets.yaml` 的第一个宠物。这次召唤不算换宠物，不占冷却 |
| 客户端发 `SetPet` | `pet.Set`：选的就是现在这只则不动；冷却中拒绝；不认识的 id 拒绝；否则删掉旧宠物、占冷却、召唤新的（`pet` 为空 = 收回，同样占冷却） |
| 主人死亡 | `pet.Tick` 发现主人死了就收回宠物（删实体），但 `PetID` 保留 |
| 主人复活 | `pet.Tick` 发现主人活着而宠物不在场，重新召唤 |
| 宠物死亡 | `pet.Tick` 第一次看到时置 `PetDirty`（`PetStatus` 带复活倒计时）；`pet.respawn` 毫秒后原地复活：满血、在主人身边出现、重置行为树，发 `RESPAWN` 事件和 `pet_summon` 特效 |
| 主人断线（`session.Leave`） | `pet.Dismiss` 删掉宠物，再删主人 |

召唤出来的位置是主人身后偏一点（`FreeSpot` 避开障碍物）。`SetPet` 被拒绝时回 `Toast`，文字是 `pet` 包里的常量：

| 常量 | 文字 |
| --- | --- |
| `pet.ReasonCooldown` | 宠物还在冷却 |
| `pet.ReasonUnknown` | 没有这个宠物 |

## 行为树节点

宠物的 `home` 没有意义，所以树里不用 `return_home` / `far_from_home`。新节点的参数和说明见 [bt 和 ai](ai-bt.md#宠物节点)：服务 `guard_owner`，任务 `follow_owner`、`keep_distance`、`cast_on_owner`，条件 `owner_far`、`owner_hp_below`、`owner_in_combat`。三棵树（`Selector` 根上挂服务 `GuardOwner`，每次 tick 选目标）：

```text
pet_melee（小狼）
├─ [OwnerFar 350] 回到主人身边：ClearTarget → FollowOwner
├─ [HasTarget] 战斗
│   ├─ CastSkill 2 嚎叫 [Cooldown 12]
│   ├─ CastSkill 1 咬 [TargetInRange 50]
│   └─ ChaseTarget
└─ 跟随：FollowOwner → Wait 0.5 → Say（Cooldown 20，ForceSuccess）

pet_caster（火灵）：战斗分支换成
│   ├─ CastSkill 2 爆燃 [TargetInRange 90]
│   └─ Sequence：KeepDistance(120~220) → CastSkill 1 火球 [ForceSuccess]

pet_healer（林精）
├─ [OwnerHpBelow 60] 治疗主人：FollowOwner(Distance 150) → CastOnOwner 2
├─ [OwnerFar 350] 回到主人身边
├─ [HasTarget] 战斗：CastSkill 1 [TargetInRange 200]，否则 ChaseTarget(StopRange 160)
└─ 跟随
```

火灵的火球上挂 `ForceSuccess`：技能冷却时 `CastSkill` 会失败，不包的话整个战斗分支失败，宠物就会跑回主人身边再跑回来。

## 同步和协议

- `ClientMsg.pet = 10`：`SetPet { optional string pet = 1; }`，空串 = 收回。
- `ServerMsg.pet_status = 8`：`PetStatus { pet = 1; entity = 2; respawn_in = 3; cooldown = 4; }`，召唤、收回、换宠物、死亡、复活时发给主人（`Companion.PetDirty` 置位，`session.publishGear` 发）。`respawn_in` 是宠物复活倒计时（活着为 0，毫秒），`cooldown` 是还要多久才能换宠物（毫秒）。
- `Welcome.pets = 13`：`repeated PetInfo { id, name, desc, color, model }`，按 `pets.yaml` 的顺序。
- `EntityInfo.owner = 14`：宠物的主人实体 id（非宠物为 0）；`EntityInfo.kind` 多一个 `PET`。
- 特效事件（`CAST`，没有 `skill`，客户端按 `fx` 画）：`pet_summon`（召唤和复活，`x`/`y` 是出现的位置，`src` 是宠物）、`pet_teleport`（传送，`x`/`y` 是出发的位置，`tx`/`ty` 是到达的位置，和闪现一样）。名字常量是 `core.FXPetSummon`、`core.FXPetTeleport`。
