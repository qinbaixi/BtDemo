package game

import (
	"errors"
	"math"

	"github.com/qinbaixi/BtDemo/internal/config"
)

// User-facing reasons a skill cannot be cast.
var (
	errDead     = errors.New("你已经死亡")
	errCooldown = errors.New("技能冷却中")
	errNoTarget = errors.New("没有有效目标")
	errTooFar   = errors.New("目标太远")
	errBadSkill = errors.New("未知的技能类型")
)

// ExpToNext is the exp needed to go from level to level+1: 100*level.
func ExpToNext(level int) int { return 100 * level }

// GainExp adds exp to a player and levels up as many times as the exp allows.
// Each level up grows the base attributes, refills HP and tells the client.
func (w *World) GainExp(e *Entity, n int) {
	e.Exp += n
	for e.Exp >= ExpToNext(e.Level) {
		e.Exp -= ExpToNext(e.Level)
		e.Level++
		addAttrs(&e.Base, e.Growth)
		w.Recalc(e)
		e.HP = e.Attr.MaxHP
		w.Emit(e, Event{"k": "lvl", "id": e.ID, "lv": e.Level})
	}
}

// UpdateBuffs drops expired buffs and recalculates e if any were removed.
func (w *World) UpdateBuffs(e *Entity) {
	if filterBuffs(e, func(b *Buff) bool { return b.Until > w.Now }) {
		w.Recalc(e)
	}
}

// filterBuffs keeps the buffs for which keep returns true and reports whether any were dropped.
func filterBuffs(e *Entity, keep func(*Buff) bool) bool {
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

// CalcDamage returns the damage src deals to dst with skill sk and whether it crit.
// Physical skills use Atk against Def, magic skills use MAtk against MDef.
func (w *World) CalcDamage(src, dst *Entity, sk *config.Skill) (float64, bool) {
	atk, def := src.Attr.Atk, dst.Attr.Def
	if sk.Damage == "magic" {
		atk, def = src.Attr.MAtk, dst.Attr.MDef
	}
	raw := atk*sk.Ratio + sk.Base
	dmg := raw * (1 - def/(def+100))
	crit := w.Rand.Float64() < src.Attr.Crit
	if crit {
		dmg *= src.Attr.CritDmg
	}
	dmg *= 0.95 + w.Rand.Float64()*0.1
	return math.Max(1, math.Round(dmg)), crit
}

// Cast makes e use skill sk. targetID is used for kind "target". It returns a
// user-facing error when the skill cannot be cast.
func (w *World) Cast(e *Entity, sk *config.Skill, targetID int) error {
	if e.Dead {
		return errDead
	}
	if w.Now < e.Cooldowns[sk.ID] {
		return errCooldown
	}
	switch sk.Kind {
	case "target":
		t := w.Get(targetID)
		if !t.Alive() || t == e || !w.Hostile(e, t) {
			return errNoTarget
		}
		if EdgeDist(e, t) > sk.Range {
			return errTooFar
		}
		w.Emit(e, Event{"k": "cast", "src": e.ID, "dst": t.ID, "skill": sk.ID, "name": sk.Name, "fx": sk.FX, "color": sk.Color})
		dmg, crit := w.CalcDamage(e, t, sk)
		w.applyDamage(e, t, dmg, crit, sk)
	case "aoe":
		w.Emit(e, Event{"k": "cast", "src": e.ID, "skill": sk.ID, "name": sk.Name, "fx": sk.FX, "color": sk.Color,
			"radius": sk.Radius, "x": e.X, "y": e.Y})
		// Collect first so damage (and any kill it causes) never changes the grid mid-walk.
		var targets []*Entity
		// Candidates by center distance; the edge test below is exact.
		w.Grid.InRange(e.X, e.Y, sk.Radius+e.Radius+maxEntityRadius, func(o *Entity) {
			if o.Alive() && w.Hostile(e, o) && EdgeDist(e, o) <= sk.Radius {
				targets = append(targets, o)
			}
		})
		for _, o := range targets {
			dmg, crit := w.CalcDamage(e, o, sk)
			w.applyDamage(e, o, dmg, crit, sk)
		}
	case "self":
		w.Emit(e, Event{"k": "cast", "src": e.ID, "dst": e.ID, "skill": sk.ID, "name": sk.Name, "fx": sk.FX, "color": sk.Color})
		if sk.Heal > 0 {
			amount := math.Round(e.Attr.MaxHP * sk.Heal)
			e.HP = math.Min(e.Attr.MaxHP, e.HP+amount)
			w.Emit(e, Event{"k": "heal", "dst": e.ID, "v": amount})
		}
		if sk.Buff != nil {
			// Recasting refreshes the buff instead of stacking it.
			filterBuffs(e, func(b *Buff) bool { return b.Cfg.Name != sk.Buff.Name })
			e.Buffs = append(e.Buffs, &Buff{Cfg: sk.Buff, Until: w.Now + sk.Buff.Duration})
			w.Recalc(e)
			w.Emit(e, Event{"k": "buff", "dst": e.ID, "name": sk.Buff.Name, "dur": sk.Buff.Duration})
		}
	default:
		return errBadSkill
	}
	e.Cooldowns[sk.ID] = w.Now + sk.Cooldown
	return nil
}

// applyDamage subtracts dmg from dst, records the attacker and kills dst at zero HP.
func (w *World) applyDamage(src, dst *Entity, dmg float64, crit bool, sk *config.Skill) {
	dst.HP -= dmg
	dst.LastAttacker = src.ID
	dst.LastHitAt = w.Now
	w.Emit(dst, Event{"k": "dmg", "src": src.ID, "dst": dst.ID, "v": dmg, "crit": crit, "skill": sk.ID})
	if dst.HP <= 0 {
		w.Kill(dst, src)
	}
}
