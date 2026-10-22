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

// NewGrid 创建一个覆盖 width×height 地图的格子网格。
func NewGrid(width, height, cell float64) *Grid {
	grid := &Grid{
		Cell:  cell,
		Cols:  int(math.Ceil(width / cell)),
		Rows:  int(math.Ceil(height / cell)),
		where: map[int]int{},
	}
	grid.cells = make([]map[int]*core.Entity, grid.Cols*grid.Rows)
	for i := range grid.cells {
		grid.cells[i] = map[int]*core.Entity{}
	}
	return grid
}

// CellOf 返回包含 (x, y) 的格子索引，结果限制在地图范围内。
func (grid *Grid) CellOf(x, y float64) int {
	cx := clampInt(int(x/grid.Cell), 0, grid.Cols-1)
	cy := clampInt(int(y/grid.Cell), 0, grid.Rows-1)
	return cy*grid.Cols + cx
}

// Add 将 entity 放入网格。
func (grid *Grid) Add(entity *core.Entity) {
	cell := grid.CellOf(entity.X, entity.Y)
	grid.cells[cell][entity.ID] = entity
	grid.where[entity.ID] = cell
}

// Remove 将 entity 从网格中移除。
func (grid *Grid) Remove(entity *core.Entity) {
	if cell, ok := grid.where[entity.ID]; ok {
		delete(grid.cells[cell], entity.ID)
		delete(grid.where, entity.ID)
	}
}

// Moved 在 entity 的位置变化后更新其所在格子。
func (grid *Grid) Moved(entity *core.Entity) {
	old, ok := grid.where[entity.ID]
	if !ok {
		return
	}
	if cell := grid.CellOf(entity.X, entity.Y); cell != old {
		delete(grid.cells[old], entity.ID)
		grid.cells[cell][entity.ID] = entity
		grid.where[entity.ID] = cell
	}
}

// Neighbors 对 cell 周围九宫格内的每个实体调用 fn。
func (grid *Grid) Neighbors(cell int, fn func(*core.Entity)) {
	cx, cy := cell%grid.Cols, cell/grid.Cols
	for y := max(cy-1, 0); y <= min(cy+1, grid.Rows-1); y++ {
		for x := max(cx-1, 0); x <= min(cx+1, grid.Cols-1); x++ {
			for _, entity := range grid.cells[y*grid.Cols+x] {
				fn(entity)
			}
		}
	}
}

// InRange 对中心位于 (x, y) 半径 radius 之内的每个实体调用 fn。
func (grid *Grid) InRange(x, y, radius float64, fn func(*core.Entity)) {
	x0 := clampInt(int((x-radius)/grid.Cell), 0, grid.Cols-1)
	x1 := clampInt(int((x+radius)/grid.Cell), 0, grid.Cols-1)
	y0 := clampInt(int((y-radius)/grid.Cell), 0, grid.Rows-1)
	y1 := clampInt(int((y+radius)/grid.Cell), 0, grid.Rows-1)
	for cy := y0; cy <= y1; cy++ {
		for cx := x0; cx <= x1; cx++ {
			for _, entity := range grid.cells[cy*grid.Cols+cx] {
				if math.Hypot(entity.X-x, entity.Y-y) <= radius {
					fn(entity)
				}
			}
		}
	}
}

// Sees 报告位于格子 a 的观察者能否看到格子 b。
func (grid *Grid) Sees(a, b int) bool {
	ax, ay := a%grid.Cols, a/grid.Cols
	bx, by := b%grid.Cols, b/grid.Cols
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
