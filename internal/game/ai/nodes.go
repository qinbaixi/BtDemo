package ai

import (
	"math"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// Agent is what the behavior tree runtime passes to handlers (ctx.Agent).
type Agent struct {
	sys *System
	E   *core.Entity
}

// Speed multipliers and timeouts used by the movement tasks.
const (
	wanderSpeed      = 0.5
	wanderTimeout    = 6.0 // seconds
	returnHomeSpeed  = 1.5
	fleeSpeed        = 1.2
	fleeTimeout      = 4.0 // seconds
	attackerWindow   = 5.0 // seconds a hit keeps the attacker as the preferred target
	lostTargetFactor = 2.0 // a target farther than Range*lostTargetFactor is dropped
)

// step is how far the agent may move this tick at the given speed multiplier.
func (a *Agent) step(mult float64) float64 { return a.E.Attr.Speed * mult * a.sys.s.Clock.Dt }

// target returns the agent's current target if it is still alive. Otherwise it
// clears the target and returns nil.
func (a *Agent) target() *core.Entity {
	t := a.sys.s.Ents.Get(a.E.Target)
	if !t.Alive() {
		a.E.Target = 0
		return nil
	}
	return t
}

// memFloat reads a float64 from the node's scratch memory, or 0 when missing.
func memFloat(ctx *bt.Ctx, key string) float64 {
	v, _ := ctx.Mem[key].(float64)
	return v
}

// register binds every task, condition and service used by bt/owl-bt.json to game code.
func (sys *System) register() {
	reg := sys.reg
	reg.Task("find_target", func(ctx *bt.Ctx) bt.Status {
		a := ctx.Agent.(*Agent)
		t := sys.combat.NearestHostile(a.E, ctx.Node.Num("Range", 250))
		if t == nil {
			return bt.Failure
		}
		a.E.Target = t.ID
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
			return bt.Failure
		}
		if core.EdgeDist(a.E, t) <= ctx.Node.Num("StopRange", 40) {
			return bt.Success
		}
		sys.move.Toward(a.E, t.X, t.Y, a.step(1))
		return bt.Running
	})

	reg.Task("cast_skill", func(ctx *bt.Ctx) bt.Status {
		a := ctx.Agent.(*Agent)
		slot := int(ctx.Node.Num("Slot", 1))
		if slot < 1 || slot > len(a.E.Skills) {
			return bt.Failure
		}
		if sys.combat.Cast(a.E, a.E.Skills[slot-1], a.E.Target) != nil {
			return bt.Failure
		}
		return bt.Success
	})

	reg.Task("wander", func(ctx *bt.Ctx) bt.Status {
		a := ctx.Agent.(*Agent)
		if ctx.Fresh {
			x, y := sys.s.Scatter(a.E.HomeX, a.E.HomeY, ctx.Node.Num("Radius", 120))
			ctx.Mem["x"], ctx.Mem["y"] = x, y
			ctx.Mem["until"] = ctx.Now + wanderTimeout
		}
		arrived := sys.move.Toward(a.E, memFloat(ctx, "x"), memFloat(ctx, "y"), a.step(wanderSpeed))
		if arrived || ctx.Now >= memFloat(ctx, "until") {
			return bt.Success
		}
		return bt.Running
	})

	reg.Task("return_home", func(ctx *bt.Ctx) bt.Status {
		a := ctx.Agent.(*Agent)
		if !sys.move.Toward(a.E, a.E.HomeX, a.E.HomeY, a.step(returnHomeSpeed)) {
			return bt.Running
		}
		a.E.HP = a.E.Attr.MaxHP
		a.E.Target = 0
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
				return bt.Failure
			}
			dx, dy := a.E.X-threat.X, a.E.Y-threat.Y
			d := math.Hypot(dx, dy)
			if d < 1e-6 { // standing on top of the threat: pick any direction
				ang := sys.s.Rand.Float64() * 2 * math.Pi
				dx, dy, d = math.Cos(ang), math.Sin(ang), 1
			}
			dist := ctx.Node.Num("Distance", 160)
			ctx.Mem["x"], ctx.Mem["y"] = sys.move.Clamp(a.E, a.E.X+dx/d*dist, a.E.Y+dy/d*dist)
			ctx.Mem["until"] = ctx.Now + fleeTimeout
		}
		arrived := sys.move.Toward(a.E, memFloat(ctx, "x"), memFloat(ctx, "y"), a.step(fleeSpeed))
		if arrived || ctx.Now >= memFloat(ctx, "until") {
			return bt.Success
		}
		return bt.Running
	})

	reg.Task("wait", func(ctx *bt.Ctx) bt.Status {
		if ctx.Fresh {
			ctx.Mem["until"] = ctx.Now + ctx.Node.Num("Seconds", 1)
		}
		if ctx.Now >= memFloat(ctx, "until") {
			return bt.Success
		}
		return bt.Running
	})

	reg.Task("say", func(ctx *bt.Ctx) bt.Status {
		a := ctx.Agent.(*Agent)
		if text := ctx.Node.Str("Text", ""); text != "" {
			sys.s.Events.Emit(a.E, &core.Event{Kind: pb.EventKind_SAY.Enum(), Id: core.I32(a.E.ID), Text: proto.String(text)})
		}
		return bt.Success
	})

	reg.Condition("has_target", func(ctx *bt.Ctx) bool {
		return ctx.Agent.(*Agent).target() != nil
	})

	reg.Condition("target_in_range", func(ctx *bt.Ctx) bool {
		a := ctx.Agent.(*Agent)
		t := a.target()
		return t != nil && core.EdgeDist(a.E, t) <= ctx.Node.Num("Range", 60)
	})

	reg.Condition("hp_below", func(ctx *bt.Ctx) bool {
		a := ctx.Agent.(*Agent)
		return a.E.HPRatio()*100 < ctx.Node.Num("Percent", 30)
	})

	reg.Condition("far_from_home", func(ctx *bt.Ctx) bool {
		a := ctx.Agent.(*Agent)
		return a.E.HomeDist() > ctx.Node.Num("Distance", 400)
	})

	reg.Condition("was_attacked", func(ctx *bt.Ctx) bool {
		a := ctx.Agent.(*Agent)
		return a.E.LastAttacker != 0 && ctx.Now-a.E.LastHitAt <= ctx.Node.Num("Seconds", 3)
	})

	reg.Service("update_target", func(ctx *bt.Ctx) {
		a := ctx.Agent.(*Agent)
		e := a.E
		r := ctx.Node.Num("Range", 250)
		if t := a.target(); t != nil && core.Dist(e, t) <= r*lostTargetFactor {
			return
		}
		e.Target = 0
		if atk := sys.s.Ents.Get(e.LastAttacker); atk.Alive() && sys.s.Hostile(e, atk) && ctx.Now-e.LastHitAt <= attackerWindow {
			e.Target = atk.ID
			return
		}
		if t := sys.combat.NearestHostile(e, r); t != nil {
			e.Target = t.ID
		}
	})
}
