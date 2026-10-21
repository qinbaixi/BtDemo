package nav

import (
	"container/heap"
	"math"
)

// CellSize is the side of a path grid cell in pixels.
const CellSize = 16.0

// Grid marks which cells a mover of one radius can stand in.
type Grid struct {
	cols, rows int
	blocked    []bool

	// A* scratch, reused between searches; stamp tells current entries from stale ones
	g     []float64
	from  []int32
	stamp []uint32
	shut  []uint32
	gen   uint32
	open  openList
}

func newGrid(m *Map, r float64) *Grid {
	g := &Grid{cols: int(math.Ceil(m.W / CellSize)), rows: int(math.Ceil(m.H / CellSize))}
	n := g.cols * g.rows
	g.blocked = make([]bool, n)
	g.g = make([]float64, n)
	g.from = make([]int32, n)
	g.stamp = make([]uint32, n)
	g.shut = make([]uint32, n)
	for c := 0; c < n; c++ {
		p := g.center(c)
		g.blocked[c] = p.X < r || p.Y < r || p.X > m.W-r || p.Y > m.H-r
	}
	for _, s := range m.shapes {
		lo, hi := s.bounds(r + CellSize)
		x0, y0 := g.xy(lo)
		x1, y1 := g.xy(hi)
		for y := y0; y <= y1; y++ {
			for x := x0; x <= x1; x++ {
				c := y*g.cols + x
				if !g.blocked[c] && s.Dist(g.center(c)) < r {
					g.blocked[c] = true
				}
			}
		}
	}
	return g
}

func (g *Grid) xy(p Vec) (int, int) {
	x := int(clamp(math.Floor(p.X/CellSize), 0, float64(g.cols-1)))
	y := int(clamp(math.Floor(p.Y/CellSize), 0, float64(g.rows-1)))
	return x, y
}

func (g *Grid) cellOf(p Vec) int {
	x, y := g.xy(p)
	return y*g.cols + x
}

func (g *Grid) center(c int) Vec {
	return Vec{(float64(c%g.cols) + 0.5) * CellSize, (float64(c/g.cols) + 0.5) * CellSize}
}

// nearestOpen finds the open cell nearest to c within maxRing rings.
func (g *Grid) nearestOpen(c, maxRing int) (int, bool) {
	if !g.blocked[c] {
		return c, true
	}
	cx, cy := c%g.cols, c/g.cols
	for ring := 1; ring <= maxRing; ring++ {
		best, bestD := -1, math.Inf(1)
		for dy := -ring; dy <= ring; dy++ {
			for dx := -ring; dx <= ring; dx++ {
				if max(abs(dx), abs(dy)) != ring {
					continue
				}
				x, y := cx+dx, cy+dy
				if x < 0 || y < 0 || x >= g.cols || y >= g.rows {
					continue
				}
				if n := y*g.cols + x; !g.blocked[n] {
					if d := float64(dx*dx + dy*dy); d < bestD {
						best, bestD = n, d
					}
				}
			}
		}
		if best >= 0 {
			return best, true
		}
	}
	return 0, false
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

var dirs = [8][3]int{{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {1, 1, 1}, {1, -1, 1}, {-1, 1, 1}, {-1, -1, 1}}

// astar returns the cells from a's cell (exclusive) to b's cell, or to the
// cell closest to b when b is cut off. Blocked start and goal cells are
// swapped for the nearest open ones.
func (g *Grid) astar(a, b Vec) []int {
	start, ok := g.nearestOpen(g.cellOf(a), 8)
	if !ok {
		return nil
	}
	goal, ok := g.nearestOpen(g.cellOf(b), 64)
	if !ok {
		return nil
	}
	gx, gy := goal%g.cols, goal/g.cols
	h := func(c int) float64 {
		dx, dy := float64(abs(c%g.cols-gx)), float64(abs(c/g.cols-gy))
		return dx + dy + (math.Sqrt2-2)*math.Min(dx, dy) // octile distance
	}
	g.gen++
	if g.gen == 0 { // wrapped: clear the stamps once
		clear(g.stamp)
		clear(g.shut)
		g.gen = 1
	}
	g.open = g.open[:0]
	g.stamp[start], g.g[start], g.from[start] = g.gen, 0, -1
	heap.Push(&g.open, node{start, h(start)})
	best, bestH := start, h(start)
	for g.open.Len() > 0 {
		cur := heap.Pop(&g.open).(node).cell
		if g.shut[cur] == g.gen {
			continue
		}
		g.shut[cur] = g.gen
		if hc := h(cur); hc < bestH {
			best, bestH = cur, hc
		}
		if cur == goal {
			break
		}
		cx, cy := cur%g.cols, cur/g.cols
		for _, d := range dirs {
			x, y := cx+d[0], cy+d[1]
			if x < 0 || y < 0 || x >= g.cols || y >= g.rows {
				continue
			}
			n := y*g.cols + x
			if g.blocked[n] || g.shut[n] == g.gen {
				continue
			}
			cost := 1.0
			if d[2] == 1 {
				// no cutting corners past an obstacle
				if g.blocked[cy*g.cols+x] || g.blocked[y*g.cols+cx] {
					continue
				}
				cost = math.Sqrt2
			}
			ng := g.g[cur] + cost
			if g.stamp[n] == g.gen && ng >= g.g[n] {
				continue
			}
			g.stamp[n], g.g[n], g.from[n] = g.gen, ng, int32(cur)
			heap.Push(&g.open, node{n, ng + h(n)})
		}
	}
	var path []int
	for c := best; c != start; c = int(g.from[c]) {
		path = append(path, c)
	}
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return path
}

type node struct {
	cell int
	f    float64
}

type openList []node

func (o openList) Len() int           { return len(o) }
func (o openList) Less(i, j int) bool { return o[i].f < o[j].f }
func (o openList) Swap(i, j int)      { o[i], o[j] = o[j], o[i] }
func (o *openList) Push(x any)        { *o = append(*o, x.(node)) }
func (o *openList) Pop() any {
	old := *o
	n := old[len(old)-1]
	*o = old[:len(old)-1]
	return n
}
