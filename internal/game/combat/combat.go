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
	ErrStunned  = errors.New("硬直中")
	ErrBusy     = errors.New("正在出招")
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

// Tick 结算前摇到点的出招，清除已过期的 Buff，并结算装备的持续回血（regen）。
func (sys *System) Tick() {
	sys.resolveWindups()
	sys.state.Ents.Each(func(entity *core.Entity) {
		if !entity.Dead {
			sys.UpdateBuffs(entity)
			sys.regen(entity)
			sys.regenGuard(entity)
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
	if removed {
		entity.MarkDirty(core.DirtyShield | core.DirtyLooks)
	}
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

// CalcDamage 返回 src 使用技能 skill 对 dst 造成的伤害（整数），以及是否暴击。
// 物理技能以 Atk 对抗 Def，法术技能以 MAtk 对抗 MDef。
// 伤害 = (攻击 × ratio / 10000 + base) × 100 / (防御 + 100) × 暴击倍率 × 浮动(95%..105%)，
// 中间结果可以有小数，算完向下取整，最少 1 点。
func (sys *System) CalcDamage(src, dst *core.Entity, skill *config.Skill) (int, bool) {
	atk, def := src.Attr.Atk, dst.Attr.Def
	if skill.Damage == "magic" {
		atk, def = src.Attr.MAtk, dst.Attr.MDef
	}
	raw := fraction(atk, skill.Ratio) + float64(skill.Base)
	dmg := raw * mitigation(def)
	// 武器附魔：物理技能额外打一份法术伤害（按目标的法抗减免）
	if skill.Damage == "physical" {
		for _, buff := range src.Buffs {
			if bonus := buff.Cfg.BonusMagic; bonus > 0 {
				dmg += fraction(src.Attr.MAtk, bonus) * mitigation(dst.Attr.MDef)
			}
		}
	}
	crit := core.Roll(sys.state.Rand, src.Attr.Crit)
	// 伏击（ambush 特效）：位移后限定时间内的下一次伤害必定暴击，打中（没被免疫）才算用掉，见 damage
	if src.AmbushUntil > sys.state.Now() {
		crit = true
	}
	if crit {
		dmg = dmg * float64(src.Attr.CritDmg) / config.OneHundredPercent
	}
	// 随机浮动：9500..10500 万分比
	spread := damageSpreadLow + sys.state.Rand.Intn(damageSpreadHigh-damageSpreadLow+1)
	dmg = dmg * float64(spread) / config.OneHundredPercent
	return max(1, int(math.Floor(dmg))), crit
}

// 伤害随机浮动的范围（万分比）：95% 到 105%。
const (
	damageSpreadLow  = 9500
	damageSpreadHigh = 10500
)

// fraction 返回 value × points / 10000（不取整，给公式中间用）。
func fraction(value int, points config.BasisPoints) float64 {
	return float64(value) * float64(points) / config.OneHundredPercent
}

// mitigation 是防御 def 留下的伤害比例：100 / (def + 100)。
func mitigation(def int) float64 {
	return 100 / float64(def+100)
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
	if entity.Stunned(now) || entity.Knock != nil {
		return ErrStunned
	}
	if entity.Windup != nil {
		return ErrBusy
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
		if core.EdgeDist(entity, target) > float64(skill.Range) {
			return ErrTooFar
		}
		event := castEvent(entity, target, skill)
		sys.state.Events.Emit(entity, event)
		if skill.Windup > 0 {
			sys.startWindup(entity, skill, target.ID, event) // 到点再结算，见 impact.go
		} else {
			sys.strike(entity, skill, target.ID, false)
		}
	case "aoe":
		event := castEvent(entity, nil, skill)
		event.Radius = core.I32(skill.Radius)
		event.X, event.Y = core.FloorI32(entity.X), core.FloorI32(entity.Y)
		sys.state.Events.Emit(entity, event)
		if skill.Windup > 0 {
			sys.startWindup(entity, skill, 0, event)
		} else {
			sys.strike(entity, skill, 0, false)
		}
	case "ally":
		// 友方技能：对行为树指定的友方目标（宠物的主人）回血，目标要在 range 内
		ally := sys.state.Ents.Get(targetID)
		if !ally.Alive() || sys.state.Hostile(entity, ally) {
			return ErrNoTarget
		}
		if core.EdgeDist(entity, ally) > float64(skill.Range) {
			return ErrTooFar
		}
		sys.state.Events.Emit(entity, castEvent(entity, ally, skill))
		sys.heal(ally, config.ScaleBasisPoints(ally.Attr.MaxHP, skill.Heal), "")
	case "dash":
		dir, ok := unit(aimX, aimY)
		if !ok {
			return ErrNoAim
		}
		from := nav.Vec{X: entity.X, Y: entity.Y}
		end := sys.nav.Reach(from, dir, float64(skill.Distance), entity.Radius)
		if end.Dist(from) < 1 {
			return ErrNoRoom
		}
		event := castEvent(entity, nil, skill)
		event.X, event.Y = core.FloorI32(from.X), core.FloorI32(from.Y)
		event.Tx, event.Ty = core.FloorI32(end.X), core.FloorI32(end.Y)
		entity.SetPos(end.X, end.Y)
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
		end := sys.nav.Reach(from, dir, float64(skill.Range)+entity.Radius, projectileRadius)
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
		event.X, event.Y = core.FloorI32(from.X), core.FloorI32(from.Y)
		event.Tx, event.Ty = core.FloorI32(end.X), core.FloorI32(end.Y)
		sys.state.Events.Emit(entity, event)
		for _, hit := range hits {
			dmg, crit := sys.CalcDamage(entity, hit.entity, skill)
			sys.applyDamage(entity, hit.entity, dmg, crit, skill)
		}
	case "rain":
		if err := sys.castRain(entity, skill, targetID, aimX, aimY); err != nil {
			return err
		}
	case "charge":
		if err := sys.startCharge(entity, skill, targetID); err != nil {
			return err
		}
	case "rally":
		sys.rally(entity, skill)
	case "self":
		sys.state.Events.Emit(entity, castEvent(entity, entity, skill))
		if skill.Heal > 0 {
			amount := config.ScaleBasisPoints(entity.Attr.MaxHP, skill.Heal)
			entity.SetHP(min(entity.Attr.MaxHP, entity.HP+amount))
			sys.state.Events.Emit(
				entity,
				&core.Event{
					Kind:  pb.EventKind_HEAL.Enum(),
					Dst:   core.I32(entity.ID),
					Value: core.I32(amount),
				},
			)
		}
		if skill.Buff != nil {
			sys.addBuff(entity, skill.Buff)
		}
	case "zone":
		// 在脚下放回血区，同一个人再放一次时旧的消失
		event := castEvent(entity, nil, skill)
		event.Radius = core.I32(skill.Zone.Radius)
		event.X, event.Y = core.FloorI32(entity.X), core.FloorI32(entity.Y)
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
	// 冷却缩减（装备的 cdr，万分比）让冷却变短，向下取整到毫秒
	entity.Cooldowns[skill.ID] = now + skill.Cooldown*int64(config.OneHundredPercent-entity.Attr.CDR)/config.OneHundredPercent
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
		core.EdgeDist(entity, target) <= float64(skill.Range) {
		centerX, centerY = target.X, target.Y
	} else {
		target = nil
		dir, ok := unit(aimX, aimY)
		if !ok {
			return ErrNoAim
		}
		world := sys.state.Cfg.World.Map
		distance := float64(skill.Distance)
		centerX = math.Max(0, math.Min(float64(world.Width), entity.X+dir.X*distance))
		centerY = math.Max(0, math.Min(float64(world.Height), entity.Y+dir.Y*distance))
	}
	event := castEvent(entity, target, skill)
	event.Radius = core.I32(skill.Radius)
	event.X, event.Y = core.FloorI32(centerX), core.FloorI32(centerY)
	sys.state.Events.Emit(entity, event)
	// 先收集目标，使伤害（及其导致的击杀）不会在遍历过程中改变网格。
	var victims []*core.Entity
	sys.grid.InRange(
		centerX,
		centerY,
		float64(skill.Radius+core.MaxRadius),
		func(other *core.Entity) {
			if other.Alive() && sys.state.Hostile(entity, other) &&
				math.Max(0, math.Hypot(other.X-centerX, other.Y-centerY)-other.Radius) <= float64(skill.Radius) {
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

// AddBuff 给 entity 加上 Buff（副本房间奖励的祝福用），见 addBuff。
func (sys *System) AddBuff(entity *core.Entity, cfg *config.Buff) { sys.addBuff(entity, cfg) }

// addBuff 给 entity 加上 Buff（同名的会被刷新，不叠加），并通知客户端；返回发出的 BUFF 事件。
func (sys *System) addBuff(entity *core.Entity, cfg *config.Buff) *core.Event {
	filterBuffs(entity, func(buff *core.Buff) bool { return buff.Cfg.Name != cfg.Name })
	entity.Buffs = append(
		entity.Buffs,
		&core.Buff{
			Cfg:    cfg,
			Until:  sys.state.Now() + cfg.Duration,
			Absorb: config.ScaleBasisPoints(entity.Attr.MaxHP, cfg.ShieldPct),
		},
	)
	entity.MarkDirty(core.DirtyShield | core.DirtyLooks)
	attr.Recalc(entity)
	event := &core.Event{
		Kind: pb.EventKind_BUFF.Enum(),
		Dst:  core.I32(entity.ID),
		Name: &cfg.Name,
		Dur:  core.I32(int(cfg.Duration)),
	}
	sys.state.Events.Emit(entity, event)
	return event
}

// applyDamage 结算技能 skill 的一次命中：src 对 dst 造成 dmg 点伤害（见 damage），
// 然后触发双方装备的特效（见 effects.go 的 afterHit）。
// 技能带 Debuff 时，没被免掉、没被完美格挡、也没被打死的目标会挂上它。施法者已经死了时什么都不做。
func (sys *System) applyDamage(src, dst *core.Entity, dmg int, crit bool, skill *config.Skill) {
	// 施法者可能在同一次范围技能里被前面目标的反伤打死了，死了就不再打后面的目标
	if !src.Alive() {
		return
	}
	result := sys.damage(src, dst, dmg, crit, skill.ID, "")
	if result.immune {
		return
	}
	sys.applyImpact(src, dst, skill, result.outcome, result.event)
	sys.afterHit(src, dst, skill, result)
	if dst.Alive() && skill.Debuff != nil && result.outcome != pb.HitResult_PARRY {
		sys.addBuff(dst, skill.Debuff)
	}
}

// damageResult 是一次伤害结算的结果。
type damageResult struct {
	immune  bool         // 目标无敌，整次伤害被免掉
	outcome pb.HitResult // 怎么挨的这一下：正常命中、格挡、完美格挡、破防
	blocked int          // 被格挡掉的伤害
	taken   int          // 实际扣掉的生命
	event   *core.Event  // 发出的 DAMAGE 事件（还在队列里，applyImpact 往上补击退和硬直）
}

// damage 从 dst 中扣除 dmg，记录攻击者，发 DAMAGE 事件（skillID、proc 不空时写进事件），
// 并在 HP 归零时击杀 dst。无敌时整个免掉；否则先按格挡减伤（只挡正面，完美格挡全挡，见 guard.go），
// 再由护盾吸收，剩下的才扣生命。
// 它不触发任何装备特效，特效自己造成的伤害（proc 不空）也走这里，所以特效不会连锁触发。
func (sys *System) damage(
	src, dst *core.Entity,
	dmg int,
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
		event.Value = core.I32(0)
		event.Immune = proto.Bool(true)
		event.Result = pb.HitResult_IMMUNE.Enum()
		sys.state.Events.Emit(dst, event)
		return damageResult{immune: true}
	}
	if crit && src.AmbushUntil > 0 {
		src.AmbushUntil = 0 // 伏击的必暴用掉了
	}
	result := damageResult{event: event, outcome: pb.HitResult_HIT}
	if dst.Blocking && sys.shieldCovers(dst, src) {
		result.outcome = sys.guard(dst, sys.state.Cfg.Skills[skillID], proc)
		if result.outcome == pb.HitResult_PARRY {
			result.blocked = dmg // 完美格挡：一点都不掉
		} else {
			// 先算挨到的伤害再向下取整，挡掉的是剩下的部分
			reduce := sys.state.Cfg.World.Player.Block.Reduce
			result.blocked = dmg - config.ScaleBasisPoints(dmg, config.OneHundredPercent-reduce)
		}
		dmg -= result.blocked
		event.Blocked = core.I32(result.blocked)
		event.Result = result.outcome.Enum()
	}
	if absorbed := sys.absorb(dst, dmg); absorbed > 0 {
		dmg -= absorbed
		event.Absorbed = core.I32(absorbed)
	}
	result.taken = dmg
	event.Value = core.I32(dmg)
	dst.SetHP(dst.HP - dmg)
	dst.LastAttacker = src.ID
	dst.LastHitAt = sys.state.Now()
	sys.state.Events.Emit(dst, event)
	if dst.HP <= 0 {
		sys.Kill(dst, src)
	}
	return result
}

// absorb 用 entity 身上的护盾吸收至多 dmg 点伤害，返回吸收了多少；吸收完的护盾 Buff 被移除。
func (sys *System) absorb(entity *core.Entity, dmg int) int {
	total := 0
	for _, buff := range entity.Buffs {
		if dmg <= 0 {
			break
		}
		take := min(buff.Absorb, dmg)
		buff.Absorb -= take
		dmg -= take
		total += take
	}
	if total > 0 {
		entity.MarkDirty(core.DirtyShield) // 护盾剩余量变了
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
	entity.SetDead(true)
	entity.SetHP(0)
	entity.Windup = nil // 前摇中被打死：这一下不会再落下（击退照常走完，尸体被打飞）
	entity.StunUntil = 0
	entity.SetBlocking(false) // 倒下时盾也掉了，复活后要重新按右键
	entity.ParryUntil = 0
	entity.SetTarget(0)
	filterBuffs(entity, func(buff *core.Buff) bool { return buff.Cfg.Keep }) // 关内祝福死了也不掉
	entity.MarkDirty(core.DirtyShield | core.DirtyLooks)
	// 保留 MoveX/MoveY，使按住的按键在重生后仍然有效
	entity.SetAction("")
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
	if skill.Damage != "" {
		event.Weight = proto.String(skill.Weight)
	}
	if dst != nil {
		event.Dst = core.I32(dst.ID)
	}
	return event
}
