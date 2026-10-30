package nav

import (
	"math"
)

const (
	bucketSize = 64.0 // 空间哈希单元，用于障碍物查询
	maxPush    = 4    // 每次移动的碰撞修正轮数
)

// Map 是 w×h 地图上静态障碍物的集合。
type Map struct {
	W, H    float64
	shapes  []Shape
	off     []bool // off[i] 为 true 的形状暂时不挡路（开着的门），见 SetSolid
	cols    int
	rows    int
	buckets [][]int32 // 每个桶中的形状索引，桶的范围按 MaxRadius 向外扩展
	grids   map[int]*Grid
}

// MaxRadius 是碰撞查询预期的最大实体半径；桶
// 的查找范围会按它向外扩展。
const MaxRadius = 64.0

// New 为 width×height 地图上的形状建立索引。
func New(width, height float64, shapes []Shape) *Map {
	navMap := &Map{
		W:      width,
		H:      height,
		shapes: shapes,
		off:    make([]bool, len(shapes)),
		grids:  map[int]*Grid{},
	}
	navMap.cols = int(math.Ceil(width / bucketSize))
	navMap.rows = int(math.Ceil(height / bucketSize))
	navMap.buckets = make([][]int32, navMap.cols*navMap.rows)
	for i, shape := range shapes {
		lo, hi := shape.bounds(MaxRadius)
		navMap.eachBucket(
			lo,
			hi,
			func(bucket int) { navMap.buckets[bucket] = append(navMap.buckets[bucket], int32(i)) },
		)
	}
	return navMap
}

// Shapes 返回所有障碍物（含暂时不挡路的）。
func (navMap *Map) Shapes() []Shape { return navMap.shapes }

// SetSolid 设置第 index 个形状挡不挡路（关卡的门开关时用）。变了的话路径网格作废，下次寻路时重建。
func (navMap *Map) SetSolid(index int, solid bool) {
	if navMap.off[index] == !solid {
		return
	}
	navMap.off[index] = !solid
	clear(navMap.grids)
}

// Solid 报告第 index 个形状现在挡不挡路。
func (navMap *Map) Solid(index int) bool { return !navMap.off[index] }

func (navMap *Map) eachBucket(lo, hi Vec, fn func(int)) {
	x0 := int(clamp(math.Floor(lo.X/bucketSize), 0, float64(navMap.cols-1)))
	x1 := int(clamp(math.Floor(hi.X/bucketSize), 0, float64(navMap.cols-1)))
	y0 := int(clamp(math.Floor(lo.Y/bucketSize), 0, float64(navMap.rows-1)))
	y1 := int(clamp(math.Floor(hi.Y/bucketSize), 0, float64(navMap.rows-1)))
	for y := y0; y <= y1; y++ {
		for x := x0; x <= x1; x++ {
			fn(y*navMap.cols + x)
		}
	}
}

// near 返回可能与圆心为 point 的圆相接触的形状（半径最大为 MaxRadius）。
func (navMap *Map) near(point Vec) []int32 {
	x := int(clamp(math.Floor(point.X/bucketSize), 0, float64(navMap.cols-1)))
	y := int(clamp(math.Floor(point.Y/bucketSize), 0, float64(navMap.rows-1)))
	return navMap.buckets[y*navMap.cols+x]
}

// InBounds 让半径为 radius 的圆留在地图内。
func (navMap *Map) InBounds(point Vec, radius float64) Vec {
	return Vec{clamp(point.X, radius, navMap.W-radius), clamp(point.Y, radius, navMap.H-radius)}
}

// Free 报告半径为 radius 的圆能否放在 point 处。
func (navMap *Map) Free(point Vec, radius float64) bool {
	if point.X < radius || point.Y < radius || point.X > navMap.W-radius ||
		point.Y > navMap.H-radius {
		return false
	}
	for _, i := range navMap.near(point) {
		if !navMap.off[i] && navMap.shapes[i].Dist(point) < radius {
			return false
		}
	}
	return true
}

// Resolve 把圆心为 point、半径为 radius 的圆推出所有障碍物，并让它回到
// 地图内。沿接触法线推出，
// 移动体才能沿墙滑动，而不是直接停住。
func (navMap *Map) Resolve(point Vec, radius float64) Vec {
	point = navMap.InBounds(point, radius)
	for pass := 0; pass < maxPush; pass++ {
		moved := false
		for _, i := range navMap.near(point) {
			if navMap.off[i] {
				continue
			}
			if pushed, ok := navMap.shapes[i].push(point, radius); ok {
				point, moved = pushed, true
			}
		}
		point = navMap.InBounds(point, radius)
		if !moved {
			break
		}
	}
	return point
}

// Clear 报告半径为 radius 的圆能否沿直线从 from 走到 to
// 而不碰到任何障碍物。
func (navMap *Map) Clear(from, to Vec, radius float64) bool {
	dist := from.Dist(to)
	step := math.Max(2, math.Min(radius, 8))
	steps := int(math.Ceil(dist / step))
	for i := 1; i <= steps; i++ {
		if !navMap.Free(lerp(from, to, float64(i)/float64(steps)), radius) {
			return false
		}
	}
	return true
}

// sightRadius 是视线检查用的半径：箭、火球这么粗，擦着墓碑边过去不算挡住。
const sightRadius = 3

// Sight 报告从 from 能不能看见 to：两点之间的直线没被障碍物（墙、墓碑、树、关着的门）挡住。
func (navMap *Map) Sight(from, to Vec) bool {
	return navMap.Clear(from, to, sightRadius)
}

// Reach 返回半径为 radius 的圆从 from 沿方向 dir（单位向量）直线前进、最远 maxDist 时
// 能到达的最远位置：碰到障碍物或地图边缘就停在前面。用于闪现和投掷物。
func (navMap *Map) Reach(from, dir Vec, maxDist, radius float64) Vec {
	step := math.Max(2, math.Min(radius, 8))
	reached := from
	for travelled := step; ; travelled += step {
		travelled = math.Min(travelled, maxDist)
		point := from.Add(dir.Scale(travelled))
		if !navMap.Free(point, radius) {
			return reached
		}
		reached = point
		if travelled >= maxDist {
			return reached
		}
	}
}

// NearestFree 返回半径为 radius 的圆在离 point 最近的空闲位置
// （若 point 本身空闲则返回 point），在路径网格上向外搜索。
func (navMap *Map) NearestFree(point Vec, radius float64) Vec {
	point = navMap.InBounds(point, radius)
	if navMap.Free(point, radius) {
		return point
	}
	grid := navMap.grid(radius)
	if cell, ok := grid.nearestOpen(grid.cellOf(point), 64); ok {
		return grid.center(cell)
	}
	return point
}

// FindPath 返回半径为 radius 的圆从 from 到 to 的路径点（不含 from）。
// 若 to 不可达，路径终止于离它最近的可达位置。
// 当 from 与 to 是同一位置时返回 nil。
func (navMap *Map) FindPath(from, to Vec, radius float64) []Vec {
	if from.Dist(to) < 0.5 {
		return nil
	}
	if navMap.Clear(from, to, radius) {
		return []Vec{to}
	}
	grid := navMap.grid(radius)
	cells := grid.astar(from, to)
	pts := make([]Vec, 0, len(cells)+2)
	if grid.blocked[grid.cellOf(from)] {
		// 站在网格太粗、看不到空间的位置：先走到开放地面上
		if cell, ok := grid.nearestOpen(grid.cellOf(from), 8); ok {
			pts = append(pts, grid.center(cell))
		}
	}
	for _, cell := range cells {
		pts = append(pts, grid.center(cell))
	}
	// 若能从最后一个单元格到达精确目标，则以精确目标结束
	last := from
	if len(pts) > 0 {
		last = pts[len(pts)-1]
	}
	if navMap.Clear(last, to, radius) {
		pts = append(pts, to)
	}
	if len(pts) == 0 {
		return nil
	}
	return navMap.smooth(from, pts, radius)
}

// smooth 去掉可以被直线跳过的路径点（拉绳优化）。
func (navMap *Map) smooth(from Vec, pts []Vec, radius float64) []Vec {
	out := pts[:0:0]
	anchor := from
	i := 0
	for i < len(pts) {
		j := i
		for j+1 < len(pts) && navMap.Clear(anchor, pts[j+1], radius) {
			j++
		}
		out = append(out, pts[j])
		anchor = pts[j]
		i = j + 1
	}
	return out
}

// grid 返回半径为 radius 的移动体所用的路径网格，首次使用时构建。
// 半径向上取整到 4 的倍数，使相近的移动体共用同一网格。
func (navMap *Map) grid(radius float64) *Grid {
	class := int(math.Ceil(radius/4)) * 4
	if grid, ok := navMap.grids[class]; ok {
		return grid
	}
	grid := newGrid(navMap, float64(class))
	navMap.grids[class] = grid
	return grid
}
