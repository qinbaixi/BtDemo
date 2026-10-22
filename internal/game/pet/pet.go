// Package pet 负责宠物：召唤、收回、换宠物（带冷却）、死后复活、跟随主人的等级，
// 以及主人死亡、断线时的处理。宠物是普通实体（kind = pet），行为由行为树驱动，
// 跟随和协助主人的节点在 ai 包里。
package pet

import (
	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/ai"
	"github.com/qinbaixi/BtDemo/internal/game/aoi"
	"github.com/qinbaixi/BtDemo/internal/game/attr"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/move"
	"github.com/qinbaixi/BtDemo/internal/game/spawn"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 换宠物被拒绝的原因（以提示消息发给玩家）。
const (
	ReasonCooldown = "宠物还在冷却"
	ReasonUnknown  = "没有这个宠物"
)

// 刚召唤出来的宠物站在主人身后偏一点的位置（像素）。
const (
	summonBehind = 40.0
	summonAside  = 24.0
)

// System 管理所有玩家的宠物。
type System struct {
	state *core.State
	grid  *aoi.Grid
	move  *move.System
	aiSys *ai.System
	spawn *spawn.System
}

// New 创建宠物系统。
func New(
	state *core.State,
	grid *aoi.Grid,
	moveSys *move.System,
	aiSys *ai.System,
	spawnSys *spawn.System,
) *System {
	return &System{state: state, grid: grid, move: moveSys, aiSys: aiSys, spawn: spawnSys}
}

// Default 是进游戏默认召唤的宠物（pets.yaml 的第一个）；一个宠物都没配时返回 nil。
func (sys *System) Default() *config.Pet {
	if len(sys.state.Cfg.Pets) == 0 {
		return nil
	}
	return sys.state.Cfg.Pets[0]
}

// Join 在玩家 owner 刚进游戏时召唤默认宠物。这次召唤不算换宠物，不占冷却。
func (sys *System) Join(owner *core.Entity) {
	if template := sys.Default(); template != nil {
		owner.PetID = template.ID
		sys.summon(owner, template)
	}
}

// Set 让玩家 owner 带上宠物 petID；petID 为空表示收回。换宠物（含收回）之后
// swap_cooldown 秒内不能再换。选的就是现在这只时什么都不做。
// 被拒绝时返回要提示给玩家的原因，否则返回空串。
func (sys *System) Set(owner *core.Entity, petID string) string {
	var template *config.Pet
	if petID != "" {
		if template = sys.state.Cfg.Pet(petID); template == nil {
			return ReasonUnknown
		}
	}
	if petID == owner.PetID {
		owner.PetDirty = true // 客户端点了同一张卡片：重发一次状态让它对上
		return ""
	}
	now := sys.state.Now()
	if now < owner.PetSwapAt {
		return ReasonCooldown
	}
	sys.Dismiss(owner)
	owner.PetID = petID
	owner.PetSwapAt = now + sys.state.Cfg.World.Pet.SwapCooldown
	owner.PetDirty = true
	if template != nil && !owner.Dead {
		sys.summon(owner, template)
	}
	return ""
}

// Dismiss 把玩家 owner 场上的宠物删掉（不改变他选的宠物，也不占冷却）。
// 主人死亡、换宠物和断线时调用。
func (sys *System) Dismiss(owner *core.Entity) {
	if pet := sys.state.Ents.Get(owner.PetEntity); pet != nil {
		sys.spawn.Remove(pet)
	}
	owner.PetEntity = 0
	owner.PetDeadSeen = false
	owner.PetDirty = true
}

// Tick 照看每个玩家的宠物：主人死了收回、主人活着而宠物不在场就召唤（主人复活之后）、
// 宠物死了通知主人并在复活时间到了之后在主人身边复活、宠物等级跟上主人。
func (sys *System) Tick() {
	sys.state.Ents.Each(func(owner *core.Entity) {
		if owner.Kind != core.KindPlayer || owner.PetID == "" {
			return
		}
		pet := sys.state.Ents.Get(owner.PetEntity)
		switch {
		case owner.Dead:
			if pet != nil {
				sys.Dismiss(owner)
			}
		case pet == nil:
			if template := sys.state.Cfg.Pet(owner.PetID); template != nil {
				sys.summon(owner, template)
			}
		case pet.Dead:
			if !owner.PetDeadSeen {
				owner.PetDeadSeen = true
				owner.PetDirty = true
			}
			if sys.state.Now() >= pet.RespawnAt {
				sys.revive(owner, pet)
			}
		default:
			sys.syncLevel(owner, pet)
		}
	})
}

// summon 在玩家 owner 身边创建宠物 template，并发召唤特效。
func (sys *System) summon(owner *core.Entity, template *config.Pet) *core.Entity {
	pet := sys.state.Ents.New()
	pet.Identity = core.Identity{
		ID:      pet.ID,
		Kind:    core.KindPet,
		Name:    template.Name,
		Faction: owner.Faction,
		Color:   template.Color,
		Model:   template.Model,
		Owner:   owner.ID,
		PetCfg:  template,
	}
	pet.Radius = template.Radius
	x, y := sys.spot(owner, pet)
	pet.Transform = core.Transform{X: x, Y: y, HomeX: x, HomeY: y, Radius: template.Radius}
	pet.Speed = template.Speed
	pet.Skills = make([]*config.Skill, 0, len(template.Skills))
	for _, id := range template.Skills {
		pet.Skills = append(pet.Skills, sys.state.Cfg.Skills[id])
	}
	sys.applyLevel(pet, owner.Level)
	attr.Init(pet)
	sys.aiSys.Attach(pet, template.Tree)
	sys.state.Ents.Add(pet)
	sys.grid.Add(pet)
	owner.PetEntity = pet.ID
	owner.PetDeadSeen = false
	owner.PetDirty = true
	sys.emitSummon(pet)
	return pet
}

// revive 让死去的宠物在主人身边满血复活。
func (sys *System) revive(owner, pet *core.Entity) {
	pet.Dead = false
	pet.Cooldowns = map[string]float64{}
	pet.Steering = core.Steering{}
	pet.LastAttacker, pet.LastHitAt = 0, 0
	sys.applyLevel(pet, owner.Level)
	attr.Init(pet)
	sys.aiSys.Reset(pet)
	x, y := sys.spot(owner, pet)
	sys.move.Place(pet, x, y)
	owner.PetDeadSeen = false
	owner.PetDirty = true
	sys.state.Events.Emit(
		pet,
		&core.Event{Kind: pb.EventKind_RESPAWN.Enum(), Id: core.I32(pet.ID)},
	)
	sys.emitSummon(pet)
}

// syncLevel 在主人升级后让宠物跟着刷新等级和属性。
func (sys *System) syncLevel(owner, pet *core.Entity) {
	if pet.Level != owner.Level {
		sys.applyLevel(pet, owner.Level)
		attr.Recalc(pet)
	}
}

// applyLevel 把宠物的等级设成 level，基础属性 = 模板 attrs + growth × (等级 - 1)。
func (sys *System) applyLevel(pet *core.Entity, level int) {
	level = max(1, level)
	template := pet.PetCfg
	steps := float64(level - 1)
	pet.Level = level
	pet.Growth = template.Growth
	pet.Base = config.Attrs{
		Str: template.Attrs.Str + template.Growth.Str*steps,
		Agi: template.Attrs.Agi + template.Growth.Agi*steps,
		Int: template.Attrs.Int + template.Growth.Int*steps,
		Vit: template.Attrs.Vit + template.Growth.Vit*steps,
	}
}

// spot 是宠物在主人身边的出场位置：主人身后偏一点，不会卡进障碍物。
func (sys *System) spot(owner, pet *core.Entity) (float64, float64) {
	return sys.move.FreeSpot(pet, owner.X-summonBehind, owner.Y+summonAside)
}

// emitSummon 发召唤特效事件：fx = pet_summon，(x, y) 是出现的位置。
func (sys *System) emitSummon(pet *core.Entity) {
	sys.state.Events.Emit(
		pet,
		&core.Event{
			Kind:  pb.EventKind_CAST.Enum(),
			Src:   core.I32(pet.ID),
			Fx:    proto.String(core.FXPetSummon),
			Color: proto.String(pet.Color),
			X:     core.F32(core.Round1(pet.X)),
			Y:     core.F32(core.Round1(pet.Y)),
		},
	)
}
