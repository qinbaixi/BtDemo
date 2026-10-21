# BtDemo 文档

这组文档主要讲 Go 后端是怎么搭起来的：每个模块管什么、为什么这样分、数据怎么流动、想加功能该改哪里。

## 建议阅读顺序

1. [Go 速读](go-primer.md)：先看这篇。它只讲这个项目里实际用到的 Go 写法（包、结构体嵌入、方法、闭包、goroutine 和 channel），看完再读代码会顺很多。
2. [整体架构](architecture.md)：进程里有哪些 goroutine，一帧（tick）里各系统按什么顺序执行，玩家按下一个技能键后数据经过了哪些地方。
3. 按模块细读：

| 模块 | 文档 | 一句话 |
| --- | --- | --- |
| `internal/game/core` | [core：共享数据](modules/core.md) | 实体、组件、实体表、时钟、事件队列，只有数据没有规则 |
| `internal/game/aoi` | [aoi：九宫格视野](modules/aoi.md) | 谁能看见谁、范围查询 |
| `config/map.tmj` | [地图：Tiled 编辑与格式](modules/map.md) | 地图文件格式、怎么在 Tiled 里编辑、加新物件 |
| `internal/game/nav` + `move` | [nav 和 move：碰撞、寻路、移动](modules/nav-move.md) | 地图阻挡、推出滑动、A* 寻路、沿路径走 |
| `internal/game/attr` + `combat` | [attr 和 combat：属性与战斗](modules/attr-combat.md) | 属性公式、升级、技能、伤害、Buff、死亡 |
| `internal/bt` + `internal/game/ai` | [bt 和 ai：行为树](modules/ai-bt.md) | 解释 BtTree 导出的树，把节点绑定到游戏代码 |
| `internal/game/spawn` | [spawn：出生与复活](modules/spawn.md) | 刷怪、创建玩家、复活 |
| `internal/game/session` + `internal/server` | [session 和 server：连接与同步](modules/session-server.md) | WebSocket、协议、AOI 增量同步 |
| `internal/config` | [config：配置](modules/config.md) | YAML 加载与校验 |
| `web/` | [前端：浏览器客户端](modules/frontend.md) | TypeScript + Vite，目录结构、开发流程、改协议 |

[PLAN.md](PLAN.md) 是项目开始时写的计划，保留作历史记录；有些细节（例如协议从 JSON 换成了 protobuf、`internal/game` 拆成了多个包）已经变了，以这里的文档为准。

## 一张图看懂

```text
浏览器 ──WebSocket(protobuf)──► internal/server ──Do(func)──► World 的 goroutine
                                                                   │ 每 50ms 一帧 Step()
                                                                   ▼
        Spawn.Tick → Combat.Tick → Move.Tick → AI.Tick → (每 2 帧) Sessions.Flush
             │            │            │          │                  │
             └────────────┴─ 都读写 core.State（实体表、时钟、事件队列）┘
                                                                   │
浏览器 ◄──────────── enter / leave / sync / toast ─────────────────┘
```

- 整个游戏世界只在一个 goroutine 里运行，所以游戏代码里没有锁。
- 每个系统是一个独立的包，彼此通过 `core.State` 共享数据，通过构造时传入的指针调用对方。
- 配置（`config/*.yaml`）和行为树（`bt/` 导出的 Go）在启动时加载并校验，出错直接启动失败并指出位置。
