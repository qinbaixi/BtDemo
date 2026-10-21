// Package combat casts skills, computes and applies damage, heals, buffs and
// kills, and answers who is hostile to whom nearby.
package combat

import (
	"errors"
	"math"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/aoi"
	"github.com/qinbaixi/BtDemo/internal/game/attr"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// User-facing reasons a skill cannot be cast.
var (
	ErrDead     = errors.New("你已经死亡")
	ErrCooldown = errors.New("技能冷却中")
	ErrNoTarget = errors.New("没有有效目标")
	ErrTooFar   = errors.New("目标太远")
	ErrBadSkill = errors.New("未知的技能类型")
)

// System runs skills and damage.
type System struct {
	s    *core.State
	grid *aoi.Grid
	attr *attr.System
}

// New creates the combat system.
func New(s *core.State, grid *aoi.Grid, at *attr.System) *System {
	return &System{s: s, grid: grid, attr: at}
}

// Tick drops expired buffs.
func (c *System) Tick() {
	c.s.Ents.Each(func(e *core.Entity) {
		if !e.Dead {
			c.UpdateBuffs(e)
		}
	})
}

// UpdateBuffs drops expired buffs and recalculates e if any were removed.
func (c *System) UpdateBuffs(e *core.Entity) {
	now := c.s.Now()
	if filterBuffs(e, func(b *core.Buff) bool { return b.Until > now }) {
		attr.Recalc(e)
	}
}

// filterBuffs keeps the buffs for which keep returns true and reports whether any were dropped.
func filterBuffs(e *core.Entity, keep func(*core.Buff) bool) bool {
	kept := e.Buffs[:0]
	for _, b := range e.Buffs {
		if keep(b) {
			kept = append(kept, b)
		}
	}
	removed := len(kept) < len(e.Buffs)
	clear(e.Buffs[len(kept):]) // do not keep dropped buffs reachable from the backing array
	e.Buffs = kept
	return removed
}

// NearestHostile returns the closest living entity within r that e is hostile to.
func (c *System) NearestHostile(e *core.Entity, r float64) *core.Entity {
	return c.nearest(e, r, func(o *core.Entity) bool { return true })
}

// NearestMonster is NearestHostile limited to monsters, for a player's auto-target.
func (c *System) NearestMonster(e *core.Entity, r float64) *core.Entity {
	return c.nearest(e, r, func(o *core.Entity) bool { return o.Kind == core.KindMonster })
}

func (c *System) nearest(e *core.Entity, r float64, ok func(*core.Entity) bool) *core.Entity {
	var best *core.Entity
	bestD := math.Inf(1)
	c.grid.InRange(e.X, e.Y, r, func(o *core.Entity) {
		if o.Alive() && c.s.Hostile(e, o) && ok(o) {
			// ties go to the lower id so the result does not depend on map order
			if d := core.Dist(e, o); d < bestD || d == bestD && o.ID < best.ID {
				best, bestD = o, d
			}
		}
	})
	return best
}

// CalcDamage returns the damage src deals to dst with skill sk and whether it crit.
// Physical skills use Atk against Def, magic skills use MAtk against MDef.
func (c *System) CalcDamage(src, dst *core.Entity, sk *config.Skill) (float64, bool) {
	atk, def := src.Attr.Atk, dst.Attr.Def
	if sk.Damage == "magic" {
		atk, def = src.Attr.MAtk, dst.Attr.MDef
	}
	raw := atk*sk.Ratio + sk.Base
	dmg := raw * (1 - def/(def+100))
	crit := c.s.Rand.Float64() < src.Attr.Crit
	if crit {
		dmg *= src.Attr.CritDmg
	}
	dmg *= 0.95 + c.s.Rand.Float64()*0.1
	return math.Max(1, math.Round(dmg)), crit
}

// Cast makes e use skill sk. targetID is used for kind "target". It returns a
// user-facing error when the skill cannot be cast.
func (c *System) Cast(e *core.Entity, sk *config.Skill, targetID int) error {
	now := c.s.Now()
	if e.Dead {
		return ErrDead
	}
	if now < e.Cooldowns[sk.ID] {
		return ErrCooldown
	}
	switch sk.Kind {
	case "target":
		t := c.s.Ents.Get(targetID)
		if !t.Alive() || t == e || !c.s.Hostile(e, t) {
			return ErrNoTarget
		}
		if core.EdgeDist(e, t) > sk.Range {
			return ErrTooFar
		}
		c.s.Events.Emit(e, castEvent(e, t, sk))
		dmg, crit := c.CalcDamage(e, t, sk)
		c.applyDamage(e, t, dmg, crit, sk)
	case "aoe":
		ev := castEvent(e, nil, sk)
		ev.Radius, ev.X, ev.Y = core.F32(sk.Radius), core.F32(e.X), core.F32(e.Y)
		c.s.Events.Emit(e, ev)
		// Collect first so damage (and any kill it causes) never changes the grid mid-walk.
		var targets []*core.Entity
		// Candidates by center distance; the edge test below is exact.
		c.grid.InRange(e.X, e.Y, sk.Radius+e.Radius+core.MaxRadius, func(o *core.Entity) {
			if o.Alive() && c.s.Hostile(e, o) && core.EdgeDist(e, o) <= sk.Radius {
				targets = append(targets, o)
			}
		})
		for _, o := range targets {
			dmg, crit := c.CalcDamage(e, o, sk)
			c.applyDamage(e, o, dmg, crit, sk)
		}
	case "self":
		c.s.Events.Emit(e, castEvent(e, e, sk))
		if sk.Heal > 0 {
			amount := math.Round(e.Attr.MaxHP * sk.Heal)
			e.HP = math.Min(e.Attr.MaxHP, e.HP+amount)
			c.s.Events.Emit(e, &core.Event{Kind: pb.EventKind_HEAL.Enum(), Dst: core.I32(e.ID), Value: core.F32(amount)})
		}
		if sk.Buff != nil {
			// Recasting refreshes the buff instead of stacking it.
			filterBuffs(e, func(b *core.Buff) bool { return b.Cfg.Name != sk.Buff.Name })
			e.Buffs = append(e.Buffs, &core.Buff{Cfg: sk.Buff, Until: now + sk.Buff.Duration})
			attr.Recalc(e)
			c.s.Events.Emit(e, &core.Event{Kind: pb.EventKind_BUFF.Enum(), Dst: core.I32(e.ID), Name: &sk.Buff.Name, Dur: core.F32(sk.Buff.Duration)})
		}
	default:
		return ErrBadSkill
	}
	e.Cooldowns[sk.ID] = now + sk.Cooldown
	return nil
}

// applyDamage subtracts dmg from dst, records the attacker and kills dst at zero HP.
func (c *System) applyDamage(src, dst *core.Entity, dmg float64, crit bool, sk *config.Skill) {
	dst.HP -= dmg
	dst.LastAttacker = src.ID
	dst.LastHitAt = c.s.Now()
	c.s.Events.Emit(dst, &core.Event{Kind: pb.EventKind_DAMAGE.Enum(), Src: core.I32(src.ID), Dst: core.I32(dst.ID), Value: core.F32(dmg), Crit: &crit, Skill: &sk.ID})
	if dst.HP <= 0 {
		c.Kill(dst, src)
	}
}

// Kill marks e dead, schedules its respawn and rewards the killer.
func (c *System) Kill(e, killer *core.Entity) {
	if e.Dead {
		return
	}
	e.Dead = true
	e.HP = 0
	e.Target = 0
	e.Buffs = nil // MoveX/MoveY stay so a held key keeps working after respawn
	e.Action = ""
	c.s.Events.Emit(e, &core.Event{Kind: pb.EventKind_DIE.Enum(), Id: core.I32(e.ID)})
	delay := c.s.Cfg.World.Player.Respawn
	if e.Tmpl != nil {
		delay = e.Tmpl.Respawn
		if killer != nil && killer.Kind == core.KindPlayer {
			c.attr.GainExp(killer, e.Tmpl.Exp)
		}
	}
	e.RespawnAt = c.s.Now() + delay
	// The body stays in the grid so observers see it until it respawns.
}

// castEvent describes e using sk on dst (nil for an aoe skill).
func castEvent(e, dst *core.Entity, sk *config.Skill) *core.Event {
	ev := &core.Event{
		Kind: pb.EventKind_CAST.Enum(), Src: core.I32(e.ID), Skill: proto.String(sk.ID),
		Name: proto.String(sk.Name), Fx: proto.String(sk.FX), Color: proto.String(sk.Color),
	}
	if dst != nil {
		ev.Dst = core.I32(dst.ID)
	}
	return ev
}
