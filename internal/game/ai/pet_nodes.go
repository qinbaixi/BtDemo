package ai

import (
	"math"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 宠物节点用的常量。
const (
	ownerCombatWindow = 5.0  // 主人攻击或被攻击之后，多少秒内算“在战斗中”
	followStandFactor = 0.7  // 跟随时站在离主人 Distance 的这个比例处
	followSideAngle   = 0.7  // 主人在走时，宠物站在正后方偏这个弧度的一侧
	followCatchUp     = 1.3  // 落得很远时的追赶速度倍率
	followFarFactor   = 3.0  // 离主人超过 Distance 的几倍算“落得很远”
	tinyLength        = 1e-6 // 两点几乎重合时算不出方向，换一个固定方向
)

// registerPet 注册宠物行为树用的节点：守护主人的服务、跟随主人、保持距离、
// 对主人施放友方技能，以及关于主人的三个条件。
func (sys *System) registerPet() {
	reg := sys.reg

	reg.Task("follow_owner", func(ctx *bt.Ctx) bt.Status {
		agent := ctx.Agent.(*Agent)
		owner := agent.owner()
		if owner == nil {
			ctx.Explain("主人不在场")
			return bt.Failure
		}
		keep := ctx.Node.Num("Distance", 60)
		dist := core.Dist(agent.Entity, owner)
		if limit := sys.state.Cfg.World.Pet.Teleport; limit > 0 && dist > limit {
			sys.teleportToOwner(agent.Entity, owner, keep)
			ctx.Explain("离主人 %.0f > %.0f，传送到主人身边", dist, limit)
			return bt.Success
		}
		if dist <= keep {
			ctx.Explain("离主人 %.0f ≤ %.0f，不用动", dist, keep)
			return bt.Success
		}
		speed := 1.0
		if dist > keep*followFarFactor {
			speed = followCatchUp
		}
		goalX, goalY := followSpot(agent.Entity, owner, keep)
		arrived := sys.move.Toward(agent.Entity, goalX, goalY, agent.step(speed))
		dist = core.Dist(agent.Entity, owner)
		if arrived && dist > keep {
			// 走到了最近的可达位置还是离主人太远（隔着障碍）：返回失败，让树去做别的；
			// 真离得太远时会触发上面的传送
			ctx.Explain("走不到主人身边：最近只能到 %.0f > %.0f", dist, keep)
			return bt.Failure
		}
		ctx.Explain("跟随主人：距离 %.0f > %.0f", dist, keep)
		return bt.Running
	})

	reg.Task("keep_distance", func(ctx *bt.Ctx) bt.Status {
		agent := ctx.Agent.(*Agent)
		entity := agent.Entity
		target := agent.target()
		if target == nil {
			ctx.Explain("没有目标")
			return bt.Failure
		}
		low, high := ctx.Node.Num("Min", 120), ctx.Node.Num("Max", 220)
		dist := core.EdgeDist(entity, target)
		if dist >= low && dist <= high {
			ctx.Explain("到 %s 的距离 %.0f 在 %.0f ~ %.0f 之间", who(target), dist, low, high)
			return bt.Success
		}
		// 目标点在目标到宠物这条线上，离目标区间中点的距离：太近就在线上后退，太远就靠近
		dirX, dirY := entity.X-target.X, entity.Y-target.Y
		length := math.Hypot(dirX, dirY)
		if length < tinyLength {
			dirX, dirY, length = 1, 0, 1
		}
		stand := (low+high)/2 + entity.Radius + target.Radius
		goalX := target.X + dirX/length*stand
		goalY := target.Y + dirY/length*stand
		if sys.move.Toward(entity, goalX, goalY, agent.step(1)) {
			ctx.Explain("到 %s 的距离 %.0f，已到位置（区间 %.0f ~ %.0f）", who(target), dist, low, high)
			return bt.Success
		}
		ctx.Explain(
			"到 %s 的距离 %.0f %s，%s",
			who(target),
			dist,
			cmp(dist < low, "< 下限", "> 上限"),
			cmp(dist < low, "后退", "靠近"),
		)
		return bt.Running
	})

	reg.Task("cast_on_owner", func(ctx *bt.Ctx) bt.Status {
		agent := ctx.Agent.(*Agent)
		owner := agent.owner()
		if owner == nil {
			ctx.Explain("主人不在场")
			return bt.Failure
		}
		slot := int(ctx.Node.Num("Slot", 1))
		if slot < 1 || slot > len(agent.Entity.Skills) {
			ctx.Explain("没有第 %d 个技能（共 %d 个）", slot, len(agent.Entity.Skills))
			return bt.Failure
		}
		skill := agent.Entity.Skills[slot-1]
		if err := sys.combat.Cast(agent.Entity, skill, owner.ID); err != nil {
			ctx.Explain("%s 放不出：%v", skill.Name, err)
			return bt.Failure
		}
		ctx.Explain("对主人施放 %s", skill.Name)
		return bt.Success
	})

	reg.Condition("owner_far", func(ctx *bt.Ctx) bool {
		agent := ctx.Agent.(*Agent)
		owner := agent.owner()
		if owner == nil {
			ctx.Explain("主人不在场")
			return false
		}
		dist, limit := core.Dist(agent.Entity, owner), ctx.Node.Num("Distance", 350)
		ctx.Explain("离主人 %.0f %s %.0f", dist, cmp(dist > limit, ">", "≤"), limit)
		return dist > limit
	})

	reg.Condition("owner_hp_below", func(ctx *bt.Ctx) bool {
		owner := ctx.Agent.(*Agent).owner()
		if owner == nil {
			ctx.Explain("主人不在场")
			return false
		}
		hpPct, threshold := owner.HPRatio()*100, ctx.Node.Num("Percent", 60)
		ctx.Explain(
			"主人生命 %.0f%% %s %.0f%%",
			hpPct,
			cmp(hpPct < threshold, "<", "≥"),
			threshold,
		)
		return hpPct < threshold
	})

	reg.Condition("owner_in_combat", func(ctx *bt.Ctx) bool {
		owner := ctx.Agent.(*Agent).owner()
		if owner == nil {
			ctx.Explain("主人不在场")
			return false
		}
		hitAgo := ctx.Now - owner.LastHitAt
		dealtAgo := ctx.Now - owner.LastDealtAt
		hit := owner.LastAttacker != 0 && hitAgo <= ownerCombatWindow
		dealt := owner.LastDealtAt > 0 && dealtAgo <= ownerCombatWindow
		switch {
		case hit:
			ctx.Explain("主人 %.1fs 前被攻击", hitAgo)
		case dealt:
			ctx.Explain("主人 %.1fs 前出手", dealtAgo)
		default:
			ctx.Explain("主人 %.0fs 内没有战斗", ownerCombatWindow)
		}
		return hit || dealt
	})

	reg.Service("guard_owner", func(ctx *bt.Ctx) {
		agent := ctx.Agent.(*Agent)
		entity := agent.Entity
		owner := agent.owner()
		if owner == nil {
			entity.SetTarget(0)
			ctx.Explain("主人不在场，不选目标")
			return
		}
		radius, leash := ctx.Node.Num("Range", 300), ctx.Node.Num("Leash", 450)
		if target, reason := sys.guardTarget(entity, owner, radius, leash); target != nil {
			entity.SetTarget(target.ID)
			ctx.Explain("%s %s", reason, who(target))
			return
		}
		current := agent.target()
		switch {
		case current == nil:
			ctx.Explain("主人身边 %.0f 内没有敌人", radius)
		case core.Dist(owner, current) <= leash:
			ctx.Explain(
				"保持目标 %s，离主人 %.0f ≤ %.0f",
				who(current),
				core.Dist(owner, current),
				leash,
			)
			return
		default:
			ctx.Explain(
				"目标 %s 离主人 %.0f > %.0f，放弃",
				who(current),
				core.Dist(owner, current),
				leash,
			)
		}
		entity.SetTarget(0)
	})
}

// guardTarget 为宠物 pet 挑守护主人 owner 的目标，并返回挑它的原因；没有合适的目标返回 nil。
// 优先级：主人当前攻击的目标（敌对，离主人不超过 radius）> 最近 attackerWindow 秒内打过主人的
// 敌人（离主人不超过 leash）> 主人 radius 范围内最近的敌人。
func (sys *System) guardTarget(
	pet, owner *core.Entity,
	radius, leash float64,
) (*core.Entity, string) {
	if target := sys.state.Ents.Get(owner.Target); target.Alive() &&
		sys.state.Hostile(pet, target) && core.Dist(owner, target) <= radius {
		return target, "协助主人打"
	}
	if attacker := sys.state.Ents.Get(owner.LastAttacker); attacker.Alive() &&
		sys.state.Hostile(pet, attacker) &&
		sys.state.Now()-owner.LastHitAt <= attackerWindow &&
		core.Dist(owner, attacker) <= leash {
		return attacker, "对付打主人的"
	}
	if target := sys.combat.NearestHostile(owner, radius); target != nil {
		return target, "选主人身边最近的敌人"
	}
	return nil, ""
}

// followSpot 是宠物 pet 跟随主人 owner 时要站的位置，离主人 keep × followStandFactor：
// 主人在走时站在他侧后方（按宠物 ID 分左右），主人没动时就在宠物现在所在的那一侧。
func followSpot(pet, owner *core.Entity, keep float64) (float64, float64) {
	dirX, dirY := pet.X-owner.X, pet.Y-owner.Y
	if owner.MoveX != 0 || owner.MoveY != 0 {
		side := followSideAngle
		if pet.ID%2 == 0 {
			side = -followSideAngle
		}
		angle := math.Atan2(-owner.MoveY, -owner.MoveX) + side
		dirX, dirY = math.Cos(angle), math.Sin(angle)
	}
	length := math.Hypot(dirX, dirY)
	if length < tinyLength {
		dirX, dirY, length = -1, 0, 1
	}
	stand := keep * followStandFactor
	return owner.X + dirX/length*stand, owner.Y + dirY/length*stand
}

// teleportToOwner 把宠物 pet 直接传送到主人 owner 身边，并发 fx = pet_teleport 的 CAST 事件
// （(x, y) 是出发的位置，(tx, ty) 是到达的位置，和闪现一样）。
func (sys *System) teleportToOwner(pet, owner *core.Entity, keep float64) {
	fromX, fromY := pet.X, pet.Y
	goalX, goalY := followSpot(pet, owner, keep)
	sys.move.Stop(pet)
	sys.move.Place(pet, goalX, goalY)
	sys.state.Events.Emit(
		pet,
		&core.Event{
			Kind:  pb.EventKind_CAST.Enum(),
			Src:   core.I32(pet.ID),
			Fx:    proto.String(core.FXPetTeleport),
			Color: proto.String(pet.Color),
			X:     core.F32(core.Round1(fromX)),
			Y:     core.F32(core.Round1(fromY)),
			Tx:    core.F32(core.Round1(pet.X)),
			Ty:    core.F32(core.Round1(pet.Y)),
		},
	)
}
