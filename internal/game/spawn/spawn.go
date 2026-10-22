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
func New(state *core.State, grid *aoi.Grid, moveSys *move.System, aiSys *ai.System) *System {
	return &System{state: state, grid: grid, move: moveSys, aiSys: aiSys}
}

// SpawnConfigured 放置 world.yaml 中列出的每个怪物和 NPC。
func (sys *System) SpawnConfigured() {
	for _, spawnCfg := range sys.state.Cfg.Spawns {
		for i := 0; i < spawnCfg.Count; i++ {
			x, y := sys.state.Scatter(spawnCfg.X, spawnCfg.Y, spawnCfg.Spread)
			sys.Template(sys.state.Cfg.Templates[spawnCfg.Template], x, y)
		}
	}
}

// Template 根据模板在 (x, y) 处创建一个怪物或 NPC。
func (sys *System) Template(template *config.Template, x, y float64) *core.Entity {
	entity := sys.state.Ents.New()
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
	x, y = sys.move.FreeSpot(entity, x, y)
	entity.Transform = core.Transform{X: x, Y: y, HomeX: x, HomeY: y, Radius: template.Radius}
	entity.Level, entity.Base, entity.Speed = template.Level, template.Attrs, template.Speed
	entity.Skills = sys.skills(template.Skills)
	attr.Init(entity)
	sys.aiSys.Attach(entity, template.Tree)
	sys.add(entity)
	return entity
}

// Player 在玩家出生点创建一个新的玩家角色。
func (sys *System) Player() *core.Entity {
	player := sys.state.Cfg.World.Player
	entity := sys.state.Ents.New()
	entity.Identity = core.Identity{
		ID:      entity.ID,
		Kind:    core.KindPlayer,
		Faction: "player",
		Name:    fmt.Sprintf("%s%d", player.NamePrefix, entity.ID),
		Color:   player.Color,
		Model:   player.Model,
	}
	entity.Radius = player.Radius
	x, y := sys.state.Scatter(player.Spawn.X, player.Spawn.Y, player.Spawn.Spread)
	x, y = sys.move.FreeSpot(entity, x, y)
	entity.Transform = core.Transform{X: x, Y: y, HomeX: x, HomeY: y, Radius: player.Radius}
	entity.Level = 1
	entity.Base, entity.Growth, entity.Speed = player.Attrs, player.Growth, player.Speed
	for entity.Level < player.Level {
		attr.LevelUp(entity)
	}
	entity.Skills = sys.skills(player.Skills)
	attr.Init(entity)
	sys.add(entity)
	return entity
}

func (sys *System) add(entity *core.Entity) {
	sys.state.Ents.Add(entity)
	sys.grid.Add(entity)
}

// Remove 将 e 永久移出世界。
func (sys *System) Remove(entity *core.Entity) {
	sys.grid.Remove(entity)
	sys.state.Ents.Remove(entity)
}

func (sys *System) skills(ids []string) []*config.Skill {
	out := make([]*config.Skill, 0, len(ids))
	for _, id := range ids {
		out = append(out, sys.state.Cfg.Skills[id])
	}
	return out
}

// Tick 复活复活时间已到的死亡实体。
func (sys *System) Tick() {
	now := sys.state.Now()
	sys.state.Ents.Each(func(entity *core.Entity) {
		if entity.Dead && now >= entity.RespawnAt {
			sys.respawn(entity)
		}
	})
}

func (sys *System) respawn(entity *core.Entity) {
	entity.Dead = false
	x, y := entity.HomeX, entity.HomeY
	if entity.Kind == core.KindPlayer {
		spawnAt := sys.state.Cfg.World.Player.Spawn
		x, y = sys.state.Scatter(spawnAt.X, spawnAt.Y, spawnAt.Spread)
	}
	entity.Cooldowns = map[string]float64{}
	entity.Steering = core.Steering{}
	entity.LastAttacker, entity.LastHitAt = 0, 0
	attr.Init(entity)
	sys.aiSys.Reset(entity)
	sys.move.Place(entity, x, y)
	sys.state.Events.Emit(
		entity,
		&core.Event{Kind: pb.EventKind_RESPAWN.Enum(), Id: core.I32(entity.ID)},
	)
}
