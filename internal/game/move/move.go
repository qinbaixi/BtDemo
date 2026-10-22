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
	s    *core.State
	grid *aoi.Grid
	nav  *nav.Map
}

// New 在给定的障碍物地图上创建移动系统。
func New(s *core.State, grid *aoi.Grid, m *nav.Map) *System {
	return &System{s: s, grid: grid, nav: m}
}

// Nav 是障碍物地图。
func (m *System) Nav() *nav.Map { return m.nav }

func pos(e *core.Entity) nav.Vec { return nav.Vec{X: e.X, Y: e.Y} }

// By 让 e 移动 (dx, dy)，遇到障碍物时沿其表面滑动。
func (m *System) By(e *core.Entity, dx, dy float64) {
	p := m.nav.Resolve(nav.Vec{X: e.X + dx, Y: e.Y + dy}, e.Radius)
	e.X, e.Y = p.X, p.Y
	m.grid.Moved(e)
}

// Place 把 e 放到离 (x, y) 最近的空闲位置。
func (m *System) Place(e *core.Entity, x, y float64) {
	p := m.nav.NearestFree(nav.Vec{X: x, Y: y}, e.Radius)
	e.X, e.Y = p.X, p.Y
	m.grid.Moved(e)
}

// FreeSpot 返回离 (x, y) 最近的、能放下 e 的位置。
func (m *System) FreeSpot(e *core.Entity, x, y float64) (float64, float64) {
	p := m.nav.NearestFree(nav.Vec{X: x, Y: y}, e.Radius)
	return p.X, p.Y
}

// Toward 让 e 沿路径朝 (x, y) 最多走 step 像素，并报告
// 是否已到达。若 (x, y) 无法到达，则到达最近的可达位置也算到达。
// 目标移动时路径会立即重新规划，
// 行走途中也会定时重新规划，e 卡住时同样会重新规划。
func (m *System) Toward(e *core.Entity, x, y, step float64) bool {
	goal := nav.Vec{X: x, Y: y}
	st := &e.Steering
	now := m.s.Now()
	from := pos(e)
	if !st.Planned || st.Goal.Dist(goal) > goalMoved || now >= st.RepathAt || st.StuckFor >= stuckSeconds {
		st.Path = m.nav.FindPath(from, goal, e.Radius)
		st.Goal, st.Planned = goal, true
		st.Reaches = len(st.Path) > 0 && st.Path[len(st.Path)-1] == goal
		st.RepathAt = now + repathEvery
		st.StuckFor = 0
	} else if st.Reaches && len(st.Path) > 0 {
		// 目标在移动：保留原计划，但把最后一段改为朝目标当前位置前进
		st.Path[len(st.Path)-1] = goal
		if len(st.Path) > 1 && m.nav.Clear(from, goal, e.Radius) {
			st.Path = st.Path[:0]
			st.Path = append(st.Path, goal)
		}
	}
	left := step
	for left > 1e-9 && len(st.Path) > 0 {
		wp := st.Path[0]
		d := wp.Dist(pos(e))
		if d <= left {
			m.By(e, wp.X-e.X, wp.Y-e.Y)
			left -= d
			if pos(e).Dist(wp) < 1 {
				st.Path = st.Path[1:]
				continue
			}
			break // 被障碍物推离了路径点
		}
		m.By(e, (wp.X-e.X)/d*left, (wp.Y-e.Y)/d*left)
		left = 0
	}
	if len(st.Path) == 0 {
		// 已到达目标时，下次重新规划；位于不可达目标的最近处时，
		// 保留原计划，使搜索只按常规间隔重新运行，
		// 而不是每个 tick 都重新搜索
		if pos(e).Dist(goal) < 2 {
			st.Planned = false
		}
		return true
	}
	if moved := pos(e).Dist(from); moved < step*0.25 {
		st.StuckFor += m.s.Clock.Dt
	} else {
		st.StuckFor = 0
	}
	return false
}

// Stop 清除 e 的路径。
func (m *System) Stop(e *core.Entity) { e.Steering = core.Steering{} }

// Tick 让每个存活的玩家按其输入方向行走。
func (m *System) Tick() {
	dt := m.s.Clock.Dt
	m.s.Ents.Each(func(e *core.Entity) {
		if e.Kind != core.KindPlayer || e.Dead {
			return
		}
		speed := e.Attr.Speed
		if e.Blocking {
			speed *= m.s.Cfg.World.Player.Block.Speed // 格挡时走得慢
		}
		switch {
		case e.MoveX != 0 || e.MoveY != 0:
			m.By(e, e.MoveX*speed*dt, e.MoveY*speed*dt)
			e.Action = "move"
		case e.Blocking:
			e.Action = "block"
		default:
			e.Action = ""
		}
	})
}
