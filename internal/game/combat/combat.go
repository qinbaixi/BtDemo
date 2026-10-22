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
	state *core.State
	grid  *aoi.Grid
	attr  *attr.System
}

// New 创建战斗系统。
func New(state *core.State, grid *aoi.Grid, attrSys *attr.System) *System {
	return &System{state: state, grid: grid, attr: attrSys}
}

// Tick 清除已过期的 Buff。
func (sys *System) Tick() {
	sys.state.Ents.Each(func(entity *core.Entity) {
		if !entity.Dead {
			sys.UpdateBuffs(entity)
		}
	})
}

// UpdateBuffs 清除已过期的 Buff；若有 Buff 被移除，则重新计算 entity。
func (sys *System) UpdateBuffs(entity *core.Entity) {
	now := sys.state.Now()
	if filterBuffs(entity, func(buff *core.Buff) bool { return buff.Until > now }) {
		attr.Recalc(entity)
	}
}

// filterBuffs 保留 keep 返回 true 的 Buff，并报告是否有 Buff 被丢弃。
func filterBuffs(entity *core.Entity, keep func(*core.Buff) bool) bool {
	kept := entity.Buffs[:0]
	for _, buff := range entity.Buffs {
		if keep(buff) {
			kept = append(kept, buff)
		}
	}
	removed := len(kept) < len(entity.Buffs)
	clear(entity.Buffs[len(kept):]) // 不让被丢弃的 Buff 仍可通过底层数组访问
	entity.Buffs = kept
	return removed
}

// NearestHostile 返回 radius 范围内与 entity 敌对的、距离最近的存活实体。
func (sys *System) NearestHostile(entity *core.Entity, radius float64) *core.Entity {
	return sys.nearest(entity, radius, func(other *core.Entity) bool { return true })
}

// NearestMonster 与 NearestHostile 相同，但仅限怪物，供玩家自动选择目标使用。
func (sys *System) NearestMonster(entity *core.Entity, radius float64) *core.Entity {
	return sys.nearest(
		entity,
		radius,
		func(other *core.Entity) bool { return other.Kind == core.KindMonster },
	)
}

func (sys *System) nearest(
	entity *core.Entity,
	radius float64,
	ok func(*core.Entity) bool,
) *core.Entity {
	var best *core.Entity
	bestD := math.Inf(1)
	sys.grid.InRange(entity.X, entity.Y, radius, func(other *core.Entity) {
		if other.Alive() && sys.state.Hostile(entity, other) && ok(other) {
			// 距离相同时取 ID 较小的实体，使结果不依赖于 map 的遍历顺序
			if dist := core.Dist(entity, other); dist < bestD ||
				dist == bestD && other.ID < best.ID {
				best, bestD = other, dist
			}
		}
	})
	return best
}

// CalcDamage 返回 src 使用技能 skill 对 dst 造成的伤害，以及是否暴击。
// 物理技能以 Atk 对抗 Def，法术技能以 MAtk 对抗 MDef。
func (sys *System) CalcDamage(src, dst *core.Entity, skill *config.Skill) (float64, bool) {
	atk, def := src.Attr.Atk, dst.Attr.Def
	if skill.Damage == "magic" {
		atk, def = src.Attr.MAtk, dst.Attr.MDef
	}
	raw := atk*skill.Ratio + skill.Base
	dmg := raw * (1 - def/(def+100))
	crit := sys.state.Rand.Float64() < src.Attr.Crit
	if crit {
		dmg *= src.Attr.CritDmg
	}
	dmg *= 0.95 + sys.state.Rand.Float64()*0.1
	return math.Max(1, math.Round(dmg)), crit
}

// Cast 让 entity 使用技能 skill。targetID 用于 kind 为 "target" 的技能。技能无法施放时，
// 返回面向用户的错误。
func (sys *System) Cast(entity *core.Entity, skill *config.Skill, targetID int) error {
	now := sys.state.Now()
	if entity.Dead {
		return ErrDead
	}
	if entity.Blocking {
		return ErrBlocking
	}
	if now < entity.Cooldowns[skill.ID] {
		return ErrCooldown
	}
	switch skill.Kind {
	case "target":
		target := sys.state.Ents.Get(targetID)
		if !target.Alive() || target == entity || !sys.state.Hostile(entity, target) {
			return ErrNoTarget
		}
		if core.EdgeDist(entity, target) > skill.Range {
			return ErrTooFar
		}
		sys.state.Events.Emit(entity, castEvent(entity, target, skill))
		dmg, crit := sys.CalcDamage(entity, target, skill)
		sys.applyDamage(entity, target, dmg, crit, skill)
	case "aoe":
		event := castEvent(entity, nil, skill)
		event.Radius = core.F32(skill.Radius)
		event.X, event.Y = core.F32(entity.X), core.F32(entity.Y)
		sys.state.Events.Emit(entity, event)
		// 先收集目标，使伤害（及其导致的击杀）不会在遍历过程中改变网格。
		var targets []*core.Entity
		// 先按中心距离筛选候选目标；下面的边缘距离判断是精确的。
		sys.grid.InRange(
			entity.X,
			entity.Y,
			skill.Radius+entity.Radius+core.MaxRadius,
			func(other *core.Entity) {
				if other.Alive() && sys.state.Hostile(entity, other) &&
					core.EdgeDist(entity, other) <= skill.Radius {
					targets = append(targets, other)
				}
			},
		)
		for _, other := range targets {
			dmg, crit := sys.CalcDamage(entity, other, skill)
			sys.applyDamage(entity, other, dmg, crit, skill)
		}
	case "self":
		sys.state.Events.Emit(entity, castEvent(entity, entity, skill))
		if skill.Heal > 0 {
			amount := math.Round(entity.Attr.MaxHP * skill.Heal)
			entity.HP = math.Min(entity.Attr.MaxHP, entity.HP+amount)
			sys.state.Events.Emit(
				entity,
				&core.Event{
					Kind:  pb.EventKind_HEAL.Enum(),
					Dst:   core.I32(entity.ID),
					Value: core.F32(amount),
				},
			)
		}
		if skill.Buff != nil {
			// 重复施放会刷新 Buff，而不是叠加。
			filterBuffs(
				entity,
				func(buff *core.Buff) bool { return buff.Cfg.Name != skill.Buff.Name },
			)
			entity.Buffs = append(
				entity.Buffs,
				&core.Buff{
					Cfg:    skill.Buff,
					Until:  now + skill.Buff.Duration,
					Absorb: math.Round(entity.Attr.MaxHP * skill.Buff.ShieldPct),
				},
			)
			attr.Recalc(entity)
			sys.state.Events.Emit(
				entity,
				&core.Event{
					Kind: pb.EventKind_BUFF.Enum(),
					Dst:  core.I32(entity.ID),
					Name: &skill.Buff.Name,
					Dur:  core.F32(skill.Buff.Duration),
				},
			)
		}
	default:
		return ErrBadSkill
	}
	entity.Cooldowns[skill.ID] = now + skill.Cooldown
	return nil
}

// applyDamage 从 dst 中扣除 dmg，记录攻击者，并在 HP 归零时击杀 dst。
// 先按格挡减伤，再由护盾吸收，剩下的才扣生命。
func (sys *System) applyDamage(src, dst *core.Entity, dmg float64, crit bool, skill *config.Skill) {
	event := &core.Event{
		Kind:  pb.EventKind_DAMAGE.Enum(),
		Src:   core.I32(src.ID),
		Dst:   core.I32(dst.ID),
		Crit:  &crit,
		Skill: &skill.ID,
	}
	if dst.Blocking {
		blocked := math.Round(dmg * sys.state.Cfg.World.Player.Block.Reduce)
		dmg -= blocked
		event.Blocked = core.F32(blocked)
	}
	if absorbed := sys.absorb(dst, dmg); absorbed > 0 {
		dmg -= absorbed
		event.Absorbed = core.F32(absorbed)
	}
	event.Value = core.F32(dmg)
	dst.HP -= dmg
	dst.LastAttacker = src.ID
	dst.LastHitAt = sys.state.Now()
	sys.state.Events.Emit(dst, event)
	if dst.HP <= 0 {
		sys.Kill(dst, src)
	}
}

// absorb 用 entity 身上的护盾吸收至多 dmg 点伤害，返回吸收了多少；吸收完的护盾 Buff 被移除。
func (sys *System) absorb(entity *core.Entity, dmg float64) float64 {
	total := 0.0
	for _, buff := range entity.Buffs {
		if dmg <= 0 {
			break
		}
		take := math.Min(buff.Absorb, dmg)
		buff.Absorb -= take
		dmg -= take
		total += take
	}
	if total > 0 {
		// 护盾打破了就去掉这个 Buff（只靠护盾存在的 Buff，没有别的加成）
		if filterBuffs(
			entity,
			func(buff *core.Buff) bool { return buff.Cfg.ShieldPct == 0 || buff.Absorb > 0 },
		) {
			attr.Recalc(entity)
		}
	}
	return total
}

// Kill 将 entity 标记为死亡，安排其重生，并奖励击杀者。
func (sys *System) Kill(entity, killer *core.Entity) {
	if entity.Dead {
		return
	}
	entity.Dead = true
	entity.HP = 0
	entity.Target = 0
	entity.Buffs = nil // 保留 MoveX/MoveY，使按住的按键在重生后仍然有效
	entity.Action = ""
	sys.state.Events.Emit(
		entity,
		&core.Event{Kind: pb.EventKind_DIE.Enum(), Id: core.I32(entity.ID)},
	)
	delay := sys.state.Cfg.World.Player.Respawn
	if entity.Tmpl != nil {
		delay = entity.Tmpl.Respawn
		if killer != nil && killer.Kind == core.KindPlayer {
			sys.attr.GainExp(killer, entity.Tmpl.Exp)
		}
	}
	entity.RespawnAt = sys.state.Now() + delay
	// 尸体保留在网格中，使观察者在其重生前仍能看到它。
}

// castEvent 描述 entity 对 dst 使用技能 skill 的事件（aoe 技能的 dst 为 nil）。
func castEvent(entity, dst *core.Entity, skill *config.Skill) *core.Event {
	event := &core.Event{
		Kind:  pb.EventKind_CAST.Enum(),
		Src:   core.I32(entity.ID),
		Skill: proto.String(skill.ID),
		Name:  proto.String(skill.Name),
		Fx:    proto.String(skill.FX),
		Color: proto.String(skill.Color),
	}
	if dst != nil {
		event.Dst = core.I32(dst.ID)
	}
	return event
}
