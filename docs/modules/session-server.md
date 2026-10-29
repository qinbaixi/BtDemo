# session 和 server：连接与同步

代码：`internal/server/server.go`（网络）、`internal/game/session/`（会话逻辑：`session.go` 输入和 Flush，`outbox.go` 发送，`view.go` 视野进出，`connect.go` 连接与重连，`link.go` 发送队列，`inbox.go` 输入队列，`export.go` 测试用的全量状态）、`proto/btdemo.proto`（协议）、`internal/pb/`（生成的 Go 代码）

## 分工

- **server** 只管网络：HTTP、WebSocket、protobuf 编解码、读写 goroutine。它不碰游戏状态：玩家输入放进 `Session.Inbox`，连接、断开交给 `game.Manager`，由它找到角色所在的线、`scene.Do` 交给那条线的 goroutine，都在下一个 tick 开头处理（见 [场景与分线](scene.md)）。
- **session** 是游戏里的“连接”：把客户端消息变成游戏操作，并在同步时决定每个玩家该收到什么。它运行在所在那条线的 goroutine 里。换场景、换线时会话对象整个交给目标线（`TakeOut` / `Bring`，`session/travel.go`），连接和输入队列不变；跨场景的请求（线路列表、切线）通过 `session.Host` 交给场景。

## 一个连接的生命周期（server.go、session/connect.go）

```text
浏览器连 /ws
  └─ serve(conn)
       ├─ 读第一帧：必须是 ClientMsg{hello: Hello{token}}，10 秒内没来或不是 Hello 就断开
       ├─ manager.Attach(link, token)（等角色所在的线处理完）：
       │     token 认得 → 接回原来的角色，发 Welcome{resumed} + 全量
       │     token 为空 / 过期 / 伪造 → 创建新角色（Join），发 Welcome（带新 token）
       ├─ 写 goroutine：等 link.Wake() → link.Take() 取走全部帧逐个写出；每 5 秒发一次 WebSocket ping
       ├─ 读循环（当前 goroutine）：
       │     收到二进制帧 → proto.Unmarshal 成 pb.ClientMsg → s.Inbox.Push（队列溢出就断开）
       │     15 秒读不到任何东西（含 pong）就认为连接已死；解不开的帧超过 10 个就断开
       └─ 读出错（断开）→ manager.Detach(session, link)：角色保留，不删除
```

### 发送队列 Link

每条连接有一个 `session.Link`（`link.go`）：世界 goroutine 把编码好的 `Frame` 字节 `Push` 进去，写 goroutine 被 `Wake()` 叫醒后 `Take` 全部写出。
它是“互斥锁 + 切片”，队列满不满按**字节**算（`LinkByteLimit`，1 MB）。世界 goroutine **从不阻塞在网络上**，也不会悄悄丢帧——丢一帧会让客户端的增量状态错乱：

- **慢客户端**：积压超过上限时，清掉积压和这一帧没发的消息，下一次 `Flush` 前先发一份**全量**（`sendFull`，同重连）。`lagLimit`（10000 毫秒）内第 `lagStrikes`（3）次才断开连接，角色照样保留，客户端重连后同样拿到全量。
- **关闭**：`Link.Close` 之后 `Push` 被忽略，写协程写完剩下的帧、发 WebSocket 关闭帧后断开。角色被删、同一角色又连了新连接（旧连接作废）、停服都会关闭 Link。

### 断线保留与 token 重连

- `Welcome.token` 是随机凭证。连接断开（`Detach`）时角色**不删**：停下移动和格挡，原地站着（照样会被打、会死），`link` 置空，期间不攒任何消息。
- `world.yaml` 的 `session.keep`（30000 毫秒）内，客户端在 `Hello` 里带上 token 重连，`Attach` 把新 Link 接到原来的角色上并发全量：`Welcome{resumed: true}`（客户端收到后清空所有实体，保留自己的选择，不再弹出挑技能界面）、周围所有实体的 `Enter`，背包、宠物状态、自身属性、回血区和行为树结构也重发。超过时间没回来，`ExpireDetached`（每个 tick 调用）删除角色，之后同一 token 会被当作新玩家。
- 同一角色又连了一条新连接时，旧连接被关闭。旧连接晚到的 `Detach` 因为 `link` 已不是会话当前的连接而被忽略。
- 全量的内容和新玩家加入时一模一样，所以“重连”“慢客户端追上”“新加入”在客户端是同一条处理路径。

## 协议（proto/btdemo.proto）

用 protobuf（proto2）二进制编码，**每个 WebSocket 帧是一个二进制 `ClientMsg`（客户端 → 服务端）或一个 `Frame`（服务端 → 客户端）**。服务端用 `protoc` 生成的 `internal/pb`；前端用 protobufjs 从同一份 `.proto` 生成 JS 代码和 TypeScript 类型（`web` 下 `npm run proto`），字段对不上时编译期就报错。服务端仍在 `/btdemo.proto` 提供原文，方便查看；地图文件在 `/maps/<文件名>` 原样提供（`/map.tmj` 是默认场景的，见 [地图](map.md)）。

**协议里没有浮点数**（约定见 [config 的数值单位](config.md#数值单位约定)）：时刻和时长是整数毫秒（`Frame.time`、`*_at`、`until`、`ready_at` 是 int64 的游戏时钟；`dur`、`cooldown`、`interval`、`stun`、`knock_time` 等是 int32 毫秒）；比例、概率、倍率是万分比（`crit`、`heal`、`guard`，以及 `ItemStat` 里的 `crit`、`crit_dmg`、`cdr`）；坐标和距离是整数像素；客户端发来的方向是单位向量 ×10000。

客户端 → 服务端 `ClientMsg`（oneof）。**连接后的第一帧必须是 `Hello`**：

| 消息 | 含义 |
| --- | --- |
| `Hello{token}` | 首帧。token 为空（或未知、已过期）= 创建新角色；认得的 token = 接回断线保留的角色，服务端发 `Welcome{resumed}` 和全量 |
| `Move{dx, dy}` | 移动方向：单位向量 ×10000 的整数（服务端归一化，0 表示停） |
| `SetTarget{id}` | 选中目标 |
| `Cast{slot, target, dx, dy}` | 释放第 slot 个技能；`dx`、`dy` 是瞄准方向（单位向量 ×10000 的整数），给 dash（闪现往哪）和 line（飞斧往哪）用，服务端归一化 |
| `Watch{id}` | 调试面板要观察这个实体的行为树（0 表示不看） |
| `Block{on, face}` | 按下 / 松开右键格挡；`face` 是没选目标时盾朝哪边（-1 左、1 右） |
| `Loadout{skills, class}` | 挑技能：按顺序放到第 2 格起的技能 id 列表；`class` 不空时同时换职业，技能从新职业的池里挑（见下面 Input） |
| `Equip{uid}` | 装上背包里的一件物品（`ItemSlotted.uid`），原来槽位里的回到背包 |
| `Unequip{slot}` | 卸下 weapon / armor / trinket 槽位里的物品 |
| `SetSkin{skin}` | 换成当前职业的皮肤（空 = 默认） |
| `SetPet{pet}` | 选择跟随的宠物（`PetInfo.id`），空 = 收回宠物；被拒绝（换宠物冷却中等）回 `Toast` |
| `Lines{}` | 要这个场景的线路列表，回 `LineList` |
| `SwitchLine{line}` | 换到这个场景的第 line 线（活着、5 秒内没挨打也没出手才行）；成功时回 `Travel` 和新线的 `Welcome{resumed}`，被拒绝回 `Toast` |

服务端 → 客户端：每个 WebSocket 帧是一个 `Frame{time, msgs}`。一个同步帧（`sync_rate`，10 次/秒）里发生在玩家附近的所有消息按顺序合成**一个** `Frame`，一次写出；`time` 是发送时的服务端时间（毫秒，`*_at`、`until` 等字段用同一个时钟）。玩家自己操作的回应（`Toast`、`SkillBar`、`Inventory`……）和 `Welcome` 不等同步帧，立即用单独的 `Frame` 发出。`Frame.msgs` 里的每条是 `ServerMsg`：

| 消息 | 何时发 | 内容 |
| --- | --- | --- |
| `Welcome` | 连接时一次；重连、客户端跟不上时再发一次（`resumed = true`） | 自己的 id、`token`（断线重连用）、地图尺寸、AOI 格子、技能栏、碰撞体 `obstacles`（调试显示用；场景物件前端从 `scene.map` 的地址读）、所在场景 `scene`（id、名字、线号、地图地址、传送门）、当前职业的技能池 `pool`（slot 为 0）和要挑几个 `pick`、当前职业 `class`、所有职业 `classes`（`ClassInfo`：id、名字、说明、模型、颜色、默认技能栏 `skills`、技能池 `pool`、`pick`、`can_block`、皮肤 `skins`；第一个是默认职业）、装备图鉴 `items`（`ItemInfo`，属性按 str agi int vit max_hp atk matk def mdef crit crit_dmg speed cdr 的顺序，只列不为 0 的）、宠物图鉴 `pets`。`resumed`：还是同一个角色，客户端丢掉所有实体、等待重发的 `Enter`，保留自己的选择（不弹挑技能界面） |
| `Enter` | 实体进入视野；换职业、皮肤、武器外观后重发 | `EntityInfo` 列表：静态信息（名字、种类、模型、半径、颜色、皮肤 `skin`、武器外观 `gear`、宠物的主人 `owner`）加上**完整的** `EntityState`（所有字段都设置）。已见过的实体再收到 `Enter` 就是更新外观 |
| `Leave` | 实体离开视野（走远、被删除） | id 列表 |
| `EntityState` | 视野内某个实体的字段变了（同步帧） | **增量**：只设置变了的字段（x、y、hp、max_hp、lv、act、tg、dead、shield、blocking、looks，玩家还有架势 guard，0..10000 万分比），设置了的字段可以是 0 / false / 空串，没设置的客户端保持原值。proto2 的 presence 就是用来区分这两种情况的 |
| `Event` | 视野内发生了事件 | 施法、伤害、治疗、Buff、死亡、复活、说话、升级、掉落，见下 |
| `SelfInfo` | 自己的属性变了 | 只发给自己，只发变了的字段（`base`、`attr` 整块发；`cds`、`buffs` 在 `cds_set`、`buffs_set` 为真时是完整的新列表）。`Enter` 之后第一条是完整的 |
| `ZoneList` | 回血区增减时 | 整份回血区列表（不做 AOI 过滤，区域很少） |
| `AiTrace` | 同步帧里，且调试面板在看的实体在视野内 | 这一帧里被观察实体跑过的行为树 tick |
| `Inventory` | 加入 / 重连之后，背包或装备每次变化 | 完整的物品列表（`uid`、`id`、`slot`，空 slot = 在背包里）和背包格数 `capacity` |
| `PetStatus` | 宠物召唤、收回、死亡、复活，换宠冷却变化 | 当前宠物 `pet`、实体 id `entity`、复活倒计时 `respawn_in`、换宠冷却 `cooldown` |
| `SkillBar` | 挑技能被接受后 | 新的技能栏（`skills`，slot 从 1 起）和换完后的职业 `class` |
| `Toast` | 技能放不出来、挑技能被拒绝、穿脱装备被拒绝、背包满了等 | 一行提示 |
| `LineList` | 回应 `Lines` | 场景 id、自己的线号 `current`、每条线的人数和 `soft`、`hard` |
| `Travel` | 换场景、换线出发时 | 去的场景名：客户端显示过场，等新的 `Welcome`（`scene` 是新场景） |

旧的 `Sync`（每次同步把视野内所有实体的位置血量整份发一遍）已经去掉：状态改成脏标记增量，进出视野改成 `Enter` / `Leave`，事件、自身属性、回血区、AI 追踪各用独立的消息。

技能信息 `SkillInfo` 的 `kind` 是 `target`、`aoe`、`self`、`dash`、`line`、`zone`、`rain` 之一，`desc` 是选技能面板上的说明；`dash` 和 `rain` 带 `distance`（位移距离 / 箭雨没有目标时落点在前方多远）。

事件 `Event` 用 `kind` 区分：施法、伤害、治疗、Buff、死亡、复活、说话、升级、掉落。几个字段是后加的：

- `LOOT`：`src` 是死掉的怪物，`dst` 是拿到的玩家，`item` 是物品 id。
- `proc`：装备特效造成的 `DAMAGE` / `HEAL`（还有多重射击的 `CAST`、冰冻的 `BUFF`）带特效名，见 [item](items.md)。

- `DAMAGE` 的 `immune`：目标无敌，没受伤（`value` 为 0）；`blocked`、`absorbed` 分别是格挡和护盾吸收的量，都不计入 `value`。
- 命中的分量（见 [attr 和 combat](attr-combat.md)）：`CAST` / `DAMAGE` 的 `weight` 是档位；`DAMAGE` 的 `kx`、`ky`、`knock_time` 是击退落点和用时，`stun` 是硬直毫秒数，`wall` 表示撞墙，`result` 是 `HitResult`（`HIT` 不写、`BLOCK`、`PARRY`、`GUARD_BREAK`、`IMMUNE`；`PARRY` 时击退和硬直说的是攻击者 `src`）。有前摇的 `CAST` 带 `hit_at`（命中的服务端时间）；前摇被打断发 `INTERRUPT`（`id` 是被打断的实体）。
- `act` 新增 `windup`（前摇中）和 `stagger`（硬直、被击退）。
- `CAST` 的 `tx`、`ty`：闪现、飞斧、穿云箭的终点（`x`、`y` 是起点）。穿透的 `line`（fx `pierce`）终点是射程尽头或墙前，不因命中停下，`dst` 是第一个命中的（可空），之后按沿线顺序给每个命中的敌人发 `DAMAGE`。
- `rain` 的 `CAST`：`x`、`y` 是落点，`radius` 是范围，`src` 是施法者，`dst` 是目标（没有目标则空），之后给落点范围内的每个敌人发 `DAMAGE`。

**改协议的步骤**：改 `proto/btdemo.proto` → `go generate ./internal/pb`（需要 protoc，CI 会检查生成代码是否最新）→ 服务端填字段（`session/proto.go`）→ 前端 `npm run proto`，在 `web/src/net/types.ts` 加字段、`web/src/net/protocol.ts` 里转换（见 [前端](frontend.md)）。proto2 的可选字段在 Go 里是指针，用 `core.I32`、`core.I64`、`proto.String` 生成。

## 会话逻辑（session.go）

### Join / Attach / Detach / Leave

`Join` 调 `spawn.Player()` 创建角色（默认职业）——加入网格时周围的玩家就收到它的 `Enter`——生成 token，组装 `Welcome`（`classes` 里每个职业用 `classInfo` 转换）立即发出，把角色的 `CanPick` 设为真（还没放过技能，可以挑）；然后把周围的实体发给它，给新手装备（`item.GiveStarter`）、召唤宠物，发第一份 `Inventory`。碰撞体、装备图鉴、宠物图鉴在 `session.New` 时转换一次，之后每个 Welcome 直接复用。

`Attach` 按 token 接回断线保留的角色（发全量），认不得就走 `Join`；`Detach` 让角色进入断线保留状态；`Leave` 立即删除角色并关闭连接；`ExpireDetached` 每个 tick 删掉超过 `session.keep` 的断线角色。细节见上面的“断线保留与 token 重连”。

### Input

客户端消息先进会话自己的 `Inbox`（网络读协程 `Push`），世界 goroutine 在每个 tick 开头（所有系统运行之前）按到达顺序 `DrainInputs` 逐条调 `Input`，所以输入总在固定的时机生效，可以直接改实体。`Inbox` 里连续的同类状态型消息（移动、选目标、格挡、观察）只留最新的一条；两个 tick 之间排了超过 `InboxLimit`（128）条，判定为异常客户端，删掉它的角色。

每条消息处理完立即用 `SendNow` 把回应发出去（不等同步帧）：

- `Move`：归一化方向写进 `entity.MoveX/MoveY`，下一帧 `move.Tick` 才真正移动（输入和移动解耦，移动速度只由服务端决定）。
- `Cast`：选中的目标无效时自动找最近的怪（只对 `target` 类技能），然后 `combat.CastAimed` 带上 `dx`、`dy`，失败就回一个 `Toast`。
- `Loadout`：挑技能，见下面的规则。
- `Block`：`entity.SetBlocking`（会标脏），伤害结算和移动会读它。当前职业不能格挡（`can_block: false`）时，按下的消息被忽略，`Blocking` 保持 false；松开总是允许。
- `SetTarget`、`Watch`：记下来。
- `Equip`、`Unequip`、`SetSkin`：交给 `item.System`，被拒绝就回 `Toast`（规则和提示文字见 [item](items.md)）。

每条消息处理完之后（立即发出）以及每次 `Flush` 开头（随同步帧发出），`publishGear` 把物品和宠物系统留下的标记发出去：`Notices` → `Toast`，`InventoryDirty` → `Inventory`，`PetDirty` → `PetStatus`，`LookDirty` → `reshow`：给能看到这个实体的玩家重发它的 `Enter`。

#### 挑技能和换职业（Loadout）

`loadout()` 检查，任何一条不满足都回 `Toast`，什么都不改；全部通过就换上技能并回 `SkillBar`（带 `class`）。`Loadout.class` 为空表示不换职业；不空时按新职业检查（职业 id 不存在回 “职业无效”）：

1. 角色的 `CanPick` 为真：刚进游戏还没放过技能，或者死亡期间。放过一次技能之后就不能再挑，直到下次死亡。
2. 数量正好是（新）职业的 `Pick()`，不多不少。不对回 “技能选择无效”。
3. 每个 id 都在（新）职业的 `skill_pool` 里，且不重复。不对回 “技能选择无效”。

换职业时，检查都通过后先 `spawn.ApplyClass`（模型、颜色、半径、属性、速度、技能栏换成新职业的，皮肤重置为新职业的默认，等级保留，血量按比例保留），再 `item.ClassChanged`（新职业用不了的装备卸回背包、背包满了就丢掉并提示；第一次当这个职业时发它的新手装备），再把挑的技能放到第 2 格起；然后 `reshow`：给所有能看到它的玩家重发它的 `Enter`（带新的 `model`、`color`、`r`），其他玩家就能看到新模型，前端收到已存在实体的 `Enter` 时更新外观。没换职业时第 1 格的普攻不变。第 1 条不满足时回 “只能在刚进游戏或死亡时更换技能”，第 2、3 条不满足时回 “技能选择无效”。

### 发送：Broadcast / SendTo / SendNow / BroadcastNow（outbox.go）

每个会话有一个“这一帧待发”列表：

| 方法 | 行为 |
| --- | --- |
| `SendTo(session, msg)` | 放进这个会话的待发列表 |
| `Broadcast(x, y, msg)` | 放进能看到 (x, y) 的每个玩家的待发列表（`Grid.PlayersAround`，只遍历九宫格里的玩家，怪物和 NPC 直接跳过） |
| `SendNow(session, msg)` | 放进列表后马上把列表合成一个 `Frame` 写出（先发已经攒着的，顺序不乱）：玩家操作的回应、`Welcome` |
| `BroadcastNow(x, y, msg)` | 对能看到 (x, y) 的每个玩家 `SendNow` |

同步帧结束时（`Flush` 最后）每个会话的列表合成一个 `Frame` 写进 Link；断线期间（link 为空）和等着发全量的会话什么都不攒。积压超过上限时交给 `lagging` 处理（见上）。

### 视野进出（view.go）

`aoi.Grid` 在实体出现、消失、换格子时调用 `Watcher`（`System` 实现）的 `Shown` / `Hidden`。“P 能看到 E”等价于“两者格子相邻”，所以一次通知同时决定两边：

- 通知里那些格子里的玩家，看到 / 看不到 `entity`：发 `Enter`（`EntityInfo`，带完整状态）/ `Leave`；
- `entity` 自己是玩家时，它看到 / 看不到那些格子里所有实体。

谁能看到谁只由格子决定，不为每个玩家另外记“看得到谁”：Enter / Leave 只在格子通知的那一刻发，平时的状态和事件广播直接问格子要九宫格里的玩家。需要判断时用 `Grid.CanSee(viewer, target)`。

### 实体状态：脏标记增量（core/dirty.go）

`core.Entity.Dirty` 是一组位（`DirtyPos`、`DirtyHP`、`DirtyMaxHP`、`DirtyLevel`、`DirtyAction`、`DirtyTarget`、`DirtyDead`、`DirtyShield`、`DirtyBlocking`、`DirtyLooks`），每位对应 `EntityState` 的一个字段。改这些字段要用 `entity.SetPos` / `SetHP` / `SetDead` 等 setter（值真的变了才标脏），或者改完调 `MarkDirty`。`Flush` 对每个脏实体用 `entityDelta(entity, dirty)` 生成只含变化字段的 `EntityState`，`Broadcast` 给能看到它的玩家，然后清零。进入视野时发的是 `entityDelta(entity, DirtyAll)` 的全量（测试和压测用 `session.FullState` 取同样的全量，和客户端合并出的状态比较）。

加一个要同步的字段：在 `core.Dirty` 加一位，在 `entityDelta` 里按这一位填 `pb.EntityState`，改 proto，改写字段的地方用 setter。

### Flush：同步帧

每 `tick_rate / sync_rate` 个 tick 调用一次（`World.Step` 最后），顺序是：

1. 等着发全量的会话（客户端跟不上）先 `sendFull`。
2. `publishGear`：物品、宠物系统攒下的提示、背包、宠物状态、外观变化。
3. 脏实体的 `EntityState` 增量，按实体位置 `Broadcast`（位置变了而格子没更新的话，先补一次 `Grid.Moved`）。
4. 事件队列里的 `Event`，按事件发生的位置 `Broadcast`，然后清空队列，所以一个事件只发一次，只发给看得见它发生的人。
5. 每个玩家自己的：`SelfInfo` 增量（和上次发出的完整信息比较，没变就不发）、版本变了的 `ZoneList`、被观察实体的 `AiTrace`（实体在视野内才发），清空 AI 追踪缓存。
6. 每个会话的待发列表合成一个 `Frame`，写进 Link。

### proto.go

把 `core.Entity` 转成协议消息的几个函数：`entityInfo`（进入视野的静态信息，含 `skin`、`gear`）、`inventoryInfo`（背包）、`itemInfos`（装备图鉴）、`skinInfos`（职业皮肤）、`entityInfo` / `entityDelta`（进入视野的完整信息、按脏标记生成的增量，含 `looks`）、`selfInfo`（自己的详细属性）、`skillInfo` / `skillBar`（技能栏和技能池里的一条技能、整个技能栏）、`obstacles`（碰撞体）。坐标下发时向下取整成整数像素（`core.FloorI32`），血量等字段本来就是整数，服务端不做小数处理。

## 前端在哪里接这些消息

`web/src/net/protocol.ts` 的 `decode` 把 `Frame` 里的 `ServerMsg` 转成前端用的普通对象，`web/src/game/sync.ts` 更新本地状态，`web/src/render/` 每帧绘制。前端只做表现和插值，所有判定（碰撞、伤害、冷却）都以服务端为准。
