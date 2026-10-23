// Package aoi 实现九宫格兴趣区域（AOI）：地图被切分为正方形格子，观察者可以看到
// 自身所在格子及其周围八个格子中的实体。
//
// 每个格子除了全部实体，还单独存一份玩家：广播只需要遍历九宫格里的玩家，
// 怪物、NPC、宠物不收消息，直接跳过。
// “a 能看到 b” 和 “b 能看到 a” 是同一件事（格子相邻），所以实体出现、消失、换格子时，
// Grid 只要告诉 Watcher “它在哪些格子里出现 / 消失了”，两边的 Enter / Leave 都能由此算出。
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
	players    []map[int]*core.Entity // 每个格子里的玩家（cells 的子集）
	where      map[int]int            // 实体 ID -> 格子
	watcher    Watcher
}

// Watcher 接收视野变化（由 session 实现）。cells 是格子索引，调用期间有效，不要保存。
type Watcher interface {
	// Shown：entity 进入了 cells 这些格子里的观察者的视野（刚加入网格，或者走了过来）。
	// 此时 entity 已经在新格子里。
	Shown(entity *core.Entity, cells []int)
	// Hidden：entity 离开了 cells 这些格子里的观察者的视野（被移除，或者走远了）。
	Hidden(entity *core.Entity, cells []int)
}

// SetWatcher 设置接收视野变化的对象；nil 表示不通知。
func (grid *Grid) SetWatcher(watcher Watcher) { grid.watcher = watcher }

// NewGrid 创建一个覆盖 width×height 地图的格子网格。
func NewGrid(width, height, cell float64) *Grid {
	grid := &Grid{
		Cell:  cell,
		Cols:  int(math.Ceil(width / cell)),
		Rows:  int(math.Ceil(height / cell)),
		where: map[int]int{},
	}
	grid.cells = make([]map[int]*core.Entity, grid.Cols*grid.Rows)
	grid.players = make([]map[int]*core.Entity, grid.Cols*grid.Rows)
	for i := range grid.cells {
		grid.cells[i] = map[int]*core.Entity{}
		grid.players[i] = map[int]*core.Entity{}
	}
	return grid
}

// CellOf 返回包含 (x, y) 的格子索引，结果限制在地图范围内。
func (grid *Grid) CellOf(x, y float64) int {
	cx := clampInt(int(x/grid.Cell), 0, grid.Cols-1)
	cy := clampInt(int(y/grid.Cell), 0, grid.Rows-1)
	return cy*grid.Cols + cx
}

// Add 将 entity 放入网格，并通知它出现在周围九宫格的视野里。
func (grid *Grid) Add(entity *core.Entity) {
	if _, ok := grid.where[entity.ID]; ok {
		grid.Moved(entity)
		return
	}
	cell := grid.CellOf(entity.X, entity.Y)
	grid.put(entity, cell)
	if grid.watcher != nil {
		grid.watcher.Shown(entity, grid.Around(cell))
	}
}

// Remove 将 entity 从网格中移除，并通知它从周围九宫格的视野里消失。
func (grid *Grid) Remove(entity *core.Entity) {
	cell, ok := grid.where[entity.ID]
	if !ok {
		return
	}
	grid.take(entity, cell)
	if grid.watcher != nil {
		grid.watcher.Hidden(entity, grid.Around(cell))
	}
}

// Moved 在 entity 的位置变化后更新其所在格子；换了格子时通知视野变化：
// 旧九宫格有、新九宫格没有的格子看不到它了，新九宫格有、旧九宫格没有的格子新看到它。
func (grid *Grid) Moved(entity *core.Entity) {
	old, ok := grid.where[entity.ID]
	if !ok {
		return
	}
	cell := grid.CellOf(entity.X, entity.Y)
	if cell == old {
		return
	}
	grid.take(entity, old)
	grid.put(entity, cell)
	if grid.watcher == nil {
		return
	}
	before, after := grid.Around(old), grid.Around(cell)
	if hidden := subtract(before, after); len(hidden) > 0 {
		grid.watcher.Hidden(entity, hidden)
	}
	if shown := subtract(after, before); len(shown) > 0 {
		grid.watcher.Shown(entity, shown)
	}
}

func (grid *Grid) put(entity *core.Entity, cell int) {
	grid.cells[cell][entity.ID] = entity
	if entity.Kind == core.KindPlayer {
		grid.players[cell][entity.ID] = entity
	}
	grid.where[entity.ID] = cell
}

func (grid *Grid) take(entity *core.Entity, cell int) {
	delete(grid.cells[cell], entity.ID)
	delete(grid.players[cell], entity.ID)
	delete(grid.where, entity.ID)
}

// Around 返回 cell 和它周围的格子（九宫格，在地图边上时更少）。
func (grid *Grid) Around(cell int) []int {
	cx, cy := cell%grid.Cols, cell/grid.Cols
	around := make([]int, 0, 9)
	for y := max(cy-1, 0); y <= min(cy+1, grid.Rows-1); y++ {
		for x := max(cx-1, 0); x <= min(cx+1, grid.Cols-1); x++ {
			around = append(around, y*grid.Cols+x)
		}
	}
	return around
}

// EachIn 对 cells 里的每个实体调用 fn。
func (grid *Grid) EachIn(cells []int, fn func(*core.Entity)) {
	for _, cell := range cells {
		for _, entity := range grid.cells[cell] {
			fn(entity)
		}
	}
}

// PlayersIn 对 cells 里的每个玩家调用 fn。
func (grid *Grid) PlayersIn(cells []int, fn func(*core.Entity)) {
	for _, cell := range cells {
		for _, player := range grid.players[cell] {
			fn(player)
		}
	}
}

// PlayersAround 对能看到 (x, y) 的每个玩家（该点所在格子九宫格里的玩家）调用 fn。
func (grid *Grid) PlayersAround(x, y float64, fn func(*core.Entity)) {
	grid.PlayersIn(grid.Around(grid.CellOf(x, y)), fn)
}

// subtract 返回在 from 里、不在 minus 里的格子。
func subtract(from, minus []int) []int {
	var rest []int
	for _, cell := range from {
		found := false
		for _, other := range minus {
			if cell == other {
				found = true
				break
			}
		}
		if !found {
			rest = append(rest, cell)
		}
	}
	return rest
}

// Neighbors 对 cell 周围九宫格内的每个实体调用 fn。
func (grid *Grid) Neighbors(cell int, fn func(*core.Entity)) {
	grid.EachIn(grid.Around(cell), fn)
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

// CanSee 报告 viewer 能否看到 target（两者所在格子相邻或相同）。谁能看到谁只由格子决定，不另外记录。
func (grid *Grid) CanSee(viewer, target *core.Entity) bool {
	return grid.Sees(grid.CellOf(viewer.X, viewer.Y), grid.CellOf(target.X, target.Y))
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
