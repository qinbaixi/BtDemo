// Package move moves entities around the map: walking players by their
// input, steering monsters and NPCs along paths around obstacles, and keeping
// everyone inside the map and out of props.
package move

import (
	"github.com/qinbaixi/BtDemo/internal/game/aoi"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
)

const (
	repathEvery  = 0.75 // seconds between replans while following a path
	goalMoved    = 24.0 // replan when the goal moved this far from where we planned to
	stuckSeconds = 0.4  // replan after barely moving for this long
)

// System moves entities and keeps the AOI grid in step.
type System struct {
	s    *core.State
	grid *aoi.Grid
	nav  *nav.Map
}

// New creates the movement system on the given obstacle map.
func New(s *core.State, grid *aoi.Grid, m *nav.Map) *System {
	return &System{s: s, grid: grid, nav: m}
}

// Nav is the obstacle map.
func (m *System) Nav() *nav.Map { return m.nav }

func pos(e *core.Entity) nav.Vec { return nav.Vec{X: e.X, Y: e.Y} }

// By moves e by (dx, dy), sliding along any obstacle in the way.
func (m *System) By(e *core.Entity, dx, dy float64) {
	p := m.nav.Resolve(nav.Vec{X: e.X + dx, Y: e.Y + dy}, e.Radius)
	e.X, e.Y = p.X, p.Y
	m.grid.Moved(e)
}

// Place puts e at the free spot nearest to (x, y).
func (m *System) Place(e *core.Entity, x, y float64) {
	p := m.nav.NearestFree(nav.Vec{X: x, Y: y}, e.Radius)
	e.X, e.Y = p.X, p.Y
	m.grid.Moved(e)
}

// FreeSpot returns the spot nearest to (x, y) where e fits.
func (m *System) FreeSpot(e *core.Entity, x, y float64) (float64, float64) {
	p := m.nav.NearestFree(nav.Vec{X: x, Y: y}, e.Radius)
	return p.X, p.Y
}

// Toward walks e at most step pixels along a path to (x, y) and reports
// whether it arrived. When (x, y) cannot be reached, arriving at the closest
// reachable spot counts. The path is replanned when the goal moves, now and
// then while walking, and when e gets stuck.
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
		// a moving goal: keep the plan but aim the last leg at where it is now
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
			break // pushed off the waypoint by an obstacle
		}
		m.By(e, (wp.X-e.X)/d*left, (wp.Y-e.Y)/d*left)
		left = 0
	}
	if len(st.Path) == 0 {
		// at the goal, plan afresh next time; at the closest spot to an
		// unreachable goal, keep the plan so the search only reruns on the
		// usual schedule instead of every tick
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

// Stop forgets e's path.
func (m *System) Stop(e *core.Entity) { e.Steering = core.Steering{} }

// Tick walks every living player in its input direction.
func (m *System) Tick() {
	dt := m.s.Clock.Dt
	m.s.Ents.Each(func(e *core.Entity) {
		if e.Kind != core.KindPlayer || e.Dead {
			return
		}
		if e.MoveX != 0 || e.MoveY != 0 {
			m.By(e, e.MoveX*e.Attr.Speed*dt, e.MoveY*e.Attr.Speed*dt)
			e.Action = "move"
		} else {
			e.Action = ""
		}
	})
}
