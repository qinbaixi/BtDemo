package nav

import (
	"math"
	"testing"
)

// a vertical wall from (500,100) to (500,700) on a 1000x800 map
func wallMap() *Map {
	return New(1000, 800, []Shape{{Kind: Rect, A: Vec{490, 100}, B: Vec{510, 700}}})
}

func TestResolvePushesOutAndSlides(t *testing.T) {
	m := wallMap()
	p := m.Resolve(Vec{495, 400}, 16) // centre inside the wall, nearer its left side
	if p.X > 490-16+1e-9 || p.Y != 400 {
		t.Fatalf("pushed to %v, want left of the wall at the same height", p)
	}
	// moving diagonally into the wall keeps the vertical part of the motion
	q := m.Resolve(Vec{480, 420}, 16)
	if q.X != 474 || q.Y != 420 {
		t.Fatalf("slide %v", q)
	}
	if !m.Free(Vec{300, 400}, 16) || m.Free(Vec{480, 400}, 16) {
		t.Fatal("Free is wrong")
	}
	if m.Free(Vec{5, 400}, 16) {
		t.Fatal("outside the map counts as free")
	}
}

func TestFindPathGoesAroundWall(t *testing.T) {
	m := wallMap()
	a, b := Vec{300, 400}, Vec{700, 400}
	if m.Clear(a, b, 16) {
		t.Fatal("line through the wall reported clear")
	}
	path := m.FindPath(a, b, 16)
	if len(path) < 2 || path[len(path)-1] != b {
		t.Fatalf("path %v", path)
	}
	prev := a
	for _, p := range path {
		if !m.Clear(prev, p, 16) {
			t.Fatalf("segment %v-%v crosses an obstacle", prev, p)
		}
		prev = p
	}
	// around an end of the wall, so through y < 100 or y > 700
	around := false
	for _, p := range path {
		around = around || p.Y < 100 || p.Y > 700
	}
	if !around {
		t.Fatalf("path %v does not go around the wall", path)
	}
}

func TestFindPathStraightWhenClear(t *testing.T) {
	m := wallMap()
	path := m.FindPath(Vec{100, 400}, Vec{300, 450}, 16)
	if len(path) != 1 || path[0] != (Vec{300, 450}) {
		t.Fatalf("path %v", path)
	}
}

func TestUnreachableGoalEndsClosest(t *testing.T) {
	// a closed box around (800, 400)
	m := New(1000, 800, []Shape{
		{Kind: Rect, A: Vec{700, 300}, B: Vec{900, 320}},
		{Kind: Rect, A: Vec{700, 480}, B: Vec{900, 500}},
		{Kind: Rect, A: Vec{700, 300}, B: Vec{720, 500}},
		{Kind: Rect, A: Vec{880, 300}, B: Vec{900, 500}},
	})
	path := m.FindPath(Vec{200, 400}, Vec{800, 400}, 16)
	if len(path) == 0 {
		t.Fatal("no path toward an unreachable goal")
	}
	end := path[len(path)-1]
	inside := end.X > 700 && end.X < 900 && end.Y > 300 && end.Y < 500
	if inside || end.Dist(Vec{800, 400}) > 140 {
		t.Fatalf("path ends at %v, want just outside the box", end)
	}
	if got := m.NearestFree(Vec{710, 400}, 16); !m.Free(got, 16) {
		t.Fatalf("NearestFree gave blocked %v", got)
	}
}

func TestCapsuleAndCircle(t *testing.T) {
	s := Shape{Kind: Capsule, A: Vec{0, 0}, B: Vec{100, 0}, R: 8}
	if d := s.Dist(Vec{50, 20}); math.Abs(d-12) > 1e-9 {
		t.Fatalf("capsule dist %v", d)
	}
	c := Shape{Kind: Circle, A: Vec{0, 0}, R: 10}
	if p, ok := c.push(Vec{5, 0}, 4); !ok || math.Abs(p.X-14) > 1e-9 {
		t.Fatalf("circle push %v %v", p, ok)
	}
}
