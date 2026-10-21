// Package attr computes derived attributes and handles experience and level
// ups.
package attr

import (
	"math"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// Derived attribute formulas, with Str/Agi/Int/Vit the base attributes:
//
//	MaxHP   = 80 + Vit*12 + Str*2
//	Atk     = 8 + Str*2 + Agi*0.5
//	MAtk    = 8 + Int*2.5
//	Def     = 4 + Vit*1 + Str*0.5
//	MDef    = 4 + Int*1 + Vit*0.5
//	Crit    = min(0.6, 0.05 + Agi*0.004)
//	CritDmg = 1.5 + Agi*0.005
//	Speed   = base move speed
//
// Buffs then scale the results: Atk and MAtk by (1+ΣAtkPct), Def and MDef by
// (1+ΣDefPct), Speed by (1+ΣSpeedPct).

// Compute computes derived attributes from base attributes, base move speed and active buffs.
func Compute(base config.Attrs, speed float64, buffs []*core.Buff) core.Derived {
	d := core.Derived{
		MaxHP:   80 + base.Vit*12 + base.Str*2,
		Atk:     8 + base.Str*2 + base.Agi*0.5,
		MAtk:    8 + base.Int*2.5,
		Def:     4 + base.Vit*1 + base.Str*0.5,
		MDef:    4 + base.Int*1 + base.Vit*0.5,
		Crit:    math.Min(0.6, 0.05+base.Agi*0.004),
		CritDmg: 1.5 + base.Agi*0.005,
		Speed:   speed,
	}
	var atkPct, defPct, speedPct float64
	for _, b := range buffs {
		if b.Cfg == nil {
			continue
		}
		atkPct += b.Cfg.AtkPct
		defPct += b.Cfg.DefPct
		speedPct += b.Cfg.SpeedPct
	}
	d.Atk *= 1 + atkPct
	d.MAtk *= 1 + atkPct
	d.Def *= 1 + defPct
	d.MDef *= 1 + defPct
	d.Speed *= 1 + speedPct
	return d
}

// Recalc recomputes e.Attr from e.Base, e.Speed and e.Buffs. When MaxHP changes,
// HP keeps its ratio to MaxHP (if the old MaxHP was 0, HP is left unchanged).
// HP is then clamped to [0, MaxHP].
func Recalc(e *core.Entity) {
	old := e.Attr.MaxHP
	e.Attr = Compute(e.Base, e.Speed, e.Buffs)
	if old > 0 && e.Attr.MaxHP != old {
		e.HP = e.HP / old * e.Attr.MaxHP
	}
	e.HP = math.Max(0, math.Min(e.HP, e.Attr.MaxHP))
}

// Init sets e's attributes from scratch with full HP.
func Init(e *core.Entity) {
	Recalc(e)
	e.HP = e.Attr.MaxHP
}

// ExpToNext is the exp needed to go from level to level+1: 100*level.
func ExpToNext(level int) int { return 100 * level }

// System grants experience and levels entities up.
type System struct {
	s *core.State
}

// New creates the attribute system.
func New(s *core.State) *System { return &System{s: s} }

// LevelUp raises e one level: base attributes grow by e.Growth.
func LevelUp(e *core.Entity) {
	e.Level++
	e.Base.Str += e.Growth.Str
	e.Base.Agi += e.Growth.Agi
	e.Base.Int += e.Growth.Int
	e.Base.Vit += e.Growth.Vit
}

// GainExp adds exp to e and levels up as many times as the exp allows.
// Each level up grows the base attributes, refills HP and tells the client.
func (a *System) GainExp(e *core.Entity, n int) {
	e.Exp += n
	for e.Exp >= ExpToNext(e.Level) {
		e.Exp -= ExpToNext(e.Level)
		LevelUp(e)
		Init(e)
		a.s.Events.Emit(e, &core.Event{Kind: pb.EventKind_LEVEL_UP.Enum(), Id: core.I32(e.ID), Lv: core.I32(e.Level)})
	}
}
