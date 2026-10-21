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
	Kind ShapeKind
	A, B Vec
	R    float64
}

// closest 返回形状核心（圆心、矩形或
// 线段）中离 p 最近的点，以及该核心周围的半径。
func (s Shape) closest(p Vec) (Vec, float64) {
	switch s.Kind {
	case Rect:
		return Vec{clamp(p.X, s.A.X, s.B.X), clamp(p.Y, s.A.Y, s.B.Y)}, 0
	case Capsule:
		ab := s.B.Sub(s.A)
		t := 0.0
		if l2 := ab.Dot(ab); l2 > 0 {
			t = clamp(p.Sub(s.A).Dot(ab)/l2, 0, 1)
		}
		return lerp(s.A, s.B, t), s.R
	default:
		return s.A, s.R
	}
}

// Dist 是 p 到形状表面的距离；小于等于 0 表示在内部。
func (s Shape) Dist(p Vec) float64 {
	if s.Kind == Rect && p.X > s.A.X && p.X < s.B.X && p.Y > s.A.Y && p.Y < s.B.Y {
		// 在内部：取负的、到最近边缘的距离
		return -math.Min(math.Min(p.X-s.A.X, s.B.X-p.X), math.Min(p.Y-s.A.Y, s.B.Y-p.Y))
	}
	c, r := s.closest(p)
	return p.Dist(c) - r
}

// push 把圆心为 p、半径为 r 的圆推出形状，并报告
// 是否需要推出。
func (s Shape) push(p Vec, r float64) (Vec, bool) {
	if s.Kind == Rect && p.X > s.A.X && p.X < s.B.X && p.Y > s.A.Y && p.Y < s.B.Y {
		// 圆心在框内：从最近的一侧推出
		l, rt, t, b := p.X-s.A.X, s.B.X-p.X, p.Y-s.A.Y, s.B.Y-p.Y
		switch math.Min(math.Min(l, rt), math.Min(t, b)) {
		case l:
			return Vec{s.A.X - r, p.Y}, true
		case rt:
			return Vec{s.B.X + r, p.Y}, true
		case t:
			return Vec{p.X, s.A.Y - r}, true
		default:
			return Vec{p.X, s.B.Y + r}, true
		}
	}
	c, cr := s.closest(p)
	d := p.Sub(c)
	l := d.Len()
	min := cr + r
	if l >= min {
		return p, false
	}
	if l < 1e-9 {
		d, l = Vec{0, 1}, 1 // 正中心：朝镜头方向推出
	}
	return c.Add(d.Scale(min / l)), true
}

// bounds 是形状的包围盒，按 pad 向外扩大。
func (s Shape) bounds(pad float64) (Vec, Vec) {
	switch s.Kind {
	case Rect:
		return Vec{s.A.X - pad, s.A.Y - pad}, Vec{s.B.X + pad, s.B.Y + pad}
	case Capsule:
		r := s.R + pad
		return Vec{math.Min(s.A.X, s.B.X) - r, math.Min(s.A.Y, s.B.Y) - r}, Vec{math.Max(s.A.X, s.B.X) + r, math.Max(s.A.Y, s.B.Y) + r}
	default:
		r := s.R + pad
		return Vec{s.A.X - r, s.A.Y - r}, Vec{s.A.X + r, s.A.Y + r}
	}
}

// ShapesFromLayout 把 map.tmj 中的场景物件转换为障碍物。没有对应形状的场景物件
// 不会阻挡移动。
func ShapesFromLayout(l config.Layout) []Shape {
	var out []Shape
	for _, p := range l.Props {
		sh, ok := l.Shapes[p.Kind]
		if !ok {
			continue
		}
		fx := 1.0
		if p.Flip {
			fx = -1
		}
		at := func(x, y float64) Vec { return Vec{p.X + x*p.S*fx, p.Y + y*p.S} }
		switch {
		case sh.Circle != nil:
			out = append(out, Shape{Kind: Circle, A: at(sh.Circle[0], sh.Circle[1]), R: sh.Circle[2] * p.S})
		case sh.Rect != nil:
			a, b := at(sh.Rect[0], sh.Rect[1]), at(sh.Rect[2], sh.Rect[3])
			out = append(out, Shape{Kind: Rect,
				A: Vec{math.Min(a.X, b.X), math.Min(a.Y, b.Y)},
				B: Vec{math.Max(a.X, b.X), math.Max(a.Y, b.Y)}})
		case sh.Capsule > 0:
			out = append(out, Shape{Kind: Capsule, A: Vec{p.X, p.Y}, B: Vec{p.X + p.DX*p.S, p.Y + p.DY*p.S}, R: sh.Capsule * p.S})
		}
	}
	return out
}
