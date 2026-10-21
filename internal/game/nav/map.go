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
	cols    int
	rows    int
	buckets [][]int32 // 每个桶中的形状索引，桶的范围按 MaxRadius 向外扩展
	grids   map[int]*Grid
}

// MaxRadius 是碰撞查询预期的最大实体半径；桶
// 的查找范围会按它向外扩展。
const MaxRadius = 64.0

// New 为 w×h 地图上的形状建立索引。
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

// Shapes 返回所有障碍物。
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

// near 返回可能与圆心为 p 的圆相接触的形状（半径最大为 MaxRadius）。
func (m *Map) near(p Vec) []int32 {
	x := int(clamp(math.Floor(p.X/bucketSize), 0, float64(m.cols-1)))
	y := int(clamp(math.Floor(p.Y/bucketSize), 0, float64(m.rows-1)))
	return m.buckets[y*m.cols+x]
}

// InBounds 让半径为 r 的圆留在地图内。
func (m *Map) InBounds(p Vec, r float64) Vec {
	return Vec{clamp(p.X, r, m.W-r), clamp(p.Y, r, m.H-r)}
}

// Free 报告半径为 r 的圆能否放在 p 处。
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

// Resolve 把圆心为 p、半径为 r 的圆推出所有障碍物，并让它回到
// 地图内。沿接触法线推出，
// 移动体才能沿墙滑动，而不是直接停住。
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

// Clear 报告半径为 r 的圆能否沿直线从 a 走到 b
// 而不碰到任何障碍物。
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

// NearestFree 返回半径为 r 的圆在离 p 最近的空闲位置
// （若 p 本身空闲则返回 p），在路径网格上向外搜索。
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

// FindPath 返回半径为 r 的圆从 a 到 b 的路径点（不含 a）。
// 若 b 不可达，路径终止于离它最近的可达位置。
// 当 a 与 b 是同一位置时返回 nil。
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
		// 站在网格太粗、看不到空间的位置：先走到开放地面上
		if c, ok := g.nearestOpen(g.cellOf(a), 8); ok {
			pts = append(pts, g.center(c))
		}
	}
	for _, c := range cells {
		pts = append(pts, g.center(c))
	}
	// 若能从最后一个单元格到达精确目标，则以精确目标结束
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

// smooth 去掉可以被直线跳过的路径点（拉绳优化）。
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

// grid 返回半径为 r 的移动体所用的路径网格，首次使用时构建。
// 半径向上取整到 4 的倍数，使相近的移动体共用同一网格。
func (m *Map) grid(r float64) *Grid {
	class := int(math.Ceil(r/4)) * 4
	if g, ok := m.grids[class]; ok {
		return g
	}
	g := newGrid(m, float64(class))
	m.grids[class] = g
	return g
}
