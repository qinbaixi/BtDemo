package combat

import (
	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 冲锋（kind: charge）和集结（kind: rally）：怪物首领、头狼用的技能。
//
// 冲锋分两段：
//  1. 出招（startCharge）：朝目标定下方向，算好最远冲到哪（被障碍物挡住就停在前面），
//     发 CAST（x、y 起点，tx、ty 预计终点，hit_at 出发时刻），客户端在地上画一条预警带；
//  2. 前摇结束（charge）：从当前位置沿定好的方向冲出去。路上碰到第一个敌人就停在它面前，
//     打它一下（技能的伤害和击退）；没碰到人但被障碍物挡住了，就是撞墙，自己晕 self_stun 毫秒。
//     冲刺用击退的位移来走（core.Knock），行为树在冲刺和晕眩期间暂停。
//     再发一个 CAST（fx 加 "_go"，x、y → tx、ty 是实际路线，dur 是冲刺毫秒数，撞墙时 wall、stun 有值）。
//     撞上的是石柱（模板 charge_break）时石柱碎掉，dst 是石柱，见 quake.go 的 breakObstacle。

// chargeSpeed 是冲锋的速度（像素 / 秒）。
const chargeSpeed = 900

// startCharge 开始冲锋的前摇：目标要活着、敌对、在 range 以内（圆心距离）。
func (sys *System) startCharge(entity *core.Entity, skill *config.Skill, targetID int) error {
	target := sys.state.Ents.Get(targetID)
	if !target.Alive() || target == entity || !sys.state.Hostile(entity, target) {
		return ErrNoTarget
	}
	if core.Dist(entity, target) > float64(skill.Range) {
		return ErrTooFar
	}
	dir, ok := unit(target.X-entity.X, target.Y-entity.Y)
	if !ok {
		return ErrNoAim
	}
	from := nav.Vec{X: entity.X, Y: entity.Y}
	end := sys.nav.Reach(from, dir, float64(skill.Distance), entity.Radius)
	event := castEvent(entity, target, skill)
	event.X, event.Y = core.FloorI32(from.X), core.FloorI32(from.Y)
	event.Tx, event.Ty = core.FloorI32(end.X), core.FloorI32(end.Y)
	event.Radius = core.I32(int(entity.Radius))
	sys.state.Events.Emit(entity, event)
	sys.startWindup(entity, skill, target.ID, event)
	entity.Windup.Aim = dir
	return nil
}

// charge 在冲锋前摇结束时冲出去，见文件开头。
func (sys *System) charge(entity *core.Entity, windup *core.Windup) {
	skill := windup.Skill
	dir := windup.Aim
	from := nav.Vec{X: entity.X, Y: entity.Y}
	end := sys.nav.Reach(from, dir, float64(skill.Distance), entity.Radius)
	length := end.Dist(from)
	blocked := length < float64(skill.Distance)-1
	var victim *core.Entity
	if hits := sys.hostilesOnLine(entity, from, dir, length); len(hits) > 0 {
		victim = hits[0].entity
		// 停在被撞的人面前（中心距离 = 两个半径），不穿过去
		stop := max(0, hits[0].at-entity.Radius)
		end = from.Add(dir.Scale(stop))
		length = stop
		blocked = false
	}
	duration := config.Millis(length * 1000 / chargeSpeed)
	now := sys.state.Now()
	if length >= 1 {
		entity.Knock = &core.Knock{From: from, To: end, Start: now, Duration: max(1, duration)}
	}
	if victim != nil && entity.Knock != nil {
		// 伤害等冲到被撞的人面前再结算，见 resolveChargeHits
		entity.Knock.Charge = &core.ChargeHit{Skill: skill, Victim: victim.ID}
	}
	event := &core.Event{
		Kind:  pb.EventKind_CAST.Enum(),
		Src:   core.I32(entity.ID),
		Skill: proto.String(skill.ID),
		Fx:    proto.String(skill.FX + "_go"),
		Color: proto.String(skill.Color),
		X:     core.FloorI32(from.X),
		Y:     core.FloorI32(from.Y),
		Tx:    core.FloorI32(end.X),
		Ty:    core.FloorI32(end.Y),
		Dur:   core.I32(int(duration)),
	}
	if victim != nil {
		event.Dst = core.I32(victim.ID)
	}
	if blocked && skill.SelfStun > 0 {
		// 撞墙：冲到墙前之后再晕（晕眩从冲刺结束算起）
		entity.StunUntil = max(entity.StunUntil, now+duration+skill.SelfStun)
		event.Wall = proto.Bool(true)
		event.Stun = core.I32(int(skill.SelfStun))
		if broken := sys.breakObstacle(entity, end); broken != nil {
			event.Dst = core.I32(broken.ID) // 客户端在撞碎的石柱上放碎石
		}
	}
	sys.state.Events.Emit(entity, event)
	if victim != nil && entity.Knock == nil {
		// 贴脸冲锋（没走出 1 像素）：当场撞上
		dmg, crit := sys.CalcDamage(entity, victim, skill)
		sys.applyDamage(entity, victim, dmg, crit, skill)
	}
}

// resolveChargeHits 结算冲到终点的冲锋撞击。在 Move.Tick 之前跑，
// 所以冲锋者的位置用冲锋终点 Knock.To 来算距离。
// 被撞的人这段时间里跑开超过 hit.reach 就撞空；冲锋途中冲锋者被别的击退
// 覆盖了 Knock（或被障碍物截停），Charge 跟着没了，也就不会结算。
func (sys *System) resolveChargeHits() {
	now := sys.state.Now()
	type chargeArrival struct {
		attacker *core.Entity
		hit      *core.ChargeHit
		end      nav.Vec
	}
	var arrived []chargeArrival
	sys.state.Ents.Each(func(entity *core.Entity) {
		knock := entity.Knock
		if knock != nil && knock.Charge != nil && now >= knock.End() {
			arrived = append(arrived, chargeArrival{attacker: entity, hit: knock.Charge, end: knock.To})
			knock.Charge = nil
		}
	})
	// 先收集再结算：结算里的击杀和击退不会打乱遍历
	for _, arrival := range arrived {
		attacker := arrival.attacker
		victim := sys.state.Ents.Get(arrival.hit.Victim)
		if !attacker.Alive() || !victim.Alive() {
			continue
		}
		gap := arrival.end.Dist(nav.Vec{X: victim.X, Y: victim.Y}) - attacker.Radius - victim.Radius
		if gap > float64(sys.state.Cfg.World.Hit.Reach) {
			continue // 被撞的人已经躲开了
		}
		dmg, crit := sys.CalcDamage(attacker, victim, arrival.hit.Skill)
		sys.applyDamage(attacker, victim, dmg, crit, arrival.hit.Skill)
	}
}

// rally 给 entity 和 radius 以内同阵营的同伴都加上技能的 Buff（头狼的嚎叫）。
func (sys *System) rally(entity *core.Entity, skill *config.Skill) {
	event := castEvent(entity, entity, skill)
	event.Radius = core.I32(skill.Radius)
	event.X, event.Y = core.FloorI32(entity.X), core.FloorI32(entity.Y)
	sys.state.Events.Emit(entity, event)
	var allies []*core.Entity
	sys.grid.InRange(entity.X, entity.Y, float64(skill.Radius), func(other *core.Entity) {
		if other.Alive() && other.Faction == entity.Faction && other.Kind == entity.Kind {
			allies = append(allies, other)
		}
	})
	for _, ally := range allies {
		sys.addBuff(ally, skill.Buff)
	}
}
