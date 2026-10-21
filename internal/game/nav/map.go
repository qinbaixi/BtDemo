package nav

import (
	"math"
)

const (
	bucketSize = 64.0 // spatial hash cell for obstacle lookups
	maxPush    = 4    // collision passes per move
)

// Map is the static obstacle set of a w×h map.
type Map struct {
	W, H    float64
	shapes  []Shape
	cols    int
	rows    int
	buckets [][]int32 // shape indices per bucket, padded by MaxRadius
	grids   map[int]*Grid
}

// MaxRadius is the largest entity radius collision queries expect; bucket
// lookups are padded by it.
const MaxRadius = 64.0

// New indexes shapes on a w×h map.
func New(w, h float64, shapes []Shape) *Map {
	m := &Map{W: w, H: h, shapes: shapes, grids: map[int]*Grid{}}
	m.cols = int(math.Ceil(w / bucketSize))
	m.rows = int(math.Ceil(h / bucketSize))
	m.buckets = make([][]int32, m.cols*m.rows)
	for i, s := range shapes {
		lo, hi := s.bounds(MaxRadius)
		m.eachBucket(lo, hi, func(b int) { m.buckets[b] = append(m.buckets[b], int32(i)) })
	}
	return m
}

// Shapes returns every obstacle.
func (m *Map) Shapes() []Shape { return m.shapes }

func (m *Map) eachBucket(lo, hi Vec, fn func(int)) {
	x0 := int(clamp(math.Floor(lo.X/bucketSize), 0, float64(m.cols-1)))
	x1 := int(clamp(math.Floor(hi.X/bucketSize), 0, float64(m.cols-1)))
	y0 := int(clamp(math.Floor(lo.Y/bucketSize), 0, float64(m.rows-1)))
	y1 := int(clamp(math.Floor(hi.Y/bucketSize), 0, float64(m.rows-1)))
	for y := y0; y <= y1; y++ {
		for x := x0; x <= x1; x++ {
			fn(y*m.cols + x)
		}
	}
}

// near returns the shapes that may touch a circle at p (radius up to MaxRadius).
func (m *Map) near(p Vec) []int32 {
	x := int(clamp(math.Floor(p.X/bucketSize), 0, float64(m.cols-1)))
	y := int(clamp(math.Floor(p.Y/bucketSize), 0, float64(m.rows-1)))
	return m.buckets[y*m.cols+x]
}

// InBounds keeps a circle of radius r inside the map.
func (m *Map) InBounds(p Vec, r float64) Vec {
	return Vec{clamp(p.X, r, m.W-r), clamp(p.Y, r, m.H-r)}
}

// Free reports whether a circle of radius r fits at p.
func (m *Map) Free(p Vec, r float64) bool {
	if p.X < r || p.Y < r || p.X > m.W-r || p.Y > m.H-r {
		return false
	}
	for _, i := range m.near(p) {
		if m.shapes[i].Dist(p) < r {
			return false
		}
	}
	return true
}

// Resolve moves a circle of radius r at p out of every obstacle and back
// inside the map. Pushing along the contact normal is what makes a mover
// slide along walls instead of stopping dead.
func (m *Map) Resolve(p Vec, r float64) Vec {
	p = m.InBounds(p, r)
	for pass := 0; pass < maxPush; pass++ {
		moved := false
		for _, i := range m.near(p) {
			if q, ok := m.shapes[i].push(p, r); ok {
				p, moved = q, true
			}
		}
		p = m.InBounds(p, r)
		if !moved {
			break
		}
	}
	return p
}

// Clear reports whether a circle of radius r can travel in a straight line
// from a to b without touching an obstacle.
func (m *Map) Clear(a, b Vec, r float64) bool {
	d := a.Dist(b)
	step := math.Max(2, math.Min(r, 8))
	n := int(math.Ceil(d / step))
	for i := 1; i <= n; i++ {
		if !m.Free(lerp(a, b, float64(i)/float64(n)), r) {
			return false
		}
	}
	return true
}

// NearestFree returns the free spot for a circle of radius r closest to p
// (p itself when it is free), searching outward on the path grid.
func (m *Map) NearestFree(p Vec, r float64) Vec {
	p = m.InBounds(p, r)
	if m.Free(p, r) {
		return p
	}
	g := m.grid(r)
	if c, ok := g.nearestOpen(g.cellOf(p), 64); ok {
		return g.center(c)
	}
	return p
}

// FindPath returns waypoints for a circle of radius r from a to b, not
// including a. When b cannot be reached the path ends at the reachable spot
// closest to it. It returns nil when a and b are the same spot.
func (m *Map) FindPath(a, b Vec, r float64) []Vec {
	if a.Dist(b) < 0.5 {
		return nil
	}
	if m.Clear(a, b, r) {
		return []Vec{b}
	}
	g := m.grid(r)
	cells := g.astar(a, b)
	pts := make([]Vec, 0, len(cells)+2)
	if g.blocked[g.cellOf(a)] {
		// standing where the grid is too coarse to see room: step to open ground first
		if c, ok := g.nearestOpen(g.cellOf(a), 8); ok {
			pts = append(pts, g.center(c))
		}
	}
	for _, c := range cells {
		pts = append(pts, g.center(c))
	}
	// finish on the exact goal when it can be reached from the last cell
	last := a
	if len(pts) > 0 {
		last = pts[len(pts)-1]
	}
	if m.Clear(last, b, r) {
		pts = append(pts, b)
	}
	if len(pts) == 0 {
		return nil
	}
	return m.smooth(a, pts, r)
}

// smooth drops waypoints that a straight line can skip (string pulling).
func (m *Map) smooth(from Vec, pts []Vec, r float64) []Vec {
	out := pts[:0:0]
	anchor := from
	i := 0
	for i < len(pts) {
		j := i
		for j+1 < len(pts) && m.Clear(anchor, pts[j+1], r) {
			j++
		}
		out = append(out, pts[j])
		anchor = pts[j]
		i = j + 1
	}
	return out
}

// grid returns the path grid for movers of radius r, building it on first use.
// Radii are rounded up to a multiple of 4 so similar movers share a grid.
func (m *Map) grid(r float64) *Grid {
	class := int(math.Ceil(r/4)) * 4
	if g, ok := m.grids[class]; ok {
		return g
	}
	g := newGrid(m, float64(class))
	m.grids[class] = g
	return g
}
