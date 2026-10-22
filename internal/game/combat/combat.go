// Package combat 负责施放技能、计算并结算伤害、治疗、Buff 和击杀，并判断附近实体之间的敌对关系。
package combat

import (
	"errors"
	"math"
	"slices"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/aoi"
	"github.com/qinbaixi/BtDemo/internal/game/attr"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/item"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
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
	ErrNoAim    = errors.New("没有方向")
	ErrNoRoom   = errors.New("前面过不去")
)

// 投掷物的碰撞半径：飞行时被障碍物挡住、判定命中都按这个粗细
const projectileRadius = 6

// System 负责执行技能与伤害。
type System struct {
	state *core.State
	grid  *aoi.Grid
	attr  *attr.System
	nav   *nav.Map     // 闪现和投掷物要知道障碍物在哪
	items *item.System // 玩家打死怪物时掉落装备
}

// New 创建战斗系统。
func New(
	state *core.State,
	grid *aoi.Grid,
	attrSys *attr.System,
	navMap *nav.Map,
	itemSys *item.System,
) *System {
	return &System{
		state: state,
		grid:  grid,
		attr:  attrSys,
		nav:   navMap,
		items: itemSys,
	}
}

// Tick 清除已过期的 Buff，并结算装备的持续回血（regen）。
func (sys *System) Tick() {
	sys.state.Ents.Each(func(entity *core.Entity) {
		if !entity.Dead {
			sys.UpdateBuffs(entity)
			sys.regen(entity)
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
	// 武器附魔：物理技能额外打一份法术伤害（按目标的法抗减免）
	if skill.Damage == "physical" {
		for _, buff := range src.Buffs {
			if bonus := buff.Cfg.BonusMagic; bonus > 0 {
				dmg += src.Attr.MAtk * bonus * (1 - dst.Attr.MDef/(dst.Attr.MDef+100))
			}
		}
	}
	crit := sys.state.Rand.Float64() < src.Attr.Crit
	// 伏击（ambush 特效）：位移后限定时间内的下一次伤害必定暴击，打中（没被免疫）才算用掉，见 damage
	if src.AmbushUntil > sys.state.Now() {
		crit = true
	}
	if crit {
		dmg *= src.Attr.CritDmg
	}
	dmg *= 0.95 + sys.state.Rand.Float64()*0.1
	return math.Max(1, math.Round(dmg)), crit
}

// Cast 让 entity 使用技能 skill。targetID 用于 kind 为 "target" 的技能。技能无法施放时，
// 返回面向用户的错误。dash、line 和 rain 技能要用 CastAimed 给出方向。
func (sys *System) Cast(entity *core.Entity, skill *config.Skill, targetID int) error {
	return sys.CastAimed(entity, skill, targetID, 0, 0)
}

// CastAimed 和 Cast 一样，多了瞄准方向 (aimX, aimY)（不必是单位向量），
// 给 dash（往哪闪）、line（往哪扔）和 rain（没有目标时落在哪边）技能用；没有方向时 dash、line 放不出来，rain 没有目标时也放不出来。
func (sys *System) CastAimed(
	entity *core.Entity,
	skill *config.Skill,
	targetID int,
	aimX, aimY float64,
) error {
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
	case "ally":
		// 友方技能：对行为树指定的友方目标（宠物的主人）回血，目标要在 range 内
		ally := sys.state.Ents.Get(targetID)
		if !ally.Alive() || sys.state.Hostile(entity, ally) {
			return ErrNoTarget
		}
		if core.EdgeDist(entity, ally) > skill.Range {
			return ErrTooFar
		}
		sys.state.Events.Emit(entity, castEvent(entity, ally, skill))
		sys.heal(ally, ally.Attr.MaxHP*skill.Heal, "")
	case "dash":
		dir, ok := unit(aimX, aimY)
		if !ok {
			return ErrNoAim
		}
		from := nav.Vec{X: entity.X, Y: entity.Y}
		end := sys.nav.Reach(from, dir, skill.Distance, entity.Radius)
		if end.Dist(from) < 1 {
			return ErrNoRoom
		}
		event := castEvent(entity, nil, skill)
		event.X, event.Y = core.F32(core.Round1(from.X)), core.F32(core.Round1(from.Y))
		event.Tx, event.Ty = core.F32(core.Round1(end.X)), core.F32(core.Round1(end.Y))
		entity.X, entity.Y = end.X, end.Y
		sys.grid.Moved(entity)
		sys.state.Events.Emit(entity, event)
		sys.startAmbush(entity)
	case "line":
		dir, ok := unit(aimX, aimY)
		if !ok {
			return ErrNoAim
		}
		from := nav.Vec{X: entity.X, Y: entity.Y}
		// 从身体边缘出手；被障碍物挡住的地方就是最远距离
		end := sys.nav.Reach(from, dir, skill.Range+entity.Radius, projectileRadius)
		hits := sys.hostilesOnLine(entity, from, dir, end.Dist(from))
		var first *core.Entity
		if len(hits) > 0 {
			first = hits[0].entity
		}
		if !skill.Pierce && first != nil {
			// 普通投掷物打中第一个敌人就停在它身上；穿透的一直飞到射程尽头或墙前
			end = from.Add(dir.Scale(hits[0].at))
			hits = hits[:1]
		}
		event := castEvent(entity, first, skill)
		event.X, event.Y = core.F32(core.Round1(from.X)), core.F32(core.Round1(from.Y))
		event.Tx, event.Ty = core.F32(core.Round1(end.X)), core.F32(core.Round1(end.Y))
		sys.state.Events.Emit(entity, event)
		for _, hit := range hits {
			dmg, crit := sys.CalcDamage(entity, hit.entity, skill)
			sys.applyDamage(entity, hit.entity, dmg, crit, skill)
		}
	case "rain":
		if err := sys.castRain(entity, skill, targetID, aimX, aimY); err != nil {
			return err
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
			sys.addBuff(entity, skill.Buff)
		}
	case "zone":
		// 在脚下放回血区，同一个人再放一次时旧的消失
		event := castEvent(entity, nil, skill)
		event.Radius = core.F32(skill.Zone.Radius)
		event.X, event.Y = core.F32(core.Round1(entity.X)), core.F32(core.Round1(entity.Y))
		sys.state.Events.Emit(entity, event)
		sys.state.Zones.Replace(&core.Zone{
			Cfg:       skill.Zone,
			X:         entity.X,
			Y:         entity.Y,
			Faction:   entity.Faction,
			Owner:     entity.ID,
			Until:     now + skill.Zone.Duration,
			NextPulse: now + skill.Zone.Interval,
		})
	default:
		return ErrBadSkill
	}
	// 冷却缩减（装备的 cdr）让冷却变短
	entity.Cooldowns[skill.ID] = now + skill.Cooldown*(1-entity.Attr.CDR)
	entity.CanPick = false // 放过技能就不能再换技能了，等下次死亡
	return nil
}

// unit 把 (x, y) 变成单位向量；长度为 0 或不是有效数字时 ok 为 false。
func unit(x, y float64) (nav.Vec, bool) {
	length := math.Hypot(x, y)
	if length < 1e-6 || math.IsNaN(length) || math.IsInf(length, 0) {
		return nav.Vec{}, false
	}
	return nav.Vec{X: x / length, Y: y / length}, true
}

// lineHit 是投掷物飞行线上的一个敌人，和飞到它边缘时飞过的距离。
type lineHit struct {
	entity *core.Entity
	at     float64
}

// hostilesOnLine 找从 from 沿 dir 飞出 maxDist 内碰到的所有敌人，按先后顺序排好
// （距离相同时 ID 小的在前，结果不依赖 map 的遍历顺序）。
func (sys *System) hostilesOnLine(
	entity *core.Entity,
	from, dir nav.Vec,
	maxDist float64,
) []lineHit {
	var hits []lineHit
	center := from.Add(dir.Scale(maxDist / 2))
	sys.grid.InRange(
		center.X,
		center.Y,
		maxDist/2+core.MaxRadius+projectileRadius,
		func(other *core.Entity) {
			if !other.Alive() || !sys.state.Hostile(entity, other) {
				return
			}
			// other 的圆心投影到飞行线上：along 是沿线距离，across 是离线的距离
			offset := nav.Vec{X: other.X, Y: other.Y}.Sub(from)
			along := offset.Dot(dir)
			across := math.Abs(offset.X*dir.Y - offset.Y*dir.X)
			reach := other.Radius + projectileRadius
			if across > reach || along < 0 || along > maxDist+reach {
				return
			}
			// 碰到圆的边缘时飞过的距离；超过 maxDist 说明投掷物在那之前已经被挡住或飞到头了
			touch := math.Max(0, along-math.Sqrt(reach*reach-across*across))
			if touch > maxDist {
				return
			}
			hits = append(hits, lineHit{entity: other, at: touch})
		},
	)
	slices.SortFunc(hits, func(left, right lineHit) int {
		if left.at != right.at {
			if left.at < right.at {
				return -1
			}
			return 1
		}
		return left.entity.ID - right.entity.ID
	})
	return hits
}

// castRain 放箭雨：落点是选中的目标（存活、敌对、边缘距离不超过 range）所在的位置，
// 没有这样的目标就是施法者沿瞄准方向 distance 处（夹在地图内）；两者都没有返回 ErrNoAim。
// 先发一个 CAST（x、y 是落点），再对落点 radius 内（边缘距离）的每个敌人发 DAMAGE。
func (sys *System) castRain(
	entity *core.Entity,
	skill *config.Skill,
	targetID int,
	aimX, aimY float64,
) error {
	centerX, centerY := 0.0, 0.0
	target := sys.state.Ents.Get(targetID)
	if target.Alive() && target != entity && sys.state.Hostile(entity, target) &&
		core.EdgeDist(entity, target) <= skill.Range {
		centerX, centerY = target.X, target.Y
	} else {
		target = nil
		dir, ok := unit(aimX, aimY)
		if !ok {
			return ErrNoAim
		}
		world := sys.state.Cfg.World.Map
		centerX = math.Max(0, math.Min(world.Width, entity.X+dir.X*skill.Distance))
		centerY = math.Max(0, math.Min(world.Height, entity.Y+dir.Y*skill.Distance))
	}
	event := castEvent(entity, target, skill)
	event.Radius = core.F32(skill.Radius)
	event.X, event.Y = core.F32(core.Round1(centerX)), core.F32(core.Round1(centerY))
	sys.state.Events.Emit(entity, event)
	// 先收集目标，使伤害（及其导致的击杀）不会在遍历过程中改变网格。
	var victims []*core.Entity
	sys.grid.InRange(
		centerX,
		centerY,
		skill.Radius+core.MaxRadius,
		func(other *core.Entity) {
			if other.Alive() && sys.state.Hostile(entity, other) &&
				math.Max(0, math.Hypot(other.X-centerX, other.Y-centerY)-other.Radius) <= skill.Radius {
				victims = append(victims, other)
			}
		},
	)
	slices.SortFunc(victims, func(left, right *core.Entity) int { return left.ID - right.ID })
	for _, victim := range victims {
		dmg, crit := sys.CalcDamage(entity, victim, skill)
		sys.applyDamage(entity, victim, dmg, crit, skill)
	}
	return nil
}

// addBuff 给 entity 加上 Buff（同名的会被刷新，不叠加），并通知客户端；返回发出的 BUFF 事件。
func (sys *System) addBuff(entity *core.Entity, cfg *config.Buff) *core.Event {
	filterBuffs(entity, func(buff *core.Buff) bool { return buff.Cfg.Name != cfg.Name })
	entity.Buffs = append(
		entity.Buffs,
		&core.Buff{
			Cfg:    cfg,
			Until:  sys.state.Now() + cfg.Duration,
			Absorb: math.Round(entity.Attr.MaxHP * cfg.ShieldPct),
		},
	)
	attr.Recalc(entity)
	event := &core.Event{
		Kind: pb.EventKind_BUFF.Enum(),
		Dst:  core.I32(entity.ID),
		Name: &cfg.Name,
		Dur:  core.F32(cfg.Duration),
	}
	sys.state.Events.Emit(entity, event)
	return event
}

// applyDamage 结算技能 skill 的一次命中：src 对 dst 造成 dmg 点伤害（见 damage），
// 然后触发双方装备的特效（见 effects.go 的 afterHit）。
// 技能带 Debuff 时，没被免掉、也没被打死的目标会挂上它。施法者已经死了时什么都不做。
func (sys *System) applyDamage(src, dst *core.Entity, dmg float64, crit bool, skill *config.Skill) {
	// 施法者可能在同一次范围技能里被前面目标的反伤打死了，死了就不再打后面的目标
	if !src.Alive() {
		return
	}
	result := sys.damage(src, dst, dmg, crit, skill.ID, "")
	if result.immune {
		return
	}
	sys.afterHit(src, dst, skill, result)
	if dst.Alive() && skill.Debuff != nil {
		sys.addBuff(dst, skill.Debuff)
	}
}

// damageResult 是一次伤害结算的结果。
type damageResult struct {
	immune  bool    // 目标无敌，整次伤害被免掉
	blocked float64 // 被格挡掉的伤害
	taken   float64 // 实际扣掉的生命
}

// damage 从 dst 中扣除 dmg，记录攻击者，发 DAMAGE 事件（skillID、proc 不空时写进事件），
// 并在 HP 归零时击杀 dst。无敌时整个免掉；否则先按格挡减伤，再由护盾吸收，剩下的才扣生命。
// 它不触发任何装备特效，特效自己造成的伤害（proc 不空）也走这里，所以特效不会连锁触发。
func (sys *System) damage(
	src, dst *core.Entity,
	dmg float64,
	crit bool,
	skillID string,
	proc string,
) damageResult {
	src.LastDealtAt = sys.state.Now()
	event := &core.Event{
		Kind: pb.EventKind_DAMAGE.Enum(),
		Src:  core.I32(src.ID),
		Dst:  core.I32(dst.ID),
		Crit: &crit,
	}
	if skillID != "" {
		event.Skill = proto.String(skillID)
	}
	if proc != "" {
		event.Proc = proto.String(proc)
	}
	if dst.Invulnerable() {
		event.Value = core.F32(0)
		event.Immune = proto.Bool(true)
		sys.state.Events.Emit(dst, event)
		return damageResult{immune: true}
	}
	if crit && src.AmbushUntil > 0 {
		src.AmbushUntil = 0 // 伏击的必暴用掉了
	}
	result := damageResult{}
	if dst.Blocking {
		result.blocked = math.Round(dmg * sys.state.Cfg.World.Player.Block.Reduce)
		dmg -= result.blocked
		event.Blocked = core.F32(result.blocked)
	}
	if absorbed := sys.absorb(dst, dmg); absorbed > 0 {
		dmg -= absorbed
		event.Absorbed = core.F32(absorbed)
	}
	result.taken = dmg
	event.Value = core.F32(dmg)
	dst.HP -= dmg
	dst.LastAttacker = src.ID
	dst.LastHitAt = sys.state.Now()
	sys.state.Events.Emit(dst, event)
	if dst.HP <= 0 {
		sys.Kill(dst, src)
	}
	return result
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
// 宠物打死的，经验和掉落记给它的主人；宠物自己死了按 world.yaml 的 pet.respawn 复活。
func (sys *System) Kill(entity, killer *core.Entity) {
	if entity.Dead {
		return
	}
	if killer != nil && killer.Kind == core.KindPet {
		killer = sys.state.Ents.Get(killer.Owner)
	}
	entity.Dead = true
	entity.HP = 0
	entity.Target = 0
	entity.Buffs = nil // 保留 MoveX/MoveY，使按住的按键在重生后仍然有效
	entity.Action = ""
	entity.CanPick = entity.Kind == core.KindPlayer // 玩家死亡期间可以重新挑技能
	sys.state.Events.Emit(
		entity,
		&core.Event{Kind: pb.EventKind_DIE.Enum(), Id: core.I32(entity.ID)},
	)
	delay := sys.state.Cfg.World.Player.Respawn
	if entity.Kind == core.KindPet {
		delay = sys.state.Cfg.World.Pet.Respawn
	}
	if entity.Tmpl != nil {
		delay = entity.Tmpl.Respawn
		if killer != nil && killer.Kind == core.KindPlayer {
			sys.attr.GainExp(killer, entity.Tmpl.Exp)
			if entity.Kind == core.KindMonster {
				sys.items.Loot(entity, killer)
			}
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
