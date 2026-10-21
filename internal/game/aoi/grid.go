// Package aoi 实现九宫格兴趣区域（AOI）：地图被切分为正方形格子，观察者可以看到
// 自身所在格子及其周围八个格子中的实体。
package aoi

import (
	"math"

	"github.com/qinbaixi/BtDemo/internal/game/core"
)

// Grid 按格子为实体建立索引。它记录每个实体所在的格子，因此实体本身不需要保存
// 任何 AOI 相关的记录。
type Grid struct {
	Cell       float64
	Cols, Rows int
	cells      []map[int]*core.Entity
	where      map[int]int // 实体 ID -> 格子
}

// NewGrid 创建一个覆盖 w×h 地图的格子网格。
func NewGrid(w, h, cell float64) *Grid {
	g := &Grid{Cell: cell, Cols: int(math.Ceil(w / cell)), Rows: int(math.Ceil(h / cell)), where: map[int]int{}}
	g.cells = make([]map[int]*core.Entity, g.Cols*g.Rows)
	for i := range g.cells {
		g.cells[i] = map[int]*core.Entity{}
	}
	return g
}

// CellOf 返回包含 (x, y) 的格子索引，结果限制在地图范围内。
func (g *Grid) CellOf(x, y float64) int {
	cx := clampInt(int(x/g.Cell), 0, g.Cols-1)
	cy := clampInt(int(y/g.Cell), 0, g.Rows-1)
	return cy*g.Cols + cx
}

// Add 将 e 放入网格。
func (g *Grid) Add(e *core.Entity) {
	c := g.CellOf(e.X, e.Y)
	g.cells[c][e.ID] = e
	g.where[e.ID] = c
}

// Remove 将 e 从网格中移除。
func (g *Grid) Remove(e *core.Entity) {
	if c, ok := g.where[e.ID]; ok {
		delete(g.cells[c], e.ID)
		delete(g.where, e.ID)
	}
}

// Moved 在 e 的位置变化后更新其所在格子。
func (g *Grid) Moved(e *core.Entity) {
	old, ok := g.where[e.ID]
	if !ok {
		return
	}
	if c := g.CellOf(e.X, e.Y); c != old {
		delete(g.cells[old], e.ID)
		g.cells[c][e.ID] = e
		g.where[e.ID] = c
	}
}

// Neighbors 对 cell 周围九宫格内的每个实体调用 fn。
func (g *Grid) Neighbors(cell int, fn func(*core.Entity)) {
	cx, cy := cell%g.Cols, cell/g.Cols
	for y := max(cy-1, 0); y <= min(cy+1, g.Rows-1); y++ {
		for x := max(cx-1, 0); x <= min(cx+1, g.Cols-1); x++ {
			for _, e := range g.cells[y*g.Cols+x] {
				fn(e)
			}
		}
	}
}

// InRange 对中心位于 (x, y) 半径 r 之内的每个实体调用 fn。
func (g *Grid) InRange(x, y, r float64, fn func(*core.Entity)) {
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

// Sees 报告位于格子 a 的观察者能否看到格子 b。
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
