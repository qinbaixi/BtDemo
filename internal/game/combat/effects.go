package combat

import (
	"math"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 装备特效在战斗里的效果。特效的种类和参数见 config.ItemEffect；有概率的特效用 State.Luck 掷骰子。
// 触发时发的事件带 Event.proc = 特效名，客户端据此飘字和放特效。
// 特效自己造成的伤害走 damage，不再调用 afterHit，所以特效之间不会连锁（反伤不会再被反伤）。

// afterHit 在技能 skill 的一次命中（没被免疫）结算完之后，触发攻击者 src 和受击者 dst 的装备特效。
func (sys *System) afterHit(src, dst *core.Entity, skill *config.Skill, result damageResult) {
	// 攻击者的特效
	if result.taken > 0 && src.Alive() {
		for _, effect := range src.Effects(config.EffectLifesteal) {
			sys.heal(src, result.taken*effect.Pct, config.EffectLifesteal)
		}
	}
	if dst.Alive() {
		for _, effect := range src.Effects(config.EffectIgnite) {
			if dst.Alive() && sys.state.Lucky(effect.Chance) {
				sys.ignite(src, dst, skill, effect)
			}
		}
		for _, effect := range src.Effects(config.EffectChill) {
			if dst.Alive() && sys.state.Lucky(effect.Chance) {
				event := sys.addBuff(dst, effect.Debuff)
				event.Proc = proto.String(config.EffectChill)
			}
		}
	}
	if len(src.Skills) > 0 && src.Skills[0] == skill {
		for _, effect := range src.Effects(config.EffectMultishot) {
			if src.Alive() && sys.state.Lucky(effect.Chance) {
				sys.multishot(src, dst, skill)
			}
		}
	}
	// 受击者的特效
	if !dst.Alive() {
		return
	}
	if result.blocked > 0 {
		for _, effect := range dst.Effects(config.EffectBlockHeal) {
			sys.heal(dst, dst.Attr.MaxHP*effect.Pct, config.EffectBlockHeal)
		}
	}
	if result.taken > 0 && src.Alive() && core.EdgeDist(src, dst) <= config.ThornsRange {
		for _, effect := range dst.Effects(config.EffectThorns) {
			if src.Alive() {
				sys.thorns(dst, src, result.taken, effect)
			}
		}
	}
}

// ignite 让 src 对 dst 追加一次 攻击 × ratio 的魔法伤害（按 dst 的法术防御减免）。
func (sys *System) ignite(
	src, dst *core.Entity,
	skill *config.Skill,
	effect *config.ItemEffect,
) {
	raw := src.Attr.Atk * effect.Ratio
	amount := math.Max(1, math.Round(raw*(1-dst.Attr.MDef/(dst.Attr.MDef+100))))
	sys.damage(src, dst, amount, false, skill.ID, config.EffectIgnite)
}

// multishot 在普攻 skill 命中 dst 之后再射一箭：目标是射程内（边缘距离）离 src 最近的另一个敌人，
// 没有就再射 dst（dst 已经死了就不射）。先发 CAST（fx arrow），再按普攻正常算伤害。
func (sys *System) multishot(src, dst *core.Entity, skill *config.Skill) {
	var target *core.Entity
	bestDist := math.Inf(1)
	sys.grid.InRange(
		src.X,
		src.Y,
		skill.Range+src.Radius+core.MaxRadius,
		func(other *core.Entity) {
			if other == dst || !other.Alive() || !sys.state.Hostile(src, other) {
				return
			}
			dist := core.EdgeDist(src, other)
			if dist > skill.Range {
				return
			}
			// 距离相同时取 ID 小的，结果不依赖遍历顺序
			if dist < bestDist || dist == bestDist && other.ID < target.ID {
				target, bestDist = other, dist
			}
		},
	)
	if target == nil {
		if !dst.Alive() {
			return
		}
		target = dst
	}
	event := castEvent(src, target, skill)
	event.Fx = proto.String("arrow")
	event.Proc = proto.String(config.EffectMultishot)
	sys.state.Events.Emit(src, event)
	dmg, crit := sys.CalcDamage(src, target, skill)
	sys.damage(src, target, dmg, crit, skill.ID, config.EffectMultishot)
}

// thorns 让 owner 把受到的 taken 点伤害按 pct 反弹给攻击者 attacker（物理伤害，按 attacker 的防御减免）。
func (sys *System) thorns(owner, attacker *core.Entity, taken float64, effect *config.ItemEffect) {
	raw := taken * effect.Pct
	amount := math.Max(1, math.Round(raw*(1-attacker.Attr.Def/(attacker.Attr.Def+100))))
	sys.damage(owner, attacker, amount, false, "", config.EffectThorns)
}

// heal 给 entity 回复 amount 点生命（四舍五入，不超过最大生命），回了血就发 HEAL 事件
// （proc 不空时写进事件，是触发它的特效名）。
func (sys *System) heal(entity *core.Entity, amount float64, proc string) {
	amount = math.Min(math.Round(amount), entity.Attr.MaxHP-entity.HP)
	if amount <= 0 {
		return
	}
	entity.SetHP(entity.HP + amount)
	event := &core.Event{
		Kind:  pb.EventKind_HEAL.Enum(),
		Dst:   core.I32(entity.ID),
		Value: core.F32(amount),
	}
	if proc != "" {
		event.Proc = proto.String(proc)
	}
	sys.state.Events.Emit(entity, event)
}

// startAmbush 在 entity 放完位移技能后调用：有 ambush 特效时，接下来 dur 秒内的下一次伤害必定暴击。
func (sys *System) startAmbush(entity *core.Entity) {
	for _, effect := range entity.Effects(config.EffectAmbush) {
		entity.AmbushUntil = math.Max(entity.AmbushUntil, sys.state.Now()+effect.Dur)
	}
}

// regen 每帧给活着的 entity 回复 最大生命 × pct × 帧长（每秒合计 最大生命 × pct），不发事件。
func (sys *System) regen(entity *core.Entity) {
	for _, effect := range entity.Effects(config.EffectRegen) {
		perTick := entity.Attr.MaxHP * effect.Pct * sys.state.Clock.Dt
		entity.SetHP(math.Min(entity.Attr.MaxHP, entity.HP+perTick))
	}
}
