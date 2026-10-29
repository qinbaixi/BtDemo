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
			x, y := sys.state.ScatterAround(config.Point{X: spawnCfg.X, Y: spawnCfg.Y, Spread: spawnCfg.Spread})
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
	entity.Radius = float64(template.Radius)
	x, y = sys.move.FreeSpot(entity, x, y)
	entity.Transform = core.Transform{X: x, Y: y, HomeX: x, HomeY: y, Radius: entity.Radius}
	entity.Level, entity.Speed = template.Level, template.Speed
	entity.Born, entity.Base = template.Attrs, template.Attrs
	entity.Skills = sys.skills(template.Skills)
	attr.Init(entity)
	sys.aiSys.Attach(entity, template.Tree)
	sys.add(entity)
	return entity
}

// Player 在玩家出生点创建一个新的玩家角色，职业是默认职业（world.yaml 里的第一个）。
func (sys *System) Player() *core.Entity {
	player := sys.state.Cfg.World.Player
	class := player.DefaultClass()
	entity := sys.state.Ents.New()
	entity.Identity = core.Identity{
		ID:      entity.ID,
		Kind:    core.KindPlayer,
		Faction: "player",
		Name:    fmt.Sprintf("%s%d", player.NamePrefix, entity.ID),
	}
	entity.Radius = float64(class.Radius)
	x, y := sys.state.ScatterAround(player.Spawn)
	x, y = sys.move.FreeSpot(entity, x, y)
	entity.Transform = core.Transform{X: x, Y: y, HomeX: x, HomeY: y, Radius: entity.Radius}
	entity.SetLevel(max(1, player.Level))
	sys.ApplyClass(entity, class)
	attr.Init(entity)
	sys.add(entity)
	return entity
}

// ApplyClass 把玩家 entity 换成职业 class：外观（皮肤重置为职业默认）、半径、移速、成长和技能换成职业的，
// 基础属性按职业的初始值加上当前等级的成长重新算出，血量按比例保留。
// 冷却和格挡状态被清掉（不能格挡的职业不会留在格挡里）；位置不变，所以 AOI 格子不用动。
func (sys *System) ApplyClass(entity *core.Entity, class *config.Class) {
	entity.Class = class.ID
	entity.Model, entity.Color = class.Model, class.Color
	entity.Skin = class.DefaultSkin()
	entity.Radius = float64(class.Radius)
	entity.Born, entity.Growth, entity.Speed = class.Attrs, class.Growth, class.Speed
	entity.Base = class.Attrs.Grown(class.Growth, entity.Level-1)
	entity.Skills = sys.skills(class.Skills)
	entity.Cooldowns = map[string]config.Millis{}
	// 现在只有刚进游戏和死亡期间能换职业，那时身上没有 Buff；以后放宽了也别把上个职业的 Buff 带过来
	entity.Buffs = nil
	entity.MarkDirty(core.DirtyShield | core.DirtyLooks)
	if !class.CanBlock {
		entity.SetBlocking(false)
	}
	attr.Recalc(entity)
}

// Place 把从别的场景过来的实体放进这个场景，落在 (x, y) 附近的空地上（加入网格时周围的玩家收到 Enter）。
func (sys *System) Place(entity *core.Entity, x, y float64) {
	x, y = sys.move.FreeSpot(entity, x, y)
	entity.X, entity.Y = x, y
	entity.HomeX, entity.HomeY = x, y
	sys.add(entity)
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

// Tick 复活复活时间已到的死亡实体（宠物由 pet 包复活）。
func (sys *System) Tick() {
	now := sys.state.Now()
	sys.state.Ents.Each(func(entity *core.Entity) {
		if entity.Dead && entity.Kind != core.KindPet && now >= entity.RespawnAt {
			sys.respawn(entity)
		}
	})
}

func (sys *System) respawn(entity *core.Entity) {
	entity.SetDead(false)
	entity.Impact = core.Impact{} // 尸体被打飞的那段击退不能带到复活之后
	x, y := entity.HomeX, entity.HomeY
	if entity.Kind == core.KindPlayer {
		entity.MarkDirty(core.DirtyGuard) // 架势也回满了
		spawnAt := sys.state.Cfg.World.Player.Spawn
		x, y = sys.state.ScatterAround(spawnAt)
	}
	entity.Cooldowns = map[string]config.Millis{}
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
