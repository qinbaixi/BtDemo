package game

import (
	"math"

	"github.com/qinbaixi/BtDemo/internal/config"
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

// ComputeDerived computes derived attributes from base attributes, base move speed and active buffs.
func ComputeDerived(base config.Attrs, speed float64, buffs []*Buff) Derived {
	d := Derived{
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
func (w *World) Recalc(e *Entity) {
	old := e.Attr.MaxHP
	e.Attr = ComputeDerived(e.Base, e.Speed, e.Buffs)
	if old > 0 && e.Attr.MaxHP != old {
		e.HP = e.HP / old * e.Attr.MaxHP
	}
	e.HP = math.Max(0, math.Min(e.HP, e.Attr.MaxHP))
}
