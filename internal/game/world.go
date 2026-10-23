// Package game 是游戏服务器的世界。每个职责都是独立包中的一个系统，
// World 只负责把它们连接起来并按顺序运行：
//
//	core     共享数据：实体及其组件、时钟、事件队列
//	aoi      九宫格兴趣区域
//	nav      来自 map.tmj 的障碍物、碰撞与 A* 寻路
//	attr     属性公式、经验与升级
//	move     移动：玩家输入、路径跟随、碰撞
//	item     物品：背包、穿脱装备、皮肤、怪物掉落
//	combat   技能、伤害、增益、死亡、装备特效
//	ai       来自 BtTree 的行为树与调试跟踪
//	spawn    创建怪物、NPC 和玩家，复活
//	pet      宠物：召唤、收回、换宠物、复活、跟随主人的等级
//	zone     地上的回血区：出生点泉水、技能放的法阵
//	session  已连接的玩家：输入、AOI 同步、协议
package game

import (
	"context"
	"sync"
	"time"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/ai"
	"github.com/qinbaixi/BtDemo/internal/game/aoi"
	"github.com/qinbaixi/BtDemo/internal/game/attr"
	"github.com/qinbaixi/BtDemo/internal/game/combat"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/item"
	"github.com/qinbaixi/BtDemo/internal/game/move"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/game/pet"
	"github.com/qinbaixi/BtDemo/internal/game/session"
	"github.com/qinbaixi/BtDemo/internal/game/spawn"
	"github.com/qinbaixi/BtDemo/internal/game/zone"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// Session 是一个已连接的玩家。
type Session = session.Session

// World 持有所有游戏状态。一切都在调用 Run 的 goroutine 上运行；
// 其他 goroutine 通过 Do 提交命令、通过 Session.Inbox 提交玩家输入，
// 两者都在每个 tick 开头统一处理。
type World struct {
	State    *core.State
	Grid     *aoi.Grid
	Nav      *nav.Map
	Attr     *attr.System
	Move     *move.System
	Items    *item.System
	Combat   *combat.System
	AI       *ai.System
	Spawn    *spawn.System
	Pet      *pet.System
	Zone     *zone.System
	Sessions *session.System

	commands commandQueue
}

// commandQueue 是其他 goroutine 交给世界执行的命令（加入、离开等）。
// 用互斥锁加切片而不是有界 channel：提交永远不阻塞，也不会因为满了而丢。
type commandQueue struct {
	mutex   sync.Mutex
	pending []func()
	stopped bool // 世界已停止：之后提交的命令被拒绝
}

// NewWorld 构建所有系统，加载并校验行为树，
// 并生成配置好的怪物和 NPC。
func NewWorld(cfg *config.Config, seed int64) (*World, error) {
	return newWorld(cfg, seed, nav.ShapesFromLayout(cfg.Layout))
}

// newWorld 与 NewWorld 相同，但直接传入障碍物。
func newWorld(cfg *config.Config, seed int64, obstacles []nav.Shape) (*World, error) {
	world := &World{State: core.NewState(cfg, seed)}
	world.Grid = aoi.NewGrid(cfg.World.Map.Width, cfg.World.Map.Height, cfg.World.AOI.Cell)
	world.Attr = attr.New(world.State)
	world.Nav = nav.New(cfg.World.Map.Width, cfg.World.Map.Height, obstacles)
	world.Move = move.New(world.State, world.Grid, world.Nav)
	world.Items = item.New(world.State)
	world.Combat = combat.New(
		world.State,
		world.Grid,
		world.Attr,
		world.Nav,
		world.Items,
	)
	world.Zone = zone.New(world.State, world.Grid)
	var err error
	if world.AI, err = ai.New(world.State, world.Combat, world.Move); err != nil {
		return nil, err
	}
	world.Spawn = spawn.New(world.State, world.Grid, world.Move, world.AI)
	world.Pet = pet.New(world.State, world.Grid, world.Move, world.AI, world.Spawn)
	world.Sessions = session.New(
		world.State,
		world.Grid,
		world.Nav,
		world.Combat,
		world.AI,
		world.Spawn,
		world.Items,
		world.Pet,
	)
	world.Spawn.SpawnConfigured()
	return world, nil
}

// TreeNames 列出编译进二进制文件的行为树。
func TreeNames() map[string]bool { return ai.TreeNames() }

// Do 让 fn 在世界 goroutine 上、下一个 tick 开头运行。不阻塞调用方。
// 世界已经停止时返回 false，fn 不会运行；返回 true 的 fn 一定会运行（停服时也会先跑完）。
func (world *World) Do(fn func()) bool {
	world.commands.mutex.Lock()
	defer world.commands.mutex.Unlock()
	if world.commands.stopped {
		return false
	}
	world.commands.pending = append(world.commands.pending, fn)
	return true
}

// takeCommands 取走排队的命令；stop 为 true 时同时关闭队列，之后的 Do 都返回 false。
func (world *World) takeCommands(stop bool) []func() {
	world.commands.mutex.Lock()
	defer world.commands.mutex.Unlock()
	pending := world.commands.pending
	world.commands.pending = nil
	if stop {
		world.commands.stopped = true
	}
	return pending
}

// Run 推进世界运行，直到 ctx 结束。每个 tick 依次：执行命令、处理玩家输入、运行各系统。
// 结束时先跑完已经接受的命令，再断开所有会话，让客户端收到关闭帧。
func (world *World) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(float64(time.Second) * world.State.Clock.Dt))
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			for _, command := range world.takeCommands(true) {
				command()
			}
			world.Sessions.CloseAll()
			return
		case <-ticker.C:
			for _, command := range world.takeCommands(false) {
				command()
			}
			world.Sessions.DrainInputs()
			world.Step()
		}
	}
}

// Step 将世界推进一个 tick。
func (world *World) Step() {
	world.State.Clock.Advance()
	world.Spawn.Tick()
	world.Pet.Tick()
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
