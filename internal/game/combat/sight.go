package combat

import (
	"math"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 视线遮挡：单体远程技能（config.Skill.NeedsSight）出手时要看得见目标，
// 飞到的时候（前摇结束结算）目标躲到了障碍物后面，就打在障碍物上（DAMAGE 事件，result = COVER）。

// HasSight 报告 entity 能不能看见 target：两人中心之间的直线没被障碍物挡住。
func (sys *System) HasSight(entity, target *core.Entity) bool {
	return sys.nav.Sight(nav.Vec{X: entity.X, Y: entity.Y}, nav.Vec{X: target.X, Y: target.Y})
}

// SightFrom 报告站在 (x, y) 能不能看见 target（行为树找射击位用）。
func (sys *System) SightFrom(x, y float64, target *core.Entity) bool {
	return sys.nav.Sight(nav.Vec{X: x, Y: y}, nav.Vec{X: target.X, Y: target.Y})
}

// hitCover 是飞行中的投射物打在了挡在中间的东西上：不伤人，发一个 COVER 的 DAMAGE 事件，
// tx、ty 是投射物停下的位置（客户端让箭停在那里、迸出碎屑）。
func (sys *System) hitCover(entity, target *core.Entity, skill *config.Skill) {
	from := nav.Vec{X: entity.X, Y: entity.Y}
	dir, ok := unit(target.X-entity.X, target.Y-entity.Y)
	stop := from
	if ok {
		distance := math.Hypot(target.X-entity.X, target.Y-entity.Y)
		stop = sys.nav.Reach(from, dir, distance, 3)
	}
	sys.state.Events.Emit(
		target,
		&core.Event{
			Kind:   pb.EventKind_DAMAGE.Enum(),
			Src:    core.I32(entity.ID),
			Dst:    core.I32(target.ID),
			Skill:  proto.String(skill.ID),
			Value:  core.I32(0),
			Result: pb.HitResult_COVER.Enum(),
			Tx:     core.FloorI32(stop.X),
			Ty:     core.FloorI32(stop.Y),
		},
	)
}
