package ai

import (
	"fmt"
	"math"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// Agent 是行为树运行时传给处理器的对象（ctx.Agent）。
type Agent struct {
	sys    *System
	Entity *core.Entity
}

// 移动任务使用的速度倍率和超时时间。
const (
	wanderSpeed      = 0.5
	wanderTimeout    = 6.0 // 秒
	returnHomeSpeed  = 1.5
	fleeSpeed        = 1.2
	fleeTimeout      = 4.0 // 秒
	attackerWindow   = 5.0 // 受击后，攻击者保持为优先目标的秒数
	lostTargetFactor = 2.0 // 距离超过 Range*lostTargetFactor 的目标会被丢弃
)

// step 返回本 tick 内 agent 以给定速度倍率可以移动的距离。
func (agent *Agent) step(mult float64) float64 {
	return agent.Entity.Attr.Speed * mult * agent.sys.state.Clock.Dt
}

// target 在 agent 当前的目标仍然存活时返回该目标；否则清除目标并返回 nil。
func (agent *Agent) target() *core.Entity {
	target := agent.sys.state.Ents.Get(agent.Entity.Target)
	if !target.Alive() {
		agent.Entity.Target = 0
		return nil
	}
	return target
}

// memFloat 从节点的临时内存中读取 float64，缺失时返回 0。
func memFloat(ctx *bt.Ctx, key string) float64 {
	value, _ := ctx.Mem[key].(float64)
	return value
}

// register 将 bt/owl-bt.json 中用到的每个任务、条件和服务绑定到游戏代码。
func (sys *System) register() {
	reg := sys.reg
	reg.Task("find_target", func(ctx *bt.Ctx) bt.Status {
		agent := ctx.Agent.(*Agent)
		radius := ctx.Node.Num("Range", 250)
		target := sys.combat.NearestHostile(agent.Entity, radius)
		if target == nil {
			ctx.Explain("%.0f 范围内没有敌人", radius)
			return bt.Failure
		}
		agent.Entity.Target = target.ID
		ctx.Explain("找到 %s，距离 %.0f", who(target), core.Dist(agent.Entity, target))
		return bt.Success
	})

	reg.Task("clear_target", func(ctx *bt.Ctx) bt.Status {
		ctx.Agent.(*Agent).Entity.Target = 0
		return bt.Success
	})

	reg.Task("chase_target", func(ctx *bt.Ctx) bt.Status {
		agent := ctx.Agent.(*Agent)
		target := agent.target()
		if target == nil {
			ctx.Explain("目标已丢失")
			return bt.Failure
		}
		dist, stop := core.EdgeDist(agent.Entity, target), ctx.Node.Num("StopRange", 40)
		if dist <= stop {
			ctx.Explain("已贴近 %s：距离 %.0f ≤ %.0f", who(target), dist, stop)
			return bt.Success
		}
		sys.move.Toward(agent.Entity, target.X, target.Y, agent.step(1))
		ctx.Explain("追击 %s：距离 %.0f > %.0f", who(target), dist, stop)
		return bt.Running
	})

	reg.Task("cast_skill", func(ctx *bt.Ctx) bt.Status {
		agent := ctx.Agent.(*Agent)
		slot := int(ctx.Node.Num("Slot", 1))
		if slot < 1 || slot > len(agent.Entity.Skills) {
			ctx.Explain("没有第 %d 个技能（共 %d 个）", slot, len(agent.Entity.Skills))
			return bt.Failure
		}
		skill := agent.Entity.Skills[slot-1]
		if err := sys.combat.Cast(agent.Entity, skill, agent.Entity.Target); err != nil {
			ctx.Explain("%s 放不出：%v", skill.Name, err)
			return bt.Failure
		}
		if target := sys.state.Ents.Get(agent.Entity.Target); target != nil && ctx.Tracing() {
			ctx.Explain("对 %s 施放 %s", who(target), skill.Name)
		} else {
			ctx.Explain("施放 %s", skill.Name)
		}
		return bt.Success
	})

	reg.Task("wander", func(ctx *bt.Ctx) bt.Status {
		agent := ctx.Agent.(*Agent)
		if ctx.Fresh {
			x, y := sys.state.Scatter(
				agent.Entity.HomeX,
				agent.Entity.HomeY,
				ctx.Node.Num("Radius", 120),
			)
			x, y = sys.move.FreeSpot(agent.Entity, x, y)
			ctx.Mem["x"], ctx.Mem["y"] = x, y
			ctx.Mem["until"] = ctx.Now + wanderTimeout
		}
		return sys.walkTo(ctx, agent, wanderSpeed, "闲逛")
	})

	reg.Task("return_home", func(ctx *bt.Ctx) bt.Status {
		agent := ctx.Agent.(*Agent)
		if !sys.move.Toward(
			agent.Entity,
			agent.Entity.HomeX,
			agent.Entity.HomeY,
			agent.step(returnHomeSpeed),
		) {
			ctx.Explain("回家中，离家 %.0f", agent.Entity.HomeDist())
			return bt.Running
		}
		agent.Entity.HP = agent.Entity.Attr.MaxHP
		agent.Entity.Target = 0
		ctx.Explain("到家，回满血并清除目标")
		return bt.Success
	})

	reg.Task("flee", func(ctx *bt.Ctx) bt.Status {
		agent := ctx.Agent.(*Agent)
		if ctx.Fresh {
			threat := agent.target()
			if threat == nil {
				if last := sys.state.Ents.Get(agent.Entity.LastAttacker); last.Alive() {
					threat = last
				}
			}
			if threat == nil {
				ctx.Explain("没有可躲的威胁")
				return bt.Failure
			}
			dx, dy := agent.Entity.X-threat.X, agent.Entity.Y-threat.Y
			length := math.Hypot(dx, dy)
			if length < 1e-6 { // 正压在威胁目标上：任选一个方向
				ang := sys.state.Rand.Float64() * 2 * math.Pi
				dx, dy, length = math.Cos(ang), math.Sin(ang), 1
			}
			dist := ctx.Node.Num("Distance", 160)
			ctx.Mem["x"], ctx.Mem["y"] = sys.move.FreeSpot(
				agent.Entity,
				agent.Entity.X+dx/length*dist,
				agent.Entity.Y+dy/length*dist,
			)
			ctx.Mem["until"] = ctx.Now + fleeTimeout
			ctx.Explain("躲开 %s", who(threat))
		}
		return sys.walkTo(ctx, agent, fleeSpeed, "逃跑")
	})

	reg.Task("wait", func(ctx *bt.Ctx) bt.Status {
		if ctx.Fresh {
			ctx.Mem["until"] = ctx.Now + ctx.Node.Num("Seconds", 1)
		}
		if left := memFloat(ctx, "until") - ctx.Now; left > 0 {
			ctx.Explain("还要等 %.1fs", left)
			return bt.Running
		}
		return bt.Success
	})

	reg.Task("say", func(ctx *bt.Ctx) bt.Status {
		agent := ctx.Agent.(*Agent)
		if text := ctx.Node.Str("Text", ""); text != "" {
			sys.state.Events.Emit(
				agent.Entity,
				&core.Event{
					Kind: pb.EventKind_SAY.Enum(),
					Id:   core.I32(agent.Entity.ID),
					Text: proto.String(text),
				},
			)
			ctx.Explain("说：%s", text)
		}
		return bt.Success
	})

	reg.Condition("has_target", func(ctx *bt.Ctx) bool {
		target := ctx.Agent.(*Agent).target()
		if target == nil {
			ctx.Explain("没有目标")
			return false
		}
		ctx.Explain("目标 %s", who(target))
		return true
	})

	reg.Condition("target_in_range", func(ctx *bt.Ctx) bool {
		agent := ctx.Agent.(*Agent)
		target := agent.target()
		if target == nil {
			ctx.Explain("没有目标")
			return false
		}
		dist, attackRange := core.EdgeDist(agent.Entity, target), ctx.Node.Num("Range", 60)
		ctx.Explain(
			"到 %s 的距离 %.0f %s %.0f",
			who(target),
			dist,
			cmp(dist <= attackRange, "≤", ">"),
			attackRange,
		)
		return dist <= attackRange
	})

	reg.Condition("hp_below", func(ctx *bt.Ctx) bool {
		agent := ctx.Agent.(*Agent)
		hpPct, threshold := agent.Entity.HPRatio()*100, ctx.Node.Num("Percent", 30)
		ctx.Explain("生命 %.0f%% %s %.0f%%", hpPct, cmp(hpPct < threshold, "<", "≥"), threshold)
		return hpPct < threshold
	})

	reg.Condition("far_from_home", func(ctx *bt.Ctx) bool {
		agent := ctx.Agent.(*Agent)
		dist, lim := agent.Entity.HomeDist(), ctx.Node.Num("Distance", 400)
		ctx.Explain("离家 %.0f %s %.0f", dist, cmp(dist > lim, ">", "≤"), lim)
		return dist > lim
	})

	reg.Condition("was_attacked", func(ctx *bt.Ctx) bool {
		agent := ctx.Agent.(*Agent)
		if agent.Entity.LastAttacker == 0 {
			ctx.Explain("没被攻击过")
			return false
		}
		ago, lim := ctx.Now-agent.Entity.LastHitAt, ctx.Node.Num("Seconds", 3)
		ctx.Explain("%.1fs 前受击 %s %.0fs", ago, cmp(ago <= lim, "≤", ">"), lim)
		return ago <= lim
	})

	reg.Service("update_target", func(ctx *bt.Ctx) {
		agent := ctx.Agent.(*Agent)
		entity := agent.Entity
		radius := ctx.Node.Num("Range", 250)
		if target := agent.target(); target != nil &&
			core.Dist(entity, target) <= radius*lostTargetFactor {
			ctx.Explain("保持目标 %s", who(target))
			return
		}
		entity.Target = 0
		if atk := sys.state.Ents.Get(entity.LastAttacker); atk.Alive() &&
			sys.state.Hostile(entity, atk) &&
			ctx.Now-entity.LastHitAt <= attackerWindow {
			entity.Target = atk.ID
			ctx.Explain("改打攻击者 %s", who(atk))
			return
		}
		if target := sys.combat.NearestHostile(entity, radius); target != nil {
			entity.Target = target.ID
			ctx.Explain("选最近的敌人 %s", who(target))
			return
		}
		ctx.Explain("%.0f 范围内没有敌人", radius)
	})
}

// walkTo 让 agent 走向 ctx.Mem 里记的目的地（x、y），到达或超时（until）算成功。
func (sys *System) walkTo(ctx *bt.Ctx, agent *Agent, speed float64, what string) bt.Status {
	x, y := memFloat(ctx, "x"), memFloat(ctx, "y")
	if sys.move.Toward(agent.Entity, x, y, agent.step(speed)) {
		ctx.Explain("%s到达 (%.0f, %.0f)", what, x, y)
		return bt.Success
	}
	if left := memFloat(ctx, "until") - ctx.Now; left > 0 {
		ctx.Explain(
			"%s去 (%.0f, %.0f)，还剩 %.0f，%.1fs 后放弃",
			what,
			x,
			y,
			math.Hypot(x-agent.Entity.X, y-agent.Entity.Y),
			left,
		)
		return bt.Running
	}
	ctx.Explain("%s超时，没走到 (%.0f, %.0f)", what, x, y)
	return bt.Success
}

// who 是调试说明里实体的写法，例如“史莱姆#12”。
func who(entity *core.Entity) string { return fmt.Sprintf("%s#%d", entity.Name, entity.ID) }

// cmp 按比较结果挑一个符号。
func cmp(ok bool, yes, no string) string {
	if ok {
		return yes
	}
	return no
}
