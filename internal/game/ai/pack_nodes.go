package ai

import (
	"math"
	"slices"

	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/game/core"
)

// 狼群和首领用的节点（第一关「黑松林道」）：
//   - flank 包抄：同一个目标的几只狼按 ID 排好队，围着目标平均分站位，从四面扑上去；
//   - allies_near 身边有几个同伴（头狼同伴够多才嚎叫）；
//   - summon 召唤（首领叫狼），由场景接到关卡系统上，叫来的怪算在首领所在的房间里；
//   - set_phase / phase_at_least 首领的阶段：血量过线时设一次，之后的分支按阶段走。

// 包抄用的常量。
const (
	flankArrive  = 14.0 // 离站位这么近就算到了
	flankTimeout = 4.0  // 秒：绕太久（被挡住）就算了，直接扑上去
)

// SummonFunc 在 owner 周围 radius 处召唤 count 个模板 template 的怪，返回叫出来几个。由场景设置。
type SummonFunc func(owner *core.Entity, template string, count int, radius float64) int

// SetSummon 设置 summon 节点用的召唤函数（场景把关卡系统的召唤接进来）。
func (sys *System) SetSummon(summon SummonFunc) { sys.summon = summon }

// registerPack 注册狼群和首领的节点。
func (sys *System) registerPack() {
	reg := sys.reg

	reg.Task("flank", func(ctx *bt.Ctx) bt.Status {
		agent := ctx.Agent.(*Agent)
		entity := agent.Entity
		target := agent.target()
		if target == nil {
			ctx.Explain("没有目标")
			return bt.Failure
		}
		pack := sys.packOf(entity, target)
		index := slices.Index(pack, entity)
		if len(pack) < 2 {
			ctx.Explain("只有自己盯着 %s，不用包抄", who(target))
			return bt.Success
		}
		// 第一只（ID 最小）从它自己所在的方向上，其余的按顺序平均分开
		leader := pack[0]
		base := math.Atan2(leader.Y-target.Y, leader.X-target.X)
		angle := base + float64(index)*2*math.Pi/float64(len(pack))
		distance := ctx.Node.Num("Distance", 70)
		goalX := target.X + math.Cos(angle)*distance
		goalY := target.Y + math.Sin(angle)*distance
		degrees := math.Mod(float64(index)*360/float64(len(pack)), 360)
		if math.Hypot(entity.X-goalX, entity.Y-goalY) <= flankArrive {
			ctx.Explain("我是第 %d/%d 只，已绕到 %.0f° 的位置", index+1, len(pack), degrees)
			return bt.Success
		}
		if ctx.Fresh {
			ctx.Mem["until"] = ctx.Now + flankTimeout
		}
		if until, _ := ctx.Mem["until"].(float64); ctx.Now > until {
			ctx.Explain("绕了 %.0f 秒还没到站位，直接扑", flankTimeout)
			return bt.Success
		}
		sys.move.Toward(entity, goalX, goalY, agent.step(1.1))
		ctx.Explain("我是第 %d/%d 只，绕到 %s 的 %.0f° 方向", index+1, len(pack), who(target), degrees)
		return bt.Running
	})

	reg.Condition("allies_near", func(ctx *bt.Ctx) bool {
		entity := ctx.Agent.(*Agent).Entity
		radius, need := ctx.Node.Num("Range", 200), int(ctx.Node.Num("Count", 2))
		count := 0
		sys.state.Ents.Each(func(other *core.Entity) {
			if other != entity && other.Alive() && other.Faction == entity.Faction &&
				other.Kind == entity.Kind && core.Dist(entity, other) <= radius {
				count++
			}
		})
		ctx.Explain("%.0f 以内有 %d 个同伴 %s %d", radius, count, cmp(count >= need, "≥", "<"), need)
		return count >= need
	})

	reg.Task("summon", func(ctx *bt.Ctx) bt.Status {
		entity := ctx.Agent.(*Agent).Entity
		template := ctx.Node.Str("Template", "")
		count := int(ctx.Node.Num("Count", 1))
		if sys.summon == nil || sys.state.Cfg.Templates[template] == nil {
			ctx.Explain("召唤不了 %q", template)
			return bt.Failure
		}
		made := sys.summon(entity, template, count, ctx.Node.Num("Radius", 200))
		if made == 0 {
			ctx.Explain("周围没有地方放 %s", template)
			return bt.Failure
		}
		ctx.Explain("召唤了 %d 只 %s", made, sys.state.Cfg.Templates[template].Name)
		return bt.Success
	})

	reg.Task("set_phase", func(ctx *bt.Ctx) bt.Status {
		entity := ctx.Agent.(*Agent).Entity
		phase := int(ctx.Node.Num("Phase", 2))
		entity.Phase = phase
		ctx.Explain("进入第 %d 阶段", phase)
		return bt.Success
	})

	reg.Condition("phase_at_least", func(ctx *bt.Ctx) bool {
		entity := ctx.Agent.(*Agent).Entity
		phase := int(ctx.Node.Num("Phase", 2))
		current := max(1, entity.Phase)
		ctx.Explain("现在第 %d 阶段 %s %d", current, cmp(current >= phase, "≥", "<"), phase)
		return current >= phase
	})
}

// packOf 返回和 entity 同一个模板、活着、盯着同一个 target 的怪（含自己），按 ID 排好。
func (sys *System) packOf(entity, target *core.Entity) []*core.Entity {
	var pack []*core.Entity
	sys.state.Ents.Each(func(other *core.Entity) {
		if other.Alive() && other.Tmpl == entity.Tmpl && other.Target == target.ID {
			pack = append(pack, other)
		}
	})
	return pack
}
