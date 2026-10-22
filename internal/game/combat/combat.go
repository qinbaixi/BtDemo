// Package combat 负责施放技能、计算并结算伤害、治疗、Buff 和击杀，并判断附近实体之间的敌对关系。
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

// 面向用户的技能无法施放的原因。
var (
	ErrDead     = errors.New("你已经死亡")
	ErrCooldown = errors.New("技能冷却中")
	ErrNoTarget = errors.New("没有有效目标")
	ErrTooFar   = errors.New("目标太远")
	ErrBadSkill = errors.New("未知的技能类型")
	ErrBlocking = errors.New("格挡中不能出招")
)

// System 负责执行技能与伤害。
type System struct {
	s    *core.State
	grid *aoi.Grid
	attr *attr.System
}

// New 创建战斗系统。
func New(s *core.State, grid *aoi.Grid, at *attr.System) *System {
	return &System{s: s, grid: grid, attr: at}
}

// Tick 清除已过期的 Buff。
func (c *System) Tick() {
	c.s.Ents.Each(func(e *core.Entity) {
		if !e.Dead {
			c.UpdateBuffs(e)
		}
	})
}

// UpdateBuffs 清除已过期的 Buff；若有 Buff 被移除，则重新计算 e。
func (c *System) UpdateBuffs(e *core.Entity) {
	now := c.s.Now()
	if filterBuffs(e, func(b *core.Buff) bool { return b.Until > now }) {
		attr.Recalc(e)
	}
}

// filterBuffs 保留 keep 返回 true 的 Buff，并报告是否有 Buff 被丢弃。
func filterBuffs(e *core.Entity, keep func(*core.Buff) bool) bool {
	kept := e.Buffs[:0]
	for _, b := range e.Buffs {
		if keep(b) {
			kept = append(kept, b)
		}
	}
	removed := len(kept) < len(e.Buffs)
	clear(e.Buffs[len(kept):]) // 不让被丢弃的 Buff 仍可通过底层数组访问
	e.Buffs = kept
	return removed
}

// NearestHostile 返回 r 范围内与 e 敌对的、距离最近的存活实体。
func (c *System) NearestHostile(e *core.Entity, r float64) *core.Entity {
	return c.nearest(e, r, func(o *core.Entity) bool { return true })
}

// NearestMonster 与 NearestHostile 相同，但仅限怪物，供玩家自动选择目标使用。
func (c *System) NearestMonster(e *core.Entity, r float64) *core.Entity {
	return c.nearest(e, r, func(o *core.Entity) bool { return o.Kind == core.KindMonster })
}

func (c *System) nearest(e *core.Entity, r float64, ok func(*core.Entity) bool) *core.Entity {
	var best *core.Entity
	bestD := math.Inf(1)
	c.grid.InRange(e.X, e.Y, r, func(o *core.Entity) {
		if o.Alive() && c.s.Hostile(e, o) && ok(o) {
			// 距离相同时取 ID 较小的实体，使结果不依赖于 map 的遍历顺序
			if d := core.Dist(e, o); d < bestD || d == bestD && o.ID < best.ID {
				best, bestD = o, d
			}
		}
	})
	return best
}

// CalcDamage 返回 src 使用技能 sk 对 dst 造成的伤害，以及是否暴击。
// 物理技能以 Atk 对抗 Def，法术技能以 MAtk 对抗 MDef。
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

// Cast 让 e 使用技能 sk。targetID 用于 kind 为 "target" 的技能。技能无法施放时，
// 返回面向用户的错误。
func (c *System) Cast(e *core.Entity, sk *config.Skill, targetID int) error {
	now := c.s.Now()
	if e.Dead {
		return ErrDead
	}
	if e.Blocking {
		return ErrBlocking
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
		// 先收集目标，使伤害（及其导致的击杀）不会在遍历过程中改变网格。
		var targets []*core.Entity
		// 先按中心距离筛选候选目标；下面的边缘距离判断是精确的。
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
			// 重复施放会刷新 Buff，而不是叠加。
			filterBuffs(e, func(b *core.Buff) bool { return b.Cfg.Name != sk.Buff.Name })
			e.Buffs = append(e.Buffs, &core.Buff{Cfg: sk.Buff, Until: now + sk.Buff.Duration, Absorb: math.Round(e.Attr.MaxHP * sk.Buff.ShieldPct)})
			attr.Recalc(e)
			c.s.Events.Emit(e, &core.Event{Kind: pb.EventKind_BUFF.Enum(), Dst: core.I32(e.ID), Name: &sk.Buff.Name, Dur: core.F32(sk.Buff.Duration)})
		}
	default:
		return ErrBadSkill
	}
	e.Cooldowns[sk.ID] = now + sk.Cooldown
	return nil
}

// applyDamage 从 dst 中扣除 dmg，记录攻击者，并在 HP 归零时击杀 dst。
// 先按格挡减伤，再由护盾吸收，剩下的才扣生命。
func (c *System) applyDamage(src, dst *core.Entity, dmg float64, crit bool, sk *config.Skill) {
	ev := &core.Event{Kind: pb.EventKind_DAMAGE.Enum(), Src: core.I32(src.ID), Dst: core.I32(dst.ID), Crit: &crit, Skill: &sk.ID}
	if dst.Blocking {
		blocked := math.Round(dmg * c.s.Cfg.World.Player.Block.Reduce)
		dmg -= blocked
		ev.Blocked = core.F32(blocked)
	}
	if absorbed := c.absorb(dst, dmg); absorbed > 0 {
		dmg -= absorbed
		ev.Absorbed = core.F32(absorbed)
	}
	ev.Value = core.F32(dmg)
	dst.HP -= dmg
	dst.LastAttacker = src.ID
	dst.LastHitAt = c.s.Now()
	c.s.Events.Emit(dst, ev)
	if dst.HP <= 0 {
		c.Kill(dst, src)
	}
}

// absorb 用 e 身上的护盾吸收至多 dmg 点伤害，返回吸收了多少；吸收完的护盾 Buff 被移除。
func (c *System) absorb(e *core.Entity, dmg float64) float64 {
	total := 0.0
	for _, b := range e.Buffs {
		if dmg <= 0 {
			break
		}
		take := math.Min(b.Absorb, dmg)
		b.Absorb -= take
		dmg -= take
		total += take
	}
	if total > 0 {
		// 护盾打破了就去掉这个 Buff（只靠护盾存在的 Buff，没有别的加成）
		if filterBuffs(e, func(b *core.Buff) bool { return b.Cfg.ShieldPct == 0 || b.Absorb > 0 }) {
			attr.Recalc(e)
		}
	}
	return total
}

// Kill 将 e 标记为死亡，安排其重生，并奖励击杀者。
func (c *System) Kill(e, killer *core.Entity) {
	if e.Dead {
		return
	}
	e.Dead = true
	e.HP = 0
	e.Target = 0
	e.Buffs = nil // 保留 MoveX/MoveY，使按住的按键在重生后仍然有效
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
	// 尸体保留在网格中，使观察者在其重生前仍能看到它。
}

// castEvent 描述 e 对 dst 使用技能 sk 的事件（aoe 技能的 dst 为 nil）。
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
