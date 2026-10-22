package nav

import (
	"container/heap"
	"math"
)

// CellSize 是路径网格单元的边长（像素）。
const CellSize = 16.0

// Grid 标记半径为某一值的移动体可以站立的单元格。
type Grid struct {
	cols, rows int
	blocked    []bool

	// A* 的临时数据，在多次搜索间复用；stamp 用于区分当前条目和过期条目
	cost  []float64
	from  []int32
	stamp []uint32
	shut  []uint32
	gen   uint32
	open  openList
}

func newGrid(navMap *Map, radius float64) *Grid {
	grid := &Grid{
		cols: int(math.Ceil(navMap.W / CellSize)),
		rows: int(math.Ceil(navMap.H / CellSize)),
	}
	count := grid.cols * grid.rows
	grid.blocked = make([]bool, count)
	grid.cost = make([]float64, count)
	grid.from = make([]int32, count)
	grid.stamp = make([]uint32, count)
	grid.shut = make([]uint32, count)
	for cell := 0; cell < count; cell++ {
		point := grid.center(cell)
		grid.blocked[cell] = point.X < radius || point.Y < radius || point.X > navMap.W-radius ||
			point.Y > navMap.H-radius
	}
	for _, shape := range navMap.shapes {
		lo, hi := shape.bounds(radius + CellSize)
		x0, y0 := grid.xy(lo)
		x1, y1 := grid.xy(hi)
		for y := y0; y <= y1; y++ {
			for x := x0; x <= x1; x++ {
				cell := y*grid.cols + x
				if !grid.blocked[cell] && shape.Dist(grid.center(cell)) < radius {
					grid.blocked[cell] = true
				}
			}
		}
	}
	return grid
}

func (grid *Grid) xy(point Vec) (int, int) {
	x := int(clamp(math.Floor(point.X/CellSize), 0, float64(grid.cols-1)))
	y := int(clamp(math.Floor(point.Y/CellSize), 0, float64(grid.rows-1)))
	return x, y
}

func (grid *Grid) cellOf(point Vec) int {
	x, y := grid.xy(point)
	return y*grid.cols + x
}

func (grid *Grid) center(cell int) Vec {
	return Vec{
		(float64(cell%grid.cols) + 0.5) * CellSize,
		(float64(cell/grid.cols) + 0.5) * CellSize,
	}
}

// nearestOpen 在 maxRing 圈内查找离 cell 最近的开放单元格。
func (grid *Grid) nearestOpen(cell, maxRing int) (int, bool) {
	if !grid.blocked[cell] {
		return cell, true
	}
	cx, cy := cell%grid.cols, cell/grid.cols
	for ring := 1; ring <= maxRing; ring++ {
		best, bestD := -1, math.Inf(1)
		for dy := -ring; dy <= ring; dy++ {
			for dx := -ring; dx <= ring; dx++ {
				if max(abs(dx), abs(dy)) != ring {
					continue
				}
				x, y := cx+dx, cy+dy
				if x < 0 || y < 0 || x >= grid.cols || y >= grid.rows {
					continue
				}
				if candidate := y*grid.cols + x; !grid.blocked[candidate] {
					if distSq := float64(dx*dx + dy*dy); distSq < bestD {
						best, bestD = candidate, distSq
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

var dirs = [8][3]int{
	{1, 0, 0},
	{-1, 0, 0},
	{0, 1, 0},
	{0, -1, 0},
	{1, 1, 1},
	{1, -1, 1},
	{-1, 1, 1},
	{-1, -1, 1},
}

// astar 返回从 from 所在单元格（不含）到 to 所在单元格的单元格序列；
// 若 to 不可达，则返回到离 to 最近的单元格。被阻挡的起点和终点单元格
// 会被替换为最近的开放单元格。
func (grid *Grid) astar(from, to Vec) []int {
	start, ok := grid.nearestOpen(grid.cellOf(from), 8)
	if !ok {
		return nil
	}
	goal, ok := grid.nearestOpen(grid.cellOf(to), 64)
	if !ok {
		return nil
	}
	gx, gy := goal%grid.cols, goal/grid.cols
	heuristic := func(cell int) float64 {
		dx, dy := float64(abs(cell%grid.cols-gx)), float64(abs(cell/grid.cols-gy))
		return dx + dy + (math.Sqrt2-2)*math.Min(dx, dy) // 八方向距离
	}
	grid.gen++
	if grid.gen == 0 { // 计数回绕：清空一次所有 stamp
		clear(grid.stamp)
		clear(grid.shut)
		grid.gen = 1
	}
	grid.open = grid.open[:0]
	grid.stamp[start], grid.cost[start], grid.from[start] = grid.gen, 0, -1
	heap.Push(&grid.open, node{start, heuristic(start)})
	best, bestH := start, heuristic(start)
	for grid.open.Len() > 0 {
		cur := heap.Pop(&grid.open).(node).cell
		if grid.shut[cur] == grid.gen {
			continue
		}
		grid.shut[cur] = grid.gen
		if hc := heuristic(cur); hc < bestH {
			best, bestH = cur, hc
		}
		if cur == goal {
			break
		}
		cx, cy := cur%grid.cols, cur/grid.cols
		for _, dir := range dirs {
			x, y := cx+dir[0], cy+dir[1]
			if x < 0 || y < 0 || x >= grid.cols || y >= grid.rows {
				continue
			}
			next := y*grid.cols + x
			if grid.blocked[next] || grid.shut[next] == grid.gen {
				continue
			}
			stepCost := 1.0
			if dir[2] == 1 {
				// 不允许在障碍物旁边切角
				if grid.blocked[cy*grid.cols+x] || grid.blocked[y*grid.cols+cx] {
					continue
				}
				stepCost = math.Sqrt2
			}
			newCost := grid.cost[cur] + stepCost
			if grid.stamp[next] == grid.gen && newCost >= grid.cost[next] {
				continue
			}
			grid.stamp[next], grid.cost[next], grid.from[next] = grid.gen, newCost, int32(cur)
			heap.Push(&grid.open, node{next, newCost + heuristic(next)})
		}
	}
	var path []int
	for cell := best; cell != start; cell = int(grid.from[cell]) {
		path = append(path, cell)
	}
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return path
}

type node struct {
	cell  int
	score float64
}

type openList []node

func (open openList) Len() int           { return len(open) }
func (open openList) Less(i, j int) bool { return open[i].score < open[j].score }
func (open openList) Swap(i, j int)      { open[i], open[j] = open[j], open[i] }
func (open *openList) Push(x any)        { *open = append(*open, x.(node)) }
func (open *openList) Pop() any {
	old := *open
	last := old[len(old)-1]
	*open = old[:len(old)-1]
	return last
}
