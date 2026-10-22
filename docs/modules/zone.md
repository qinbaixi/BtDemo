# zone：回血区

代码在 `internal/game/zone`（系统）和 `internal/game/core/zone.go`（数据）。前端画法在 `web/src/render/zones.ts`。

地上的一块区域：站在里面的友方每隔一段时间回一次血。有两种来源：

| 来源 | 配置 | 持续 | 客户端画法 |
|---|---|---|---|
| 地图自带（出生点的“生命之泉”） | `world.yaml` 的 `heal_zones` | 常驻 | `spring`：石头池沿围着一池发光的水，边缘一圈缓缓转动的虚线 |
| 技能放下（“治愈之泉”，`kind: zone`） | `skills.yaml` 技能的 `zone` | `duration` 秒（60） | `rune`：法阵，外圈亮的那段弧是剩余时间，最后 5 秒闪烁 |

## 配置

```yaml
# world.yaml
heal_zones:
  - { name: 生命之泉, x: 520, y: 800, radius: 130, heal: 0.05, interval: 1, faction: player, look: spring, color: "#7dffc4" }

# skills.yaml
healing_spring: { name: 治愈之泉, kind: zone, cooldown: 40, fx: zone, color: "#7dffb0",
                  zone: { name: 治愈之泉, radius: 110, heal: 0.03, interval: 1, duration: 60, look: rune, color: "#7dffb0" } }
```

`config.Zone` 的字段：

- `radius`：横向半径。区域是**压扁的椭圆**，纵向半径 = `radius × ZoneAspect`（0.6），和地上画的一样（其他地面特效也是压扁画的）。客户端的 `ZONE_ASPECT`（`web/src/game/config.ts`）必须和 `config.ZoneAspect` 一样。
- `heal`：每次回复最大生命的比例；`interval`：隔几秒回一次，默认 1。
- `duration`：技能放的持续多少秒，必须大于 0；`heal_zones` 不能写（常驻）。
- `faction`：只有 `heal_zones` 用，给哪个阵营回血；技能放的用施法者的阵营。
- `look`：`spring` 或 `rune`（默认）；`color`：客户端颜色。

## 谁能回血

和区域阵营**互不敌对**的存活实体（`zone.System.Friendly`）：玩家的泉水给玩家、守卫、村民回血，不给怪物回。满血的跳过。每次回血发一个 `HEAL` 事件，带 `zone` 字段（区域 id），客户端据此显示小号的绿字。

## 流程

- `zone.New` 在世界创建时放下 `heal_zones`。
- `combat.CastAimed` 的 `zone` 分支：发 `CAST` 事件（带 `x`、`y`、`radius`），用 `State.Zones.Replace` 在施法者脚下放一块区域；**同一个人再放一次，旧的消失**。
- `zone.System.Tick`（每个 tick，在 `Combat.Tick` 之后）：去掉到时间的区域；到了回血时间的区域给里面的友方回血。
- `core.Zones.Version` 在区域增减时变化。`session.Flush` 发现某个会话收到的版本旧了，就在这次 `Sync` 里带上**整份**列表（`zones` + `zones_set = true`）。区域很少，不做 AOI 过滤。`Zone.until` 是服务端时间（和 `Sync.time` 同一个时钟），客户端换成本地时间画倒计时。

## 客户端

- `game/sync.ts` 的 `setZones`：收到整份列表时合并。新出现的技能法阵等施法动作“手按到地上”那一刻（`ACTIONS.zone.lead`）才开始铺开；刚连上时已经在的直接显示；被去掉的淡出 0.7 秒。
- `render/zones.ts` 的 `ZoneLayer`：每块区域两张只覆盖自己范围的小画布，放在地表之上、地面标记和角色之下。线条画三遍（墨色粗线、压暗的区域色、加法混合的亮芯），在亮的石板广场和暗的草地上都看得清。往上飘的光点和小十字是 fx 粒子；`zoneLights` 给动态光照加一盏柔和的绿光（不要太强，出生点广场本来就亮）。
- 骑士动作 `zone`（`render/knightActions.ts`）：盾背到背上，空手托起一团绿光，再单膝跪下把手掌按进地里。
- `?fxlab` 实验页有“治愈之泉”“生命之泉”两个按钮，假区域也会给站在里面的自己回血。
