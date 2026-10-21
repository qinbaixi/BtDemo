// Package spawn 负责创建怪物、NPC 和玩家，移除玩家，并
// 在复活延迟之后让死亡的实体复活。
package spawn

import (
	"fmt"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/ai"
	"github.com/qinbaixi/BtDemo/internal/game/aoi"
	"github.com/qinbaixi/BtDemo/internal/game/attr"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/move"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// System 创建并复活实体。
type System struct {
	s    *core.State
	grid *aoi.Grid
	move *move.System
	ai   *ai.System
}

// New 创建生成系统。
func New(s *core.State, grid *aoi.Grid, mv *move.System, a *ai.System) *System {
	return &System{s: s, grid: grid, move: mv, ai: a}
}

// SpawnConfigured 放置 world.yaml 中列出的每个怪物和 NPC。
func (sp *System) SpawnConfigured() {
	for _, at := range sp.s.Cfg.Spawns {
		for i := 0; i < at.Count; i++ {
			x, y := sp.s.Scatter(at.X, at.Y, at.Spread)
			sp.Template(sp.s.Cfg.Templates[at.Template], x, y)
		}
	}
}

// Template 根据模板在 (x, y) 处创建一个怪物或 NPC。
func (sp *System) Template(t *config.Template, x, y float64) *core.Entity {
	e := sp.s.Ents.New()
	e.Identity = core.Identity{ID: e.ID, Kind: core.Kind(t.Kind), Name: t.Name, Faction: t.Faction, Color: t.Color, Model: t.Model, Tmpl: t}
	e.Radius = t.Radius
	x, y = sp.move.FreeSpot(e, x, y)
	e.Transform = core.Transform{X: x, Y: y, HomeX: x, HomeY: y, Radius: t.Radius}
	e.Level, e.Base, e.Speed = t.Level, t.Attrs, t.Speed
	e.Skills = sp.skills(t.Skills)
	attr.Init(e)
	sp.ai.Attach(e, t.Tree)
	sp.add(e)
	return e
}

// Player 在玩家出生点创建一个新的玩家角色。
func (sp *System) Player() *core.Entity {
	p := sp.s.Cfg.World.Player
	e := sp.s.Ents.New()
	e.Identity = core.Identity{ID: e.ID, Kind: core.KindPlayer, Faction: "player", Name: fmt.Sprintf("%s%d", p.NamePrefix, e.ID), Color: p.Color, Model: p.Model}
	e.Radius = p.Radius
	x, y := sp.s.Scatter(p.Spawn.X, p.Spawn.Y, p.Spawn.Spread)
	x, y = sp.move.FreeSpot(e, x, y)
	e.Transform = core.Transform{X: x, Y: y, HomeX: x, HomeY: y, Radius: p.Radius}
	e.Level, e.Base, e.Growth, e.Speed = 1, p.Attrs, p.Growth, p.Speed
	for e.Level < p.Level {
		attr.LevelUp(e)
	}
	e.Skills = sp.skills(p.Skills)
	attr.Init(e)
	sp.add(e)
	return e
}

func (sp *System) add(e *core.Entity) {
	sp.s.Ents.Add(e)
	sp.grid.Add(e)
}

// Remove 将 e 永久移出世界。
func (sp *System) Remove(e *core.Entity) {
	sp.grid.Remove(e)
	sp.s.Ents.Remove(e)
}

func (sp *System) skills(ids []string) []*config.Skill {
	out := make([]*config.Skill, 0, len(ids))
	for _, id := range ids {
		out = append(out, sp.s.Cfg.Skills[id])
	}
	return out
}

// Tick 复活复活时间已到的死亡实体。
func (sp *System) Tick() {
	now := sp.s.Now()
	sp.s.Ents.Each(func(e *core.Entity) {
		if e.Dead && now >= e.RespawnAt {
			sp.respawn(e)
		}
	})
}

func (sp *System) respawn(e *core.Entity) {
	e.Dead = false
	x, y := e.HomeX, e.HomeY
	if e.Kind == core.KindPlayer {
		at := sp.s.Cfg.World.Player.Spawn
		x, y = sp.s.Scatter(at.X, at.Y, at.Spread)
	}
	e.Cooldowns = map[string]float64{}
	e.Steering = core.Steering{}
	e.LastAttacker, e.LastHitAt = 0, 0
	attr.Init(e)
	sp.ai.Reset(e)
	sp.move.Place(e, x, y)
	sp.s.Events.Emit(e, &core.Event{Kind: pb.EventKind_RESPAWN.Enum(), Id: core.I32(e.ID)})
}
