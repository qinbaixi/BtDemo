// Package game is the game server's world. Each concern is a system in its
// own package; World only wires them together and runs them in order:
//
//	core     shared data: entities and their components, clock, event queue
//	aoi      nine-grid area of interest
//	attr     attribute formulas, experience and level ups
//	move     movement and map bounds
//	combat   skills, damage, buffs, death
//	ai       behavior trees from BtTree and the debug trace
//	spawn    creating monsters, NPCs and players, respawning
//	session  connected players: input, AOI sync, protocol
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
	"github.com/qinbaixi/BtDemo/internal/game/session"
	"github.com/qinbaixi/BtDemo/internal/game/spawn"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// Session is one connected player.
type Session = session.Session

// World owns all game state. Everything runs on the goroutine that calls Run;
// other goroutines talk to it through Do.
type World struct {
	State    *core.State
	Grid     *aoi.Grid
	Attr     *attr.System
	Move     *move.System
	Combat   *combat.System
	AI       *ai.System
	Spawn    *spawn.System
	Sessions *session.System

	inbox chan func()
}

// NewWorld builds every system, loads and validates the behavior trees and
// spawns the configured monsters and NPCs.
func NewWorld(cfg *config.Config, seed int64) (*World, error) {
	w := &World{State: core.NewState(cfg, seed), inbox: make(chan func(), 256)}
	w.Grid = aoi.NewGrid(cfg.World.Map.Width, cfg.World.Map.Height, cfg.World.AOI.Cell)
	w.Attr = attr.New(w.State)
	w.Move = move.New(w.State, w.Grid)
	w.Combat = combat.New(w.State, w.Grid, w.Attr)
	var err error
	if w.AI, err = ai.New(w.State, w.Combat, w.Move); err != nil {
		return nil, err
	}
	w.Spawn = spawn.New(w.State, w.Grid, w.Move, w.AI)
	w.Sessions = session.New(w.State, w.Grid, w.Combat, w.AI, w.Spawn)
	w.Spawn.SpawnConfigured()
	return w, nil
}

// TreeNames lists the behavior trees compiled into the binary.
func TreeNames() map[string]bool { return ai.TreeNames() }

// Do runs fn on the world goroutine.
func (w *World) Do(fn func()) { w.inbox <- fn }

// Run advances the world until ctx is done.
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

// Step advances the world by one tick.
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

// Get returns the entity with the given id, or nil.
func (w *World) Get(id int) *core.Entity { return w.State.Ents.Get(id) }

// Join creates a new character for a connection. Call it on the world goroutine.
func (w *World) Join() *Session { return w.Sessions.Join() }

// Leave removes a session's character. Call it on the world goroutine.
func (w *World) Leave(s *Session) { w.Sessions.Leave(s) }

// Input applies a client message. Call it on the world goroutine.
func (w *World) Input(s *Session, msg *pb.ClientMsg) { w.Sessions.Input(s, msg) }
