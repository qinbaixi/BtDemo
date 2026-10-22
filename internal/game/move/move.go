// Package move 负责在地图上移动实体：按输入行走玩家，
// 让怪物和 NPC 沿绕过障碍物的路径移动，并保证
// 所有实体都留在地图内且不穿过场景物件。
package move

import (
	"github.com/qinbaixi/BtDemo/internal/game/aoi"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
)

const (
	repathEvery  = 0.75 // 沿路径移动时两次重新规划之间的间隔（秒）
	goalMoved    = 24.0 // 目标离开规划时位置超过此距离则重新规划
	stuckSeconds = 0.4  // 几乎不动持续这么久（秒）后重新规划
)

// System 移动实体，并同步更新 AOI 网格。
type System struct {
	state *core.State
	grid  *aoi.Grid
	nav   *nav.Map
}

// New 在给定的障碍物地图上创建移动系统。
func New(state *core.State, grid *aoi.Grid, navMap *nav.Map) *System {
	return &System{state: state, grid: grid, nav: navMap}
}

// Nav 是障碍物地图。
func (sys *System) Nav() *nav.Map { return sys.nav }

func pos(entity *core.Entity) nav.Vec { return nav.Vec{X: entity.X, Y: entity.Y} }

// By 让 e 移动 (dx, dy)，遇到障碍物时沿其表面滑动。
func (sys *System) By(entity *core.Entity, dx, dy float64) {
	point := sys.nav.Resolve(nav.Vec{X: entity.X + dx, Y: entity.Y + dy}, entity.Radius)
	entity.X, entity.Y = point.X, point.Y
	sys.grid.Moved(entity)
}

// Place 把 e 放到离 (x, y) 最近的空闲位置。
func (sys *System) Place(entity *core.Entity, x, y float64) {
	point := sys.nav.NearestFree(nav.Vec{X: x, Y: y}, entity.Radius)
	entity.X, entity.Y = point.X, point.Y
	sys.grid.Moved(entity)
}

// FreeSpot 返回离 (x, y) 最近的、能放下 e 的位置。
func (sys *System) FreeSpot(entity *core.Entity, x, y float64) (float64, float64) {
	point := sys.nav.NearestFree(nav.Vec{X: x, Y: y}, entity.Radius)
	return point.X, point.Y
}

// Toward 让 e 沿路径朝 (x, y) 最多走 step 像素，并报告
// 是否已到达。若 (x, y) 无法到达，则到达最近的可达位置也算到达。
// 目标移动时路径会立即重新规划，
// 行走途中也会定时重新规划，e 卡住时同样会重新规划。
func (sys *System) Toward(entity *core.Entity, x, y, step float64) bool {
	goal := nav.Vec{X: x, Y: y}
	steering := &entity.Steering
	now := sys.state.Now()
	from := pos(entity)
	if !steering.Planned || steering.Goal.Dist(goal) > goalMoved || now >= steering.RepathAt ||
		steering.StuckFor >= stuckSeconds {
		steering.Path = sys.nav.FindPath(from, goal, entity.Radius)
		steering.Goal, steering.Planned = goal, true
		steering.Reaches = len(steering.Path) > 0 && steering.Path[len(steering.Path)-1] == goal
		steering.RepathAt = now + repathEvery
		steering.StuckFor = 0
	} else if steering.Reaches && len(steering.Path) > 0 {
		// 目标在移动：保留原计划，但把最后一段改为朝目标当前位置前进
		steering.Path[len(steering.Path)-1] = goal
		if len(steering.Path) > 1 && sys.nav.Clear(from, goal, entity.Radius) {
			steering.Path = steering.Path[:0]
			steering.Path = append(steering.Path, goal)
		}
	}
	left := step
	for left > 1e-9 && len(steering.Path) > 0 {
		waypoint := steering.Path[0]
		dist := waypoint.Dist(pos(entity))
		if dist <= left {
			sys.By(entity, waypoint.X-entity.X, waypoint.Y-entity.Y)
			left -= dist
			if pos(entity).Dist(waypoint) < 1 {
				steering.Path = steering.Path[1:]
				continue
			}
			break // 被障碍物推离了路径点
		}
		sys.By(entity, (waypoint.X-entity.X)/dist*left, (waypoint.Y-entity.Y)/dist*left)
		left = 0
	}
	if len(steering.Path) == 0 {
		// 已到达目标时，下次重新规划；位于不可达目标的最近处时，
		// 保留原计划，使搜索只按常规间隔重新运行，
		// 而不是每个 tick 都重新搜索
		if pos(entity).Dist(goal) < 2 {
			steering.Planned = false
		}
		return true
	}
	if moved := pos(entity).Dist(from); moved < step*0.25 {
		steering.StuckFor += sys.state.Clock.Dt
	} else {
		steering.StuckFor = 0
	}
	return false
}

// Stop 清除 e 的路径。
func (sys *System) Stop(entity *core.Entity) { entity.Steering = core.Steering{} }

// Tick 让每个存活的玩家按其输入方向行走。
func (sys *System) Tick() {
	dt := sys.state.Clock.Dt
	sys.state.Ents.Each(func(entity *core.Entity) {
		if entity.Kind != core.KindPlayer || entity.Dead {
			return
		}
		speed := entity.Attr.Speed
		if entity.Blocking {
			speed *= sys.state.Cfg.World.Player.Block.Speed // 格挡时走得慢
		}
		switch {
		case entity.MoveX != 0 || entity.MoveY != 0:
			sys.By(entity, entity.MoveX*speed*dt, entity.MoveY*speed*dt)
			entity.Action = "move"
		case entity.Blocking:
			entity.Action = "block"
		default:
			entity.Action = ""
		}
	})
}
