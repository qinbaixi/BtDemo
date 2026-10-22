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
	state *core.State
	grid  *aoi.Grid
	move  *move.System
	aiSys *ai.System
}

// New 创建生成系统。
func New(state *core.State, grid *aoi.Grid, moveSys *move.System, sys *ai.System) *System {
	return &System{state: state, grid: grid, move: moveSys, aiSys: sys}
}

// SpawnConfigured 放置 world.yaml 中列出的每个怪物和 NPC。
func (spawnSys *System) SpawnConfigured() {
	for _, spawnCfg := range spawnSys.state.Cfg.Spawns {
		for i := 0; i < spawnCfg.Count; i++ {
			x, y := spawnSys.state.Scatter(spawnCfg.X, spawnCfg.Y, spawnCfg.Spread)
			spawnSys.Template(spawnSys.state.Cfg.Templates[spawnCfg.Template], x, y)
		}
	}
}

// Template 根据模板在 (x, y) 处创建一个怪物或 NPC。
func (spawnSys *System) Template(template *config.Template, x, y float64) *core.Entity {
	entity := spawnSys.state.Ents.New()
	entity.Identity = core.Identity{
		ID:      entity.ID,
		Kind:    core.Kind(template.Kind),
		Name:    template.Name,
		Faction: template.Faction,
		Color:   template.Color,
		Model:   template.Model,
		Tmpl:    template,
	}
	entity.Radius = template.Radius
	x, y = spawnSys.move.FreeSpot(entity, x, y)
	entity.Transform = core.Transform{X: x, Y: y, HomeX: x, HomeY: y, Radius: template.Radius}
	entity.Level, entity.Base, entity.Speed = template.Level, template.Attrs, template.Speed
	entity.Skills = spawnSys.skills(template.Skills)
	attr.Init(entity)
	spawnSys.aiSys.Attach(entity, template.Tree)
	spawnSys.add(entity)
	return entity
}

// Player 在玩家出生点创建一个新的玩家角色。
func (spawnSys *System) Player() *core.Entity {
	player := spawnSys.state.Cfg.World.Player
	entity := spawnSys.state.Ents.New()
	entity.Identity = core.Identity{
		ID:      entity.ID,
		Kind:    core.KindPlayer,
		Faction: "player",
		Name:    fmt.Sprintf("%s%d", player.NamePrefix, entity.ID),
		Color:   player.Color,
		Model:   player.Model,
	}
	entity.Radius = player.Radius
	x, y := spawnSys.state.Scatter(player.Spawn.X, player.Spawn.Y, player.Spawn.Spread)
	x, y = spawnSys.move.FreeSpot(entity, x, y)
	entity.Transform = core.Transform{X: x, Y: y, HomeX: x, HomeY: y, Radius: player.Radius}
	entity.Level = 1
	entity.Base, entity.Growth, entity.Speed = player.Attrs, player.Growth, player.Speed
	for entity.Level < player.Level {
		attr.LevelUp(entity)
	}
	entity.Skills = spawnSys.skills(player.Skills)
	attr.Init(entity)
	spawnSys.add(entity)
	return entity
}

func (spawnSys *System) add(entity *core.Entity) {
	spawnSys.state.Ents.Add(entity)
	spawnSys.grid.Add(entity)
}

// Remove 将 e 永久移出世界。
func (spawnSys *System) Remove(entity *core.Entity) {
	spawnSys.grid.Remove(entity)
	spawnSys.state.Ents.Remove(entity)
}

func (spawnSys *System) skills(ids []string) []*config.Skill {
	out := make([]*config.Skill, 0, len(ids))
	for _, id := range ids {
		out = append(out, spawnSys.state.Cfg.Skills[id])
	}
	return out
}

// Tick 复活复活时间已到的死亡实体。
func (spawnSys *System) Tick() {
	now := spawnSys.state.Now()
	spawnSys.state.Ents.Each(func(entity *core.Entity) {
		if entity.Dead && now >= entity.RespawnAt {
			spawnSys.respawn(entity)
		}
	})
}

func (spawnSys *System) respawn(entity *core.Entity) {
	entity.Dead = false
	x, y := entity.HomeX, entity.HomeY
	if entity.Kind == core.KindPlayer {
		spawnAt := spawnSys.state.Cfg.World.Player.Spawn
		x, y = spawnSys.state.Scatter(spawnAt.X, spawnAt.Y, spawnAt.Spread)
	}
	entity.Cooldowns = map[string]float64{}
	entity.Steering = core.Steering{}
	entity.LastAttacker, entity.LastHitAt = 0, 0
	attr.Init(entity)
	spawnSys.aiSys.Reset(entity)
	spawnSys.move.Place(entity, x, y)
	spawnSys.state.Events.Emit(
		entity,
		&core.Event{Kind: pb.EventKind_RESPAWN.Enum(), Id: core.I32(entity.ID)},
	)
}
