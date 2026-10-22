// Package zone 负责地上的回血区：地图自带的常驻泉水，和技能放下的限时法阵。
// 站在区域里的友方每隔一段时间回一次血；限时的到点消失。
package zone

import (
	"math"

	"github.com/qinbaixi/BtDemo/internal/game/aoi"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// System 让回血区回血、到点消失。
type System struct {
	state *core.State
	grid  *aoi.Grid
}

// New 创建回血区系统，并放下 world.yaml 里配置的常驻回血区。
func New(state *core.State, grid *aoi.Grid) *System {
	for _, cfg := range state.Cfg.World.HealZones {
		state.Zones.Add(&core.Zone{
			Cfg:       cfg,
			X:         cfg.X,
			Y:         cfg.Y,
			Faction:   cfg.Faction,
			NextPulse: state.Now() + cfg.Interval,
		})
	}
	return &System{state: state, grid: grid}
}

// Tick 移除到点的区域，并让到了时间的区域回一次血。
func (sys *System) Tick() {
	now := sys.state.Now()
	sys.state.Zones.Filter(func(zone *core.Zone) bool { return zone.Until == 0 || zone.Until > now })
	for _, zone := range sys.state.Zones.List() {
		if now >= zone.NextPulse-1e-9 { // 时钟是累加的浮点数，留一点余量免得晚一个 tick
			zone.NextPulse += zone.Cfg.Interval
			sys.pulse(zone)
		}
	}
}

// pulse 给站在 zone 里（地上画的椭圆）、没满血的友方回一次血。
func (sys *System) pulse(zone *core.Zone) {
	var targets []*core.Entity
	sys.grid.InRange(zone.X, zone.Y, zone.Cfg.Radius, func(entity *core.Entity) {
		if entity.Alive() && sys.Friendly(zone, entity) && entity.HP < entity.Attr.MaxHP &&
			zone.Cfg.Contains(zone.X, zone.Y, entity.X, entity.Y) {
			targets = append(targets, entity)
		}
	})
	for _, entity := range targets {
		before := entity.HP
		entity.HP = math.Min(entity.Attr.MaxHP, entity.HP+math.Round(entity.Attr.MaxHP*zone.Cfg.Heal))
		amount := math.Round(entity.HP - before) // 报实际回了多少（快满血时比 heal 少）
		sys.state.Events.Emit(
			entity,
			&core.Event{
				Kind:  pb.EventKind_HEAL.Enum(),
				Dst:   core.I32(entity.ID),
				Value: core.F32(amount),
				Zone:  core.I32(zone.ID),
			},
		)
	}
}

// Friendly 报告 entity 能不能在 zone 里回血：它的阵营和区域阵营谁也不打谁。
func (sys *System) Friendly(zone *core.Zone, entity *core.Entity) bool {
	cfg := sys.state.Cfg
	return !cfg.Hostile(zone.Faction, entity.Faction) && !cfg.Hostile(entity.Faction, zone.Faction)
}
