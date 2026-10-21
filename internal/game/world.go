// Package game 是游戏服务器的世界。每个职责都是独立包中的一个系统，
// World 只负责把它们连接起来并按顺序运行：
//
//	core     共享数据：实体及其组件、时钟、事件队列
//	aoi      九宫格兴趣区域
//	nav      来自 map.yaml 的障碍物、碰撞与 A* 寻路
//	attr     属性公式、经验与升级
//	move     移动：玩家输入、路径跟随、碰撞
//	combat   技能、伤害、增益、死亡
//	ai       来自 BtTree 的行为树与调试跟踪
//	spawn    创建怪物、NPC 和玩家，复活
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
	w := &World{State: core.NewState(cfg, seed), inbox: make(chan func(), 256)}
	w.Grid = aoi.NewGrid(cfg.World.Map.Width, cfg.World.Map.Height, cfg.World.AOI.Cell)
	w.Attr = attr.New(w.State)
	w.Nav = nav.New(cfg.World.Map.Width, cfg.World.Map.Height, obstacles)
	w.Move = move.New(w.State, w.Grid, w.Nav)
	w.Combat = combat.New(w.State, w.Grid, w.Attr)
	var err error
	if w.AI, err = ai.New(w.State, w.Combat, w.Move); err != nil {
		return nil, err
	}
	w.Spawn = spawn.New(w.State, w.Grid, w.Move, w.AI)
	w.Sessions = session.New(w.State, w.Grid, w.Nav, w.Combat, w.AI, w.Spawn)
	w.Spawn.SpawnConfigured()
	return w, nil
}

// TreeNames 列出编译进二进制文件的行为树。
func TreeNames() map[string]bool { return ai.TreeNames() }

// Do 在世界 goroutine 上运行 fn。
func (w *World) Do(fn func()) { w.inbox <- fn }

// Run 推进世界运行，直到 ctx 结束。
func (w *World) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(float64(time.Second) * w.State.Clock.Dt))
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case fn := <-w.inbox:
			fn()
		case <-ticker.C:
			w.Step()
		}
	}
}

// Step 将世界推进一个 tick。
func (w *World) Step() {
	w.State.Clock.Advance()
	w.Spawn.Tick()
	w.Combat.Tick()
	w.Move.Tick()
	w.AI.Tick(w.Sessions.Watched())
	cfg := w.State.Cfg.World
	if w.State.Clock.Tick%max(1, cfg.TickRate/cfg.SyncRate) == 0 {
		w.Sessions.Flush()
	}
}

// Get 返回具有给定 id 的实体，若不存在则返回 nil。
func (w *World) Get(id int) *core.Entity { return w.State.Ents.Get(id) }

// Join 为一个连接创建新角色。须在世界 goroutine 上调用。
func (w *World) Join() *Session { return w.Sessions.Join() }

// Leave 移除会话的角色。须在世界 goroutine 上调用。
func (w *World) Leave(s *Session) { w.Sessions.Leave(s) }

// Input 应用一条客户端消息。须在世界 goroutine 上调用。
func (w *World) Input(s *Session, msg *pb.ClientMsg) { w.Sessions.Input(s, msg) }
