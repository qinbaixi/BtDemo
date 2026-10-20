package game

import "math"

// Grid is a nine-grid AOI: the map is cut into square cells and an observer
// sees the entities in its own cell and the eight cells around it.
type Grid struct {
	Cell       float64
	Cols, Rows int
	cells      []map[int]*Entity
}

// NewGrid creates a grid covering a w×h map.
func NewGrid(w, h, cell float64) *Grid {
	g := &Grid{Cell: cell, Cols: int(math.Ceil(w / cell)), Rows: int(math.Ceil(h / cell))}
	g.cells = make([]map[int]*Entity, g.Cols*g.Rows)
	for i := range g.cells {
		g.cells[i] = map[int]*Entity{}
	}
	return g
}

// CellOf returns the index of the cell containing (x, y), clamped to the map.
func (g *Grid) CellOf(x, y float64) int {
	cx := clampInt(int(x/g.Cell), 0, g.Cols-1)
	cy := clampInt(int(y/g.Cell), 0, g.Rows-1)
	return cy*g.Cols + cx
}

// Add puts e into the grid.
func (g *Grid) Add(e *Entity) {
	e.cell = g.CellOf(e.X, e.Y)
	g.cells[e.cell][e.ID] = e
	e.inGrid = true
}

// Remove takes e out of the grid.
func (g *Grid) Remove(e *Entity) {
	if !e.inGrid {
		return
	}
	delete(g.cells[e.cell], e.ID)
	e.inGrid = false
}

// Moved updates e's cell after its position changed.
func (g *Grid) Moved(e *Entity) {
	if !e.inGrid {
		return
	}
	c := g.CellOf(e.X, e.Y)
	if c != e.cell {
		delete(g.cells[e.cell], e.ID)
		e.cell = c
		g.cells[c][e.ID] = e
	}
}

// Neighbors calls fn for every entity in the nine cells around cell.
func (g *Grid) Neighbors(cell int, fn func(*Entity)) {
	cx, cy := cell%g.Cols, cell/g.Cols
	for y := max(cy-1, 0); y <= min(cy+1, g.Rows-1); y++ {
		for x := max(cx-1, 0); x <= min(cx+1, g.Cols-1); x++ {
			for _, e := range g.cells[y*g.Cols+x] {
				fn(e)
			}
		}
	}
}

// InRange calls fn for every entity whose center is within r of (x, y).
func (g *Grid) InRange(x, y, r float64, fn func(*Entity)) {
	x0 := clampInt(int((x-r)/g.Cell), 0, g.Cols-1)
	x1 := clampInt(int((x+r)/g.Cell), 0, g.Cols-1)
	y0 := clampInt(int((y-r)/g.Cell), 0, g.Rows-1)
	y1 := clampInt(int((y+r)/g.Cell), 0, g.Rows-1)
	for cy := y0; cy <= y1; cy++ {
		for cx := x0; cx <= x1; cx++ {
			for _, e := range g.cells[cy*g.Cols+cx] {
				if math.Hypot(e.X-x, e.Y-y) <= r {
					fn(e)
				}
			}
		}
	}
}

// Sees reports whether an observer in cell a can see cell b.
func (g *Grid) Sees(a, b int) bool {
	ax, ay := a%g.Cols, a/g.Cols
	bx, by := b%g.Cols, b/g.Cols
	return absInt(ax-bx) <= 1 && absInt(ay-by) <= 1
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
