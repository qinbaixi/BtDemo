// Package nav 是地图的静态几何：场景物件形成的障碍物、圆形与它们的碰撞，
// 以及在其周围网格上的 A* 寻路。
package nav

import (
	"math"

	"github.com/qinbaixi/BtDemo/internal/config"
)

// Vec 是地图上的一个点或方向。
type Vec struct{ X, Y float64 }

func (a Vec) Add(b Vec) Vec           { return Vec{a.X + b.X, a.Y + b.Y} }
func (a Vec) Sub(b Vec) Vec           { return Vec{a.X - b.X, a.Y - b.Y} }
func (a Vec) Scale(k float64) Vec     { return Vec{a.X * k, a.Y * k} }
func (a Vec) Len() float64            { return math.Hypot(a.X, a.Y) }
func (a Vec) Dist(b Vec) float64      { return math.Hypot(a.X-b.X, a.Y-b.Y) }
func (a Vec) Dot(b Vec) float64       { return a.X*b.X + a.Y*b.Y }
func lerp(a, b Vec, t float64) Vec    { return Vec{a.X + (b.X-a.X)*t, a.Y + (b.Y-a.Y)*t} }
func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

// ShapeKind 是障碍物的几何类型。
type ShapeKind int

const (
	Circle  ShapeKind = iota + 1 // 圆心 A，半径 R
	Rect                         // 角点 A（最小）和 B（最大）
	Capsule                      // 线段 A-B，半径 R
)

// Shape 是地图坐标系中的一个障碍物。
type Shape struct {
	Kind   ShapeKind
	A, B   Vec
	Radius float64
}

// closest 返回形状核心（圆心、矩形或
// 线段）中离 p 最近的点，以及该核心周围的半径。
func (shape Shape) closest(point Vec) (Vec, float64) {
	switch shape.Kind {
	case Rect:
		return Vec{clamp(point.X, shape.A.X, shape.B.X), clamp(point.Y, shape.A.Y, shape.B.Y)}, 0
	case Capsule:
		segment := shape.B.Sub(shape.A)
		along := 0.0
		if segLen2 := segment.Dot(segment); segLen2 > 0 {
			along = clamp(point.Sub(shape.A).Dot(segment)/segLen2, 0, 1)
		}
		return lerp(shape.A, shape.B, along), shape.Radius
	default:
		return shape.A, shape.Radius
	}
}

// Dist 是 p 到形状表面的距离；小于等于 0 表示在内部。
func (shape Shape) Dist(point Vec) float64 {
	if shape.Kind == Rect && point.X > shape.A.X && point.X < shape.B.X && point.Y > shape.A.Y &&
		point.Y < shape.B.Y {
		// 在内部：取负的、到最近边缘的距离
		return -math.Min(
			math.Min(point.X-shape.A.X, shape.B.X-point.X),
			math.Min(point.Y-shape.A.Y, shape.B.Y-point.Y),
		)
	}
	center, radius := shape.closest(point)
	return point.Dist(center) - radius
}

// push 把圆心为 p、半径为 r 的圆推出形状，并报告
// 是否需要推出。
func (shape Shape) push(point Vec, radius float64) (Vec, bool) {
	if shape.Kind == Rect && point.X > shape.A.X && point.X < shape.B.X && point.Y > shape.A.Y &&
		point.Y < shape.B.Y {
		// 圆心在框内：从最近的一侧推出
		left, right := point.X-shape.A.X, shape.B.X-point.X
		top, bottom := point.Y-shape.A.Y, shape.B.Y-point.Y
		switch math.Min(math.Min(left, right), math.Min(top, bottom)) {
		case left:
			return Vec{shape.A.X - radius, point.Y}, true
		case right:
			return Vec{shape.B.X + radius, point.Y}, true
		case top:
			return Vec{point.X, shape.A.Y - radius}, true
		default:
			return Vec{point.X, shape.B.Y + radius}, true
		}
	}
	center, closestRadius := shape.closest(point)
	away := point.Sub(center)
	dist := away.Len()
	min := closestRadius + radius
	if dist >= min {
		return point, false
	}
	if dist < 1e-9 {
		away, dist = Vec{0, 1}, 1 // 正中心：朝镜头方向推出
	}
	return center.Add(away.Scale(min / dist)), true
}

// bounds 是形状的包围盒，按 pad 向外扩大。
func (shape Shape) bounds(pad float64) (Vec, Vec) {
	switch shape.Kind {
	case Rect:
		return Vec{shape.A.X - pad, shape.A.Y - pad}, Vec{shape.B.X + pad, shape.B.Y + pad}
	case Capsule:
		radius := shape.Radius + pad
		minCorner := Vec{math.Min(shape.A.X, shape.B.X) - radius, math.Min(shape.A.Y, shape.B.Y) - radius}
		maxCorner := Vec{math.Max(shape.A.X, shape.B.X) + radius, math.Max(shape.A.Y, shape.B.Y) + radius}
		return minCorner, maxCorner
	default:
		radius := shape.Radius + pad
		return Vec{shape.A.X - radius, shape.A.Y - radius}, Vec{shape.A.X + radius, shape.A.Y + radius}
	}
}

// ShapesFromLayout 把 map.tmj 中的场景物件转换为障碍物。没有对应形状的场景物件
// 不会阻挡移动。
func ShapesFromLayout(layout config.Layout) []Shape {
	var out []Shape
	for _, prop := range layout.Props {
		shape, ok := layout.Shapes[prop.Kind]
		if !ok {
			continue
		}
		flipX := 1.0
		if prop.Flip {
			flipX = -1
		}
		toWorld := func(x, y float64) Vec {
			return Vec{prop.X + x*prop.Scale*flipX, prop.Y + y*prop.Scale}
		}
		switch {
		case shape.Circle != nil:
			out = append(
				out,
				Shape{
					Kind:   Circle,
					A:      toWorld(shape.Circle[0], shape.Circle[1]),
					Radius: shape.Circle[2] * prop.Scale,
				},
			)
		case shape.Rect != nil:
			corner1 := toWorld(shape.Rect[0], shape.Rect[1])
			corner2 := toWorld(shape.Rect[2], shape.Rect[3])
			out = append(out, Shape{
				Kind: Rect,
				A:    Vec{math.Min(corner1.X, corner2.X), math.Min(corner1.Y, corner2.Y)},
				B:    Vec{math.Max(corner1.X, corner2.X), math.Max(corner1.Y, corner2.Y)},
			})
		case shape.Capsule > 0:
			out = append(
				out,
				Shape{
					Kind:   Capsule,
					A:      Vec{prop.X, prop.Y},
					B:      Vec{prop.X + prop.DX*prop.Scale, prop.Y + prop.DY*prop.Scale},
					Radius: shape.Capsule * prop.Scale,
				},
			)
		}
	}
	return out
}
