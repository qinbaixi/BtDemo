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
	sys *System
	E   *core.Entity
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
func (a *Agent) step(mult float64) float64 { return a.E.Attr.Speed * mult * a.sys.s.Clock.Dt }

// target 在 agent 当前的目标仍然存活时返回该目标；否则清除目标并返回 nil。
func (a *Agent) target() *core.Entity {
	t := a.sys.s.Ents.Get(a.E.Target)
	if !t.Alive() {
		a.E.Target = 0
		return nil
	}
	return t
}

// memFloat 从节点的临时内存中读取 float64，缺失时返回 0。
func memFloat(ctx *bt.Ctx, key string) float64 {
	v, _ := ctx.Mem[key].(float64)
	return v
}

// register 将 bt/owl-bt.json 中用到的每个任务、条件和服务绑定到游戏代码。
func (sys *System) register() {
	reg := sys.reg
	reg.Task("find_target", func(ctx *bt.Ctx) bt.Status {
		a := ctx.Agent.(*Agent)
		r := ctx.Node.Num("Range", 250)
		t := sys.combat.NearestHostile(a.E, r)
		if t == nil {
			ctx.Explain("%.0f 范围内没有敌人", r)
			return bt.Failure
		}
		a.E.Target = t.ID
		ctx.Explain("找到 %s，距离 %.0f", who(t), core.Dist(a.E, t))
		return bt.Success
	})

	reg.Task("clear_target", func(ctx *bt.Ctx) bt.Status {
		ctx.Agent.(*Agent).E.Target = 0
		return bt.Success
	})

	reg.Task("chase_target", func(ctx *bt.Ctx) bt.Status {
		a := ctx.Agent.(*Agent)
		t := a.target()
		if t == nil {
			ctx.Explain("目标已丢失")
			return bt.Failure
		}
		d, stop := core.EdgeDist(a.E, t), ctx.Node.Num("StopRange", 40)
		if d <= stop {
			ctx.Explain("已贴近 %s：距离 %.0f ≤ %.0f", who(t), d, stop)
			return bt.Success
		}
		sys.move.Toward(a.E, t.X, t.Y, a.step(1))
		ctx.Explain("追击 %s：距离 %.0f > %.0f", who(t), d, stop)
		return bt.Running
	})

	reg.Task("cast_skill", func(ctx *bt.Ctx) bt.Status {
		a := ctx.Agent.(*Agent)
		slot := int(ctx.Node.Num("Slot", 1))
		if slot < 1 || slot > len(a.E.Skills) {
			ctx.Explain("没有第 %d 个技能（共 %d 个）", slot, len(a.E.Skills))
			return bt.Failure
		}
		sk := a.E.Skills[slot-1]
		if err := sys.combat.Cast(a.E, sk, a.E.Target); err != nil {
			ctx.Explain("%s 放不出：%v", sk.Name, err)
			return bt.Failure
		}
		if t := sys.s.Ents.Get(a.E.Target); t != nil && ctx.Tracing() {
			ctx.Explain("对 %s 施放 %s", who(t), sk.Name)
		} else {
			ctx.Explain("施放 %s", sk.Name)
		}
		return bt.Success
	})

	reg.Task("wander", func(ctx *bt.Ctx) bt.Status {
		a := ctx.Agent.(*Agent)
		if ctx.Fresh {
			x, y := sys.s.Scatter(a.E.HomeX, a.E.HomeY, ctx.Node.Num("Radius", 120))
			x, y = sys.move.FreeSpot(a.E, x, y)
			ctx.Mem["x"], ctx.Mem["y"] = x, y
			ctx.Mem["until"] = ctx.Now + wanderTimeout
		}
		return sys.walkTo(ctx, a, wanderSpeed, "闲逛")
	})

	reg.Task("return_home", func(ctx *bt.Ctx) bt.Status {
		a := ctx.Agent.(*Agent)
		if !sys.move.Toward(a.E, a.E.HomeX, a.E.HomeY, a.step(returnHomeSpeed)) {
			ctx.Explain("回家中，离家 %.0f", a.E.HomeDist())
			return bt.Running
		}
		a.E.HP = a.E.Attr.MaxHP
		a.E.Target = 0
		ctx.Explain("到家，回满血并清除目标")
		return bt.Success
	})

	reg.Task("flee", func(ctx *bt.Ctx) bt.Status {
		a := ctx.Agent.(*Agent)
		if ctx.Fresh {
			threat := a.target()
			if threat == nil {
				if last := sys.s.Ents.Get(a.E.LastAttacker); last.Alive() {
					threat = last
				}
			}
			if threat == nil {
				ctx.Explain("没有可躲的威胁")
				return bt.Failure
			}
			dx, dy := a.E.X-threat.X, a.E.Y-threat.Y
			d := math.Hypot(dx, dy)
			if d < 1e-6 { // 正压在威胁目标上：任选一个方向
				ang := sys.s.Rand.Float64() * 2 * math.Pi
				dx, dy, d = math.Cos(ang), math.Sin(ang), 1
			}
			dist := ctx.Node.Num("Distance", 160)
			ctx.Mem["x"], ctx.Mem["y"] = sys.move.FreeSpot(a.E, a.E.X+dx/d*dist, a.E.Y+dy/d*dist)
			ctx.Mem["until"] = ctx.Now + fleeTimeout
			ctx.Explain("躲开 %s", who(threat))
		}
		return sys.walkTo(ctx, a, fleeSpeed, "逃跑")
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
		a := ctx.Agent.(*Agent)
		if text := ctx.Node.Str("Text", ""); text != "" {
			sys.s.Events.Emit(a.E, &core.Event{Kind: pb.EventKind_SAY.Enum(), Id: core.I32(a.E.ID), Text: proto.String(text)})
			ctx.Explain("说：%s", text)
		}
		return bt.Success
	})

	reg.Condition("has_target", func(ctx *bt.Ctx) bool {
		t := ctx.Agent.(*Agent).target()
		if t == nil {
			ctx.Explain("没有目标")
			return false
		}
		ctx.Explain("目标 %s", who(t))
		return true
	})

	reg.Condition("target_in_range", func(ctx *bt.Ctx) bool {
		a := ctx.Agent.(*Agent)
		t := a.target()
		if t == nil {
			ctx.Explain("没有目标")
			return false
		}
		d, r := core.EdgeDist(a.E, t), ctx.Node.Num("Range", 60)
		ctx.Explain("到 %s 的距离 %.0f %s %.0f", who(t), d, cmp(d <= r, "≤", ">"), r)
		return d <= r
	})

	reg.Condition("hp_below", func(ctx *bt.Ctx) bool {
		a := ctx.Agent.(*Agent)
		hp, p := a.E.HPRatio()*100, ctx.Node.Num("Percent", 30)
		ctx.Explain("生命 %.0f%% %s %.0f%%", hp, cmp(hp < p, "<", "≥"), p)
		return hp < p
	})

	reg.Condition("far_from_home", func(ctx *bt.Ctx) bool {
		a := ctx.Agent.(*Agent)
		d, lim := a.E.HomeDist(), ctx.Node.Num("Distance", 400)
		ctx.Explain("离家 %.0f %s %.0f", d, cmp(d > lim, ">", "≤"), lim)
		return d > lim
	})

	reg.Condition("was_attacked", func(ctx *bt.Ctx) bool {
		a := ctx.Agent.(*Agent)
		if a.E.LastAttacker == 0 {
			ctx.Explain("没被攻击过")
			return false
		}
		ago, lim := ctx.Now-a.E.LastHitAt, ctx.Node.Num("Seconds", 3)
		ctx.Explain("%.1fs 前受击 %s %.0fs", ago, cmp(ago <= lim, "≤", ">"), lim)
		return ago <= lim
	})

	reg.Service("update_target", func(ctx *bt.Ctx) {
		a := ctx.Agent.(*Agent)
		e := a.E
		r := ctx.Node.Num("Range", 250)
		if t := a.target(); t != nil && core.Dist(e, t) <= r*lostTargetFactor {
			ctx.Explain("保持目标 %s", who(t))
			return
		}
		e.Target = 0
		if atk := sys.s.Ents.Get(e.LastAttacker); atk.Alive() && sys.s.Hostile(e, atk) && ctx.Now-e.LastHitAt <= attackerWindow {
			e.Target = atk.ID
			ctx.Explain("改打攻击者 %s", who(atk))
			return
		}
		if t := sys.combat.NearestHostile(e, r); t != nil {
			e.Target = t.ID
			ctx.Explain("选最近的敌人 %s", who(t))
			return
		}
		ctx.Explain("%.0f 范围内没有敌人", r)
	})
}

// walkTo 让 agent 走向 ctx.Mem 里记的目的地（x、y），到达或超时（until）算成功。
func (sys *System) walkTo(ctx *bt.Ctx, a *Agent, speed float64, what string) bt.Status {
	x, y := memFloat(ctx, "x"), memFloat(ctx, "y")
	if sys.move.Toward(a.E, x, y, a.step(speed)) {
		ctx.Explain("%s到达 (%.0f, %.0f)", what, x, y)
		return bt.Success
	}
	if left := memFloat(ctx, "until") - ctx.Now; left > 0 {
		ctx.Explain("%s去 (%.0f, %.0f)，还剩 %.0f，%.1fs 后放弃", what, x, y, math.Hypot(x-a.E.X, y-a.E.Y), left)
		return bt.Running
	}
	ctx.Explain("%s超时，没走到 (%.0f, %.0f)", what, x, y)
	return bt.Success
}

// who 是调试说明里实体的写法，例如“史莱姆#12”。
func who(e *core.Entity) string { return fmt.Sprintf("%s#%d", e.Name, e.ID) }

// cmp 按比较结果挑一个符号。
func cmp(ok bool, yes, no string) string {
	if ok {
		return yes
	}
	return no
}
