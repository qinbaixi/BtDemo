package ai

import (
	"math"

	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/game/core"
)

// 骷髅兵和骨堆用的节点（第二关「亡者地穴」）：
//   - raise_shield / lower_shield 举盾、放盾：和玩家的格挡是同一套规则（只挡正面、扣架势、能被打破）；
//   - facing_shield 目标举着盾、盾正对着我（从正面打会被挡住）；
//   - flank_shield 绕到目标的盾侧面去，从盾挡不住的方向打；
//   - skill_ready 第 Slot 个技能冷却好了（先确认能出手再放盾，不然盾放下又举起来）；
//   - reassemble 骨堆重新站起来变回骷髅兵，由场景接到关卡系统上。

// 绕盾用的常量。
const (
	flankShieldArrive  = 12.0 // 离侧面站位这么近就算到了
	flankShieldTimeout = 2.5  // 秒：绕太久（目标一直转身）就算了，硬打
)

// ReassembleFunc 让骨堆 pile 重新站起来，站起来的怪盯着 target；返回站起来的怪，站不起来返回 nil。由场景设置。
type ReassembleFunc func(pile *core.Entity, target int) *core.Entity

// SetReassemble 设置 reassemble 节点用的函数（场景把关卡系统的 Reassemble 接进来）。
func (sys *System) SetReassemble(reassemble ReassembleFunc) { sys.reassemble = reassemble }

// registerCrypt 注册骷髅兵和骨堆的节点。
func (sys *System) registerCrypt() {
	reg := sys.reg

	reg.Task("raise_shield", func(ctx *bt.Ctx) bt.Status {
		entity := ctx.Agent.(*Agent).Entity
		if entity.Blocking {
			ctx.Explain("盾已经举着")
			return bt.Success
		}
		if !sys.combat.RaiseBlock(entity, true, 0) {
			ctx.Explain("举不起盾（破防了，架势还没回来）")
			return bt.Failure
		}
		ctx.Explain("举盾")
		return bt.Success
	})

	reg.Task("lower_shield", func(ctx *bt.Ctx) bt.Status {
		entity := ctx.Agent.(*Agent).Entity
		if entity.Blocking {
			sys.combat.RaiseBlock(entity, false, 0)
			ctx.Explain("放下盾，准备出手")
		}
		return bt.Success
	})

	reg.Condition("facing_shield", func(ctx *bt.Ctx) bool {
		agent := ctx.Agent.(*Agent)
		target := agent.target()
		if target == nil {
			ctx.Explain("没有目标")
			return false
		}
		if !target.Blocking {
			ctx.Explain("%s 没举盾", who(target))
			return false
		}
		if !sys.combat.ShieldCovers(target, agent.Entity) {
			ctx.Explain("%s 举着盾，但盾没朝着我", who(target))
			return false
		}
		ctx.Explain("%s 的盾正对着我", who(target))
		return true
	})

	reg.Task("flank_shield", func(ctx *bt.Ctx) bt.Status {
		agent := ctx.Agent.(*Agent)
		entity := agent.Entity
		target := agent.target()
		if target == nil {
			ctx.Explain("没有目标")
			return bt.Failure
		}
		if !target.Blocking || !sys.combat.ShieldCovers(target, entity) {
			ctx.Explain("已经在 %s 的盾挡不到的地方", who(target))
			return bt.Success
		}
		if ctx.Fresh {
			ctx.Mem["until"] = ctx.Now + flankShieldTimeout
		}
		if ctx.Now > memFloat(ctx, "until") {
			ctx.Explain("绕了 %.1f 秒绕不过去，硬打", flankShieldTimeout)
			return bt.Success
		}
		// 盾朝向的垂直方向，挑离自己近的那一侧
		facing := sys.combat.ShieldFacing(target)
		sideX, sideY := -facing.Y, facing.X
		if (entity.X-target.X)*sideX+(entity.Y-target.Y)*sideY < 0 {
			sideX, sideY = -sideX, -sideY
		}
		distance := ctx.Node.Num("Distance", 50) + entity.Radius + target.Radius
		// 稍微偏到盾的后面一点，盾转过来时也还在挡不到的地方
		goalX := target.X + (sideX-facing.X*0.4)*distance
		goalY := target.Y + (sideY-facing.Y*0.4)*distance
		if math.Hypot(entity.X-goalX, entity.Y-goalY) <= flankShieldArrive {
			ctx.Explain("绕到 %s 的盾侧面了", who(target))
			return bt.Success
		}
		sys.move.Toward(entity, goalX, goalY, agent.step(1.2))
		ctx.Explain("%s 举着盾，绕到侧面去", who(target))
		return bt.Running
	})

	reg.Condition("skill_ready", func(ctx *bt.Ctx) bool {
		entity := ctx.Agent.(*Agent).Entity
		slot := int(ctx.Node.Num("Slot", 1))
		if slot < 1 || slot > len(entity.Skills) {
			ctx.Explain("没有第 %d 个技能", slot)
			return false
		}
		skill := entity.Skills[slot-1]
		if left := entity.Cooldowns[skill.ID] - sys.state.Now(); left > 0 {
			ctx.Explain("%s 还在冷却（%d 毫秒）", skill.Name, left)
			return false
		}
		ctx.Explain("%s 可以用了", skill.Name)
		return true
	})

	reg.Task("reassemble", func(ctx *bt.Ctx) bt.Status {
		agent := ctx.Agent.(*Agent)
		if sys.reassemble == nil {
			ctx.Explain("这个场景不能重组")
			return bt.Failure
		}
		target := sys.combat.NearestHostile(agent.Entity, ctx.Node.Num("Range", 400))
		targetID := 0
		if target != nil {
			targetID = target.ID
		}
		risen := sys.reassemble(agent.Entity, targetID)
		if risen == nil {
			ctx.Explain("重组不了")
			return bt.Failure
		}
		ctx.Explain("骨头拼回去了，站起来的是 %s", who(risen))
		return bt.Success
	})
}
