package combat

import (
	"math"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 这个文件是命中的"分量"：前摇到点结算、韧性、击退（撞墙）、硬直和打断。
// 档位和数值在 world.yaml 的 hit 和 skills.yaml 的 weight / windup。

// 格挡住的命中只推开这么多（不硬直、不扣韧性）
const blockedKnockScale = 0.3

// resolveWindups 结算前摇到点的出招。
func (sys *System) resolveWindups() {
	now := sys.state.Now()
	var due []*core.Entity
	sys.state.Ents.Each(func(entity *core.Entity) {
		if entity.Windup != nil && now >= entity.Windup.HitAt {
			due = append(due, entity)
		}
	})
	// 先收集再结算：结算里的击杀不会打乱遍历
	for _, entity := range due {
		windup := entity.Windup
		if windup == nil {
			continue // 前面结算的一下把它打出了硬直，前摇被打断了
		}
		entity.Windup = nil
		if entity.Alive() {
			sys.strike(entity, windup.Skill, windup.Target, true)
		}
	}
}

// strike 结算一次 target 或 aoe 技能的命中。late 为 true 表示是前摇结束时结算的：
// 目标这段时间里可能跑开了，射程放宽 hit.reach，再远就打空。
func (sys *System) strike(entity *core.Entity, skill *config.Skill, targetID int, late bool) {
	switch skill.Kind {
	case "target":
		target := sys.state.Ents.Get(targetID)
		if !target.Alive() || !sys.state.Hostile(entity, target) {
			return
		}
		reach := skill.Range
		if late {
			reach += sys.state.Cfg.World.Hit.Reach
		}
		if core.EdgeDist(entity, target) > reach {
			return // 打空了
		}
		dmg, crit := sys.CalcDamage(entity, target, skill)
		sys.applyDamage(entity, target, dmg, crit, skill)
	case "aoe":
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
	}
}

// startWindup 让 entity 开始前摇：event 是这次出招的 CAST 事件，写上命中时刻。
func (sys *System) startWindup(entity *core.Entity, skill *config.Skill, targetID int, event *core.Event) {
	hitAt := sys.state.Now() + skill.Windup
	event.HitAt = core.F32(hitAt)
	entity.Windup = &core.Windup{Skill: skill, Target: targetID, HitAt: hitAt}
}

// poise 返回 entity 的韧性上限和重量。
func (sys *System) poise(entity *core.Entity) (float64, float64) {
	switch {
	case entity.Tmpl != nil:
		return entity.Tmpl.Poise, entity.Tmpl.Mass
	case entity.PetCfg != nil:
		return entity.PetCfg.Poise, entity.PetCfg.Mass
	case entity.Kind == core.KindPlayer:
		player := &sys.state.Cfg.World.Player
		return player.Poise, player.Mass
	}
	return 0, 1
}

// applyImpact 给技能 skill 对 dst 的一次命中加上分量：扣韧性，韧性打空时击退（撞墙多硬直）、
// 硬直并打断 dst 的前摇。结果写进这次命中的 DAMAGE 事件 event（事件还在队列里，下次同步才发出）。
// 格挡住的命中只推开一点；已经被打死的只被打飞，不再硬直。
func (sys *System) applyImpact(src, dst *core.Entity, skill *config.Skill, blocked bool, event *core.Event) {
	rules := &sys.state.Cfg.World.Hit
	hit := rules.Hit(skill)
	event.Weight = proto.String(skill.Weight)
	now := sys.state.Now()
	poiseMax, mass := sys.poise(dst)
	stun := hit.Stun
	distance := hit.Knock / math.Max(0.1, mass)
	if blocked {
		stun = 0
		distance *= blockedKnockScale
	} else if !dst.Dead {
		if now-dst.PoiseHitAt > rules.PoiseReset {
			dst.PoiseTaken = 0
		}
		dst.PoiseHitAt = now
		dst.PoiseTaken += hit.Poise
		if dst.PoiseTaken < poiseMax {
			return // 霸体：这一下扛住了，不退不停
		}
		dst.PoiseTaken = 0 // 韧性被打空，挨完这下重新算
	}
	if distance >= 1 {
		from := nav.Vec{X: dst.X, Y: dst.Y}
		direction, ok := unit(dst.X-src.X, dst.Y-src.Y)
		if !ok {
			direction = nav.Vec{X: 1}
		}
		end := sys.nav.Reach(from, direction, distance, dst.Radius)
		dst.Knock = &core.Knock{From: from, To: end, Start: now, Duration: rules.KnockTime}
		dst.Steering = core.Steering{} // 被推开了，原来的路线作废
		event.Kx, event.Ky = core.F32(core.Round1(end.X)), core.F32(core.Round1(end.Y))
		event.KnockTime = core.F32(rules.KnockTime)
		// 没推满就停下：撞到了墙或物件
		if end.Dist(from) < distance-1 && !blocked {
			event.Wall = proto.Bool(true)
			stun += rules.WallStun
		}
	}
	if stun <= 0 || dst.Dead {
		return // 尸体只被打飞，不硬直
	}
	dst.StunUntil = math.Max(dst.StunUntil, now+stun)
	event.Stun = core.F32(stun)
	sys.CancelWindup(dst)
}

// CancelWindup 打断 entity 正在前摇的出招（被打出硬直、举盾），通知客户端收起动作；没在前摇时什么都不做。
func (sys *System) CancelWindup(entity *core.Entity) {
	if entity.Windup == nil {
		return
	}
	entity.Windup = nil
	sys.state.Events.Emit(
		entity,
		&core.Event{Kind: pb.EventKind_INTERRUPT.Enum(), Id: core.I32(entity.ID)},
	)
}
