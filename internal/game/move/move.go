// Package move moves entities around the map: steering toward a point,
// keeping inside the map bounds, and walking players by their input.
package move

import (
	"math"

	"github.com/qinbaixi/BtDemo/internal/game/aoi"
	"github.com/qinbaixi/BtDemo/internal/game/core"
)

// System moves entities and keeps the AOI grid in step.
type System struct {
	s    *core.State
	grid *aoi.Grid
}

// New creates the movement system.
func New(s *core.State, grid *aoi.Grid) *System { return &System{s: s, grid: grid} }

// Toward moves e toward (x, y) by at most step pixels and reports whether it
// arrived.
func (m *System) Toward(e *core.Entity, x, y, step float64) bool {
	dx, dy := x-e.X, y-e.Y
	d := math.Hypot(dx, dy)
	if d <= step || d < 0.5 {
		m.By(e, dx, dy)
		return true
	}
	m.By(e, dx/d*step, dy/d*step)
	return false
}

// By moves e by (dx, dy), clamped to the map.
func (m *System) By(e *core.Entity, dx, dy float64) {
	e.X, e.Y = m.Clamp(e, e.X+dx, e.Y+dy)
	m.grid.Moved(e)
}

// Place puts e at (x, y), clamped to the map.
func (m *System) Place(e *core.Entity, x, y float64) {
	e.X, e.Y = m.Clamp(e, x, y)
	m.grid.Moved(e)
}

// Clamp keeps a point where e fits inside the map.
func (m *System) Clamp(e *core.Entity, x, y float64) (float64, float64) {
	mp := m.s.Cfg.World.Map
	return math.Max(e.Radius, math.Min(mp.Width-e.Radius, x)), math.Max(e.Radius, math.Min(mp.Height-e.Radius, y))
}

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
