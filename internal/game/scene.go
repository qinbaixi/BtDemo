// Package game 是游戏服务器的世界。服务器同时运行多个场景（Scene）：每个场景模板（scenes.yaml）
// 可以开好几条线，每条线是一个 Scene，各自一个 goroutine，互不共享可变数据；
// Manager 负责开关场景、分线、玩家换场景和断线重连时找到角色在哪（见 manager.go、travel.go）。
//
// 一个场景里每个职责都是独立包中的一个系统，Scene 只负责把它们连接起来并按顺序运行：
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
//	portal   通往别的场景的传送门
//	session  已连接的玩家：输入、AOI 同步、协议
package game

import (
	"context"
	"sync"
	"sync/atomic"
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
	"github.com/qinbaixi/BtDemo/internal/game/portal"
	"github.com/qinbaixi/BtDemo/internal/game/session"
	"github.com/qinbaixi/BtDemo/internal/game/spawn"
	"github.com/qinbaixi/BtDemo/internal/game/zone"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// Session 是一个已连接的玩家。
type Session = session.Session

// Scene 是一个场景的一条线，持有这条线上的全部游戏状态。一切都在调用 Run 的 goroutine 上运行；
// 其他 goroutine（包括别的场景和 Manager）通过 Do 提交命令、通过 Session.Inbox 提交玩家输入，
// 两者都在每个 tick 开头统一处理。场景之间从不直接读写对方的数据。
type Scene struct {
	Template *config.Scene // 场景模板（地图、刷怪……）
	Line     int           // 第几线，从 1 开始

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
	Portals  *portal.System

	manager  *Manager // 单独运行的场景（测试）为 nil
	commands commandQueue
	stats    sceneStats
}

// World 是只有一个场景时的叫法（测试和旧代码用）。
type World = Scene

// sceneStats 是给 /debug/scenes 看的运行数据，场景 goroutine 写，别的 goroutine 读。
type sceneStats struct {
	tickNanos atomic.Int64 // 最近一个 tick 花了多少纳秒（滑动平均）
	peakNanos atomic.Int64 // 最近一段时间最慢的 tick
	entities  atomic.Int64
	players   atomic.Int64
}

// commandQueue 是其他 goroutine 交给世界执行的命令（加入、离开等）。
// 用互斥锁加切片而不是有界 channel：提交永远不阻塞，也不会因为满了而丢。
type commandQueue struct {
	mutex   sync.Mutex
	pending []func()
	stopped bool // 世界已停止：之后提交的命令被拒绝
}

// NewWorld 构建一个单独运行的场景（不归 Manager 管，不能换线、传送门不工作）：
// 用 cfg 本身的地图、刷怪和回血区（有 scenes.yaml 时就是默认场景的）。测试用。
func NewWorld(cfg *config.Config, seed int64) (*World, error) {
	return newWorld(cfg, seed, nav.ShapesFromLayout(cfg.Layout))
}

// newWorld 与 NewWorld 相同，但直接传入障碍物。
func newWorld(cfg *config.Config, seed int64, obstacles []nav.Shape) (*World, error) {
	template := cfg.Single().Scenes.DefaultScene()
	return newScene(core.NewState(cfg, seed), template, 1, obstacles, nil)
}

// newScene 在 state 上构建一个场景的所有系统，加载并校验行为树，并生成配置好的怪物和 NPC。
func newScene(
	state *core.State,
	template *config.Scene,
	line int,
	obstacles []nav.Shape,
	manager *Manager,
) (*Scene, error) {
	cfg := state.Cfg
	scene := &Scene{Template: template, Line: line, State: state, manager: manager}
	scene.Grid = aoi.NewGrid(cfg.World.Map.Width, cfg.World.Map.Height, cfg.World.AOI.Cell)
	scene.Attr = attr.New(scene.State)
	scene.Nav = nav.New(cfg.World.Map.Width, cfg.World.Map.Height, obstacles)
	scene.Move = move.New(scene.State, scene.Grid, scene.Nav)
	scene.Items = item.New(scene.State)
	scene.Combat = combat.New(
		scene.State,
		scene.Grid,
		scene.Attr,
		scene.Nav,
		scene.Items,
	)
	scene.Zone = zone.New(scene.State, scene.Grid)
	var err error
	if scene.AI, err = ai.New(scene.State, scene.Combat, scene.Move); err != nil {
		return nil, err
	}
	scene.Spawn = spawn.New(scene.State, scene.Grid, scene.Move, scene.AI)
	scene.Pet = pet.New(scene.State, scene.Grid, scene.Move, scene.AI, scene.Spawn)
	scene.Sessions = session.New(
		scene.State,
		scene.Grid,
		scene.Nav,
		scene.Combat,
		scene.AI,
		scene.Spawn,
		scene.Items,
		scene.Pet,
	)
	scene.Portals = portal.New(scene.State)
	scene.Sessions.SetHost(scene)
	scene.Spawn.SpawnConfigured()
	return scene, nil
}

// TreeNames 列出编译进二进制文件的行为树。
func TreeNames() map[string]bool { return ai.TreeNames() }

// Do 让 fn 在世界 goroutine 上、下一个 tick 开头运行。不阻塞调用方。
// 世界已经停止时返回 false，fn 不会运行；返回 true 的 fn 一定会运行（停服时也会先跑完）。
func (scene *Scene) Do(fn func()) bool {
	scene.commands.mutex.Lock()
	defer scene.commands.mutex.Unlock()
	if scene.commands.stopped {
		return false
	}
	scene.commands.pending = append(scene.commands.pending, fn)
	return true
}

// takeCommands 取走排队的命令；stop 为 true 时同时关闭队列，之后的 Do 都返回 false。
func (scene *Scene) takeCommands(stop bool) []func() {
	scene.commands.mutex.Lock()
	defer scene.commands.mutex.Unlock()
	pending := scene.commands.pending
	scene.commands.pending = nil
	if stop {
		scene.commands.stopped = true
	}
	return pending
}

// Run 推进世界运行，直到 ctx 结束。每个 tick 依次：执行命令、处理玩家输入、运行各系统。
// 结束时先跑完已经接受的命令，再断开所有会话，让客户端收到关闭帧。
func (scene *Scene) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(float64(time.Second) * scene.State.Clock.Dt))
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			for _, command := range scene.takeCommands(true) {
				command()
			}
			scene.Sessions.CloseAll()
			return
		case <-ticker.C:
			scene.tick()
		}
	}
}

// tick 是 Run 每个 tick 做的事：执行命令、处理玩家输入、推进一个 tick，并记下耗时。
func (scene *Scene) tick() {
	started := time.Now()
	for _, command := range scene.takeCommands(false) {
		command()
	}
	scene.Sessions.DrainInputs()
	scene.Step()
	scene.stats.record(time.Since(started), scene)
}

// Step 将世界推进一个 tick。
func (scene *Scene) Step() {
	scene.State.Clock.Advance()
	scene.Spawn.Tick()
	scene.Pet.Tick()
	scene.Combat.Tick()
	scene.Zone.Tick()
	scene.Move.Tick()
	scene.AI.Tick(scene.Sessions.Watched())
	scene.Portals.Tick(scene.eachPlayer, scene.enterPortal)
	scene.Sessions.ExpireDetached()
	cfg := scene.State.Cfg.World
	if scene.State.Clock.Tick%max(1, cfg.TickRate/cfg.SyncRate) == 0 {
		scene.Sessions.Flush()
	}
}

// record 记下一个 tick 的耗时。
func (stats *sceneStats) record(took time.Duration, scene *Scene) {
	nanos := took.Nanoseconds()
	average := stats.tickNanos.Load()
	stats.tickNanos.Store(average + (nanos-average)/16)
	peak := stats.peakNanos.Load()
	if nanos > peak {
		stats.peakNanos.Store(nanos)
	} else {
		stats.peakNanos.Store(peak - peak/64) // 慢慢回落，显示的是最近一段时间的峰值
	}
	stats.entities.Store(int64(scene.State.Ents.Count()))
	stats.players.Store(int64(scene.Sessions.Count()))
}

// Get 返回具有给定 id 的实体，若不存在则返回 nil。
func (scene *Scene) Get(id int) *core.Entity { return scene.State.Ents.Get(id) }

// Join 创建一个新角色，连着一个新的发送队列（测试用）。须在世界 goroutine 上调用。
func (scene *Scene) Join() *Session { return scene.Sessions.Join(session.NewLink()) }

// Attach 把一条新连接接到 token 对应的角色上并把全部东西重新发一遍，认不得 token 就创建新角色。
// 须在世界 goroutine 上调用。
func (scene *Scene) Attach(link *session.Link, token string) *Session {
	return scene.Sessions.Attach(link, token)
}

// Detach 处理连接 link 断开：角色保留 world.yaml session.keep 秒等它重连。
// 须在世界 goroutine 上调用。
func (scene *Scene) Detach(client *Session, link *session.Link) {
	scene.Sessions.Detach(client, link)
}

// Leave 立即删除会话的角色。须在世界 goroutine 上调用。
func (scene *Scene) Leave(client *Session) { scene.Sessions.Leave(client) }

// Input 应用一条客户端消息。须在世界 goroutine 上调用。
func (scene *Scene) Input(client *Session, msg *pb.ClientMsg) { scene.Sessions.Input(client, msg) }
