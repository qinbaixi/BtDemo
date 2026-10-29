// Package portal 负责地图上通往别的场景的传送门（地图 portals 图层）：玩家站进传送门 Dwell 毫秒就出发，
// 到了目标场景落在通回来的那扇传送门旁边。真正的迁移由场景（game.Scene）和场景管理器做。
package portal

import (
	"math"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/core"
)

// Dwell 是站进传送门多少毫秒后出发：路过时擦一下不会被传走。
const Dwell config.Millis = 600

// arriveGap 是到达时离传送门中心多远（朝出生点的方向）：落在门外，不会马上又被传回去。
const arriveGap = 90

// System 记录谁站在传送门里。
type System struct {
	state    *core.State
	portals  []config.Portal
	standing map[int]config.Millis // 玩家实体 ID -> 站进传送门的时刻
}

// New 创建传送门系统，传送门来自这个场景的地图。
func New(state *core.State) *System {
	return &System{state: state, portals: state.Cfg.Layout.Portals, standing: map[int]config.Millis{}}
}

// List 是这个场景的传送门。
func (sys *System) List() []config.Portal { return sys.portals }

// Tick 检查 players 列出的每个玩家：活着、在传送门里站够了 Dwell 秒的，调用 travel。
// 没站在传送门里的玩家清掉计时。
func (sys *System) Tick(
	players func(fn func(*core.Entity)),
	travel func(player *core.Entity, portal *config.Portal),
) {
	if len(sys.portals) == 0 {
		return
	}
	now := sys.state.Now()
	standing := map[int]config.Millis{}
	var ready []*core.Entity
	var readyAt []*config.Portal
	players(func(player *core.Entity) {
		portal := sys.inside(player)
		if portal == nil || player.Dead {
			return
		}
		since, ok := sys.standing[player.ID]
		if !ok {
			since = now
		}
		if now-since >= Dwell {
			ready = append(ready, player)
			readyAt = append(readyAt, portal)
			return
		}
		standing[player.ID] = since
	})
	sys.standing = standing
	for i, player := range ready {
		travel(player, readyAt[i]) // 在遍历之外调用：travel 会把玩家移出场景
	}
}

// inside 返回 player 站在里面的传送门，没有返回 nil。
func (sys *System) inside(player *core.Entity) *config.Portal {
	for i := range sys.portals {
		portal := &sys.portals[i]
		if math.Hypot(player.X-float64(portal.X), player.Y-float64(portal.Y)) <= float64(portal.Radius) {
			return portal
		}
	}
	return nil
}

// Arrival 是从场景 from 过来的玩家落在哪里：这个场景里通往 from 的传送门外面
// （朝出生点 spawn 的方向挪开一点）；没有通回去的门（比如换线）就落在出生点。
func (sys *System) Arrival(from string, spawn config.Point) (float64, float64) {
	for _, portal := range sys.portals {
		if portal.To != from {
			continue
		}
		dx, dy := float64(spawn.X-portal.X), float64(spawn.Y-portal.Y)
		length := math.Hypot(dx, dy)
		if length < 1 {
			dx, dy, length = 0, 1, 1
		}
		gap := float64(portal.Radius + arriveGap)
		return float64(portal.X) + dx/length*gap, float64(portal.Y) + dy/length*gap
	}
	return sys.state.ScatterAround(spawn)
}
