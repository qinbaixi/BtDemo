package combat

import (
	"math"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 震地（kind: quake）和撞碎石柱：献祭坑首领「血槌」用的。
//
// 震地分两段：
//  1. 出招：和 aoe 一样发 CAST（x、y 是脚下，radius 是冲击环最远扩到哪，hit_at 落地时刻），
//     客户端画跳起和落点的预警圈；
//  2. 落地（quake）：发 CAST（fx 加 "_go"，带 rings、ring_gap、ring_speed），之后每个 tick
//     看每一圈环扩到哪了：环的边扫过谁（离落点的距离落在环的厚度里），就打谁一下，每圈每人只挨一下。
//     环是地上横着的椭圆（和客户端画的一样，见 groundSquash），上下方向只扩到一半远。
//     环往外扩得比人跑得快，要么一开始就站到 radius 以外，要么举盾挡（算远程，能挡不能弹开）。
//
// 冲锋撞墙时，如果挡住它的是模板 charge_break 的东西（石柱），那东西就碎了（见 breakObstacle）。

// groundSquash 是地面在屏幕上竖直方向压扁的倍数：客户端把地上的圈画成横着的椭圆（竖直半径只有一半），
// 冲击环按画出来的样子算：竖直方向的距离 × 2 再和半径比，玩家看到环碰到脚才挨打。
const groundSquash = 2

// ringWidth 是冲击环的厚度（像素）：离落点的距离在 [环半径 - ringWidth, 环半径] 里的人被打到。
// 每 tick 环扩 ring_speed / 20 像素，厚度要比这个大，免得环从人身上跳过去。
const ringWidth = 28

// chargeBreakReach 是冲锋停下的地方离石柱边缘多近算撞上了（像素）。
const chargeBreakReach = 24

// quake 是一次还在扩的震地。
type quake struct {
	source *core.Entity
	skill  *config.Skill
	center nav.Vec
	start  config.Millis
	hit    map[int]int // 实体 ID -> 被第几圈打过（位掩码，第 i 圈是 1 << i）
}

// startQuake 开始震地的前摇（跳起来）。
func (sys *System) startQuake(entity *core.Entity, skill *config.Skill) {
	event := castEvent(entity, nil, skill)
	event.Radius = core.I32(skill.Radius)
	event.X, event.Y = core.FloorI32(entity.X), core.FloorI32(entity.Y)
	sys.state.Events.Emit(entity, event)
	sys.startWindup(entity, skill, 0, event)
}

// landQuake 在震地前摇结束时落地，放出冲击环。
func (sys *System) landQuake(entity *core.Entity, skill *config.Skill) {
	now := sys.state.Now()
	center := nav.Vec{X: entity.X, Y: entity.Y}
	event := &core.Event{
		Kind:      pb.EventKind_CAST.Enum(),
		Src:       core.I32(entity.ID),
		Skill:     proto.String(skill.ID),
		Fx:        proto.String(skill.FX + "_go"),
		Color:     proto.String(skill.Color),
		X:         core.FloorI32(center.X),
		Y:         core.FloorI32(center.Y),
		Radius:    core.I32(skill.Radius),
		Rings:     core.I32(skill.Rings),
		RingGap:   core.I32(int(skill.RingGap)),
		RingSpeed: core.I32(skill.RingSpeed),
	}
	sys.state.Events.Emit(entity, event)
	sys.quakes = append(sys.quakes, &quake{
		source: entity,
		skill:  skill,
		center: center,
		start:  now,
		hit:    map[int]int{},
	})
}

// tickQuakes 让每一次震地的冲击环往外扩，打环扫过的人；全部扩完的震地移除。
func (sys *System) tickQuakes() {
	if len(sys.quakes) == 0 {
		return
	}
	now := sys.state.Now()
	kept := sys.quakes[:0]
	for _, current := range sys.quakes {
		if sys.spreadQuake(current, now) {
			kept = append(kept, current)
		}
	}
	clear(sys.quakes[len(kept):])
	sys.quakes = kept
}

// spreadQuake 结算 current 这一 tick 的冲击环，还有环没扩完时返回 true。
func (sys *System) spreadQuake(current *quake, now config.Millis) bool {
	skill := current.skill
	maxRadius := float64(skill.Radius)
	if !current.source.Alive() {
		return false // 首领死了，环也散了
	}
	going := false
	type victim struct {
		entity *core.Entity
		ring   int
	}
	var victims []victim
	for ring := range skill.Rings {
		elapsed := now - current.start - config.Millis(ring)*skill.RingGap
		if elapsed < 0 {
			going = true
			continue
		}
		radius := float64(elapsed) * float64(skill.RingSpeed) / 1000
		if radius-ringWidth > maxRadius {
			continue
		}
		going = true
		radius = min(radius, maxRadius)
		bit := 1 << ring
		sys.grid.InRange(current.center.X, current.center.Y, radius+core.MaxRadius, func(other *core.Entity) {
			if !other.Alive() || !sys.state.Hostile(current.source, other) || current.hit[other.ID]&bit != 0 {
				return
			}
			dist := math.Hypot(other.X-current.center.X, (other.Y-current.center.Y)*groundSquash)
			// 环的边碰到身体就算：身体的任何一部分落在环的厚度里
			if dist-other.Radius <= radius && dist+other.Radius >= radius-ringWidth {
				current.hit[other.ID] |= bit
				victims = append(victims, victim{entity: other, ring: ring})
			}
		})
	}
	// 先收集再结算：结算里的击杀不会打乱网格遍历
	for _, hit := range victims {
		dmg, crit := sys.CalcDamage(current.source, hit.entity, skill)
		sys.applyDamage(current.source, hit.entity, dmg, crit, skill)
	}
	return going
}

// breakObstacle 在 entity 冲锋撞墙停在 end 时调用：挡住它的如果是 charge_break 的东西（石柱），把它撞碎。
// 返回撞碎的东西，没有返回 nil。
func (sys *System) breakObstacle(entity *core.Entity, end nav.Vec) *core.Entity {
	var broken *core.Entity
	best := 0.0
	reach := entity.Radius + core.MaxRadius + chargeBreakReach
	sys.grid.InRange(end.X, end.Y, reach, func(other *core.Entity) {
		if !other.Alive() || other.Tmpl == nil || !other.Tmpl.ChargeBreak {
			return
		}
		gap := end.Dist(nav.Vec{X: other.X, Y: other.Y}) - entity.Radius - other.Radius
		if gap <= chargeBreakReach && (broken == nil || gap < best) {
			broken, best = other, gap
		}
	})
	if broken != nil {
		sys.Kill(broken, entity)
	}
	return broken
}
