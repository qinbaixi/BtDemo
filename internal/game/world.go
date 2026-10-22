// Package game 是游戏服务器的世界。每个职责都是独立包中的一个系统，
// World 只负责把它们连接起来并按顺序运行：
//
//	core     共享数据：实体及其组件、时钟、事件队列
//	aoi      九宫格兴趣区域
//	nav      来自 map.tmj 的障碍物、碰撞与 A* 寻路
//	attr     属性公式、经验与升级
//	move     移动：玩家输入、路径跟随、碰撞
//	combat   技能、伤害、增益、死亡
//	ai       来自 BtTree 的行为树与调试跟踪
//	spawn    创建怪物、NPC 和玩家，复活
//	zone     地上的回血区：出生点泉水、技能放的法阵
//	session  已连接的玩家：输入、AOI 同步、协议
package game

import (
	"context"
	"time"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/ai"
	"github.com/qinbaixi/BtDemo/internal/game/aoi"
	"github.com/qinbaixi/BtDemo/internal/game/attr"
	"github.com/qinbaixi/BtDemo/internal/game/combat"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/move"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/game/session"
	"github.com/qinbaixi/BtDemo/internal/game/spawn"
	"github.com/qinbaixi/BtDemo/internal/game/zone"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// Session 是一个已连接的玩家。
type Session = session.Session

// World 持有所有游戏状态。一切都在调用 Run 的 goroutine 上运行；
// 其他 goroutine 通过 Do 与它通信。
type World struct {
	State    *core.State
	Grid     *aoi.Grid
	Nav      *nav.Map
	Attr     *attr.System
	Move     *move.System
	Combat   *combat.System
	AI       *ai.System
	Spawn    *spawn.System
	Zone     *zone.System
	Sessions *session.System

	inbox chan func()
}

// NewWorld 构建所有系统，加载并校验行为树，
// 并生成配置好的怪物和 NPC。
func NewWorld(cfg *config.Config, seed int64) (*World, error) {
	return newWorld(cfg, seed, nav.ShapesFromLayout(cfg.Layout))
}

// newWorld 与 NewWorld 相同，但直接传入障碍物。
func newWorld(cfg *config.Config, seed int64, obstacles []nav.Shape) (*World, error) {
	world := &World{State: core.NewState(cfg, seed), inbox: make(chan func(), 256)}
	world.Grid = aoi.NewGrid(cfg.World.Map.Width, cfg.World.Map.Height, cfg.World.AOI.Cell)
	world.Attr = attr.New(world.State)
	world.Nav = nav.New(cfg.World.Map.Width, cfg.World.Map.Height, obstacles)
	world.Move = move.New(world.State, world.Grid, world.Nav)
	world.Combat = combat.New(world.State, world.Grid, world.Attr, world.Nav)
	world.Zone = zone.New(world.State, world.Grid)
	var err error
	if world.AI, err = ai.New(world.State, world.Combat, world.Move); err != nil {
		return nil, err
	}
	world.Spawn = spawn.New(world.State, world.Grid, world.Move, world.AI)
	world.Sessions = session.New(
		world.State,
		world.Grid,
		world.Nav,
		world.Combat,
		world.AI,
		world.Spawn,
	)
	world.Spawn.SpawnConfigured()
	return world, nil
}

// TreeNames 列出编译进二进制文件的行为树。
func TreeNames() map[string]bool { return ai.TreeNames() }

// Do 在世界 goroutine 上运行 fn。
func (world *World) Do(fn func()) { world.inbox <- fn }

// Run 推进世界运行，直到 ctx 结束。
func (world *World) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(float64(time.Second) * world.State.Clock.Dt))
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case fn := <-world.inbox:
			fn()
		case <-ticker.C:
			world.Step()
		}
	}
}

// Step 将世界推进一个 tick。
func (world *World) Step() {
	world.State.Clock.Advance()
	world.Spawn.Tick()
	world.Combat.Tick()
	world.Zone.Tick()
	world.Move.Tick()
	world.AI.Tick(world.Sessions.Watched())
	cfg := world.State.Cfg.World
	if world.State.Clock.Tick%max(1, cfg.TickRate/cfg.SyncRate) == 0 {
		world.Sessions.Flush()
	}
}

// Get 返回具有给定 id 的实体，若不存在则返回 nil。
func (world *World) Get(id int) *core.Entity { return world.State.Ents.Get(id) }

// Join 为一个连接创建新角色。须在世界 goroutine 上调用。
func (world *World) Join() *Session { return world.Sessions.Join() }

// Leave 移除会话的角色。须在世界 goroutine 上调用。
func (world *World) Leave(client *Session) { world.Sessions.Leave(client) }

// Input 应用一条客户端消息。须在世界 goroutine 上调用。
func (world *World) Input(client *Session, msg *pb.ClientMsg) { world.Sessions.Input(client, msg) }
