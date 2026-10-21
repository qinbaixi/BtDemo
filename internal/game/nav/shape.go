// Package nav is the map's static geometry: the obstacles props make, circle
// collision against them, and A* path finding on a grid around them.
package nav

import (
	"math"

	"github.com/qinbaixi/BtDemo/internal/config"
)

// Vec is a point or direction on the map.
type Vec struct{ X, Y float64 }

func (a Vec) Add(b Vec) Vec           { return Vec{a.X + b.X, a.Y + b.Y} }
func (a Vec) Sub(b Vec) Vec           { return Vec{a.X - b.X, a.Y - b.Y} }
func (a Vec) Scale(k float64) Vec     { return Vec{a.X * k, a.Y * k} }
func (a Vec) Len() float64            { return math.Hypot(a.X, a.Y) }
func (a Vec) Dist(b Vec) float64      { return math.Hypot(a.X-b.X, a.Y-b.Y) }
func (a Vec) Dot(b Vec) float64       { return a.X*b.X + a.Y*b.Y }
func lerp(a, b Vec, t float64) Vec    { return Vec{a.X + (b.X-a.X)*t, a.Y + (b.Y-a.Y)*t} }
func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

// ShapeKind is the geometry of an obstacle.
type ShapeKind int

const (
	Circle  ShapeKind = iota + 1 // centre A, radius R
	Rect                         // corners A (min) and B (max)
	Capsule                      // segment A-B, radius R
)

// Shape is one obstacle in map coordinates.
type Shape struct {
	Kind ShapeKind
	A, B Vec
	R    float64
}

// closest returns the point of the shape's core (centre, rectangle or
// segment) nearest to p, and the radius around that core.
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

// Dist is the distance from p to the shape's surface; 0 or less is inside.
func (s Shape) Dist(p Vec) float64 {
	if s.Kind == Rect && p.X > s.A.X && p.X < s.B.X && p.Y > s.A.Y && p.Y < s.B.Y {
		// inside: minus the distance to the nearest edge
		return -math.Min(math.Min(p.X-s.A.X, s.B.X-p.X), math.Min(p.Y-s.A.Y, s.B.Y-p.Y))
	}
	c, r := s.closest(p)
	return p.Dist(c) - r
}

// push moves a circle of radius r at p out of the shape, and reports whether
// it had to.
func (s Shape) push(p Vec, r float64) (Vec, bool) {
	if s.Kind == Rect && p.X > s.A.X && p.X < s.B.X && p.Y > s.A.Y && p.Y < s.B.Y {
		// centre inside the box: leave through the nearest side
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
		d, l = Vec{0, 1}, 1 // dead centre: push toward the camera
	}
	return c.Add(d.Scale(min / l)), true
}

// bounds is the shape's bounding box grown by pad.
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

// ShapesFromLayout turns the props of map.yaml into obstacles. Props whose
// kind has no shape do not block.
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
