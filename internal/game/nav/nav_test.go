package nav

import (
	"math"
	"testing"
)

// 1000x800 地图上从 (500,100) 到 (500,700) 的一道竖直墙
func wallMap() *Map {
	return New(1000, 800, []Shape{{Kind: Rect, A: Vec{490, 100}, B: Vec{510, 700}}})
}

func TestResolvePushesOutAndSlides(t *testing.T) {
	navMap := wallMap()
	point := navMap.Resolve(Vec{495, 400}, 16) // 圆心在墙内，靠近墙的左侧
	if point.X > 490-16+1e-9 || point.Y != 400 {
		t.Fatalf("pushed to %v, want left of the wall at the same height", point)
	}
	// 斜向撞墙时，运动中竖直方向的分量保留
	resolved := navMap.Resolve(Vec{480, 420}, 16)
	if resolved.X != 474 || resolved.Y != 420 {
		t.Fatalf("slide %v", resolved)
	}
	if !navMap.Free(Vec{300, 400}, 16) || navMap.Free(Vec{480, 400}, 16) {
		t.Fatal("Free is wrong")
	}
	if navMap.Free(Vec{5, 400}, 16) {
		t.Fatal("outside the map counts as free")
	}
}

func TestFindPathGoesAroundWall(t *testing.T) {
	navMap := wallMap()
	from, to := Vec{300, 400}, Vec{700, 400}
	if navMap.Clear(from, to, 16) {
		t.Fatal("line through the wall reported clear")
	}
	path := navMap.FindPath(from, to, 16)
	if len(path) < 2 || path[len(path)-1] != to {
		t.Fatalf("path %v", path)
	}
	prev := from
	for _, point := range path {
		if !navMap.Clear(prev, point, 16) {
			t.Fatalf("segment %v-%v crosses an obstacle", prev, point)
		}
		prev = point
	}
	// 绕过墙的端点，即经过 y < 100 或 y > 700 的区域
	around := false
	for _, point := range path {
		around = around || point.Y < 100 || point.Y > 700
	}
	if !around {
		t.Fatalf("path %v does not go around the wall", path)
	}
}

func TestFindPathStraightWhenClear(t *testing.T) {
	navMap := wallMap()
	path := navMap.FindPath(Vec{100, 400}, Vec{300, 450}, 16)
	if len(path) != 1 || path[0] != (Vec{300, 450}) {
		t.Fatalf("path %v", path)
	}
}

func TestUnreachableGoalEndsClosest(t *testing.T) {
	// (800, 400) 周围的一个封闭方框
	navMap := New(1000, 800, []Shape{
		{Kind: Rect, A: Vec{700, 300}, B: Vec{900, 320}},
		{Kind: Rect, A: Vec{700, 480}, B: Vec{900, 500}},
		{Kind: Rect, A: Vec{700, 300}, B: Vec{720, 500}},
		{Kind: Rect, A: Vec{880, 300}, B: Vec{900, 500}},
	})
	path := navMap.FindPath(Vec{200, 400}, Vec{800, 400}, 16)
	if len(path) == 0 {
		t.Fatal("no path toward an unreachable goal")
	}
	end := path[len(path)-1]
	inside := end.X > 700 && end.X < 900 && end.Y > 300 && end.Y < 500
	if inside || end.Dist(Vec{800, 400}) > 140 {
		t.Fatalf("path ends at %v, want just outside the box", end)
	}
	if got := navMap.NearestFree(Vec{710, 400}, 16); !navMap.Free(got, 16) {
		t.Fatalf("NearestFree gave blocked %v", got)
	}
}

func TestCapsuleAndCircle(t *testing.T) {
	shape := Shape{Kind: Capsule, A: Vec{0, 0}, B: Vec{100, 0}, Radius: 8}
	if dist := shape.Dist(Vec{50, 20}); math.Abs(dist-12) > 1e-9 {
		t.Fatalf("capsule dist %v", dist)
	}
	circle := Shape{Kind: Circle, A: Vec{0, 0}, Radius: 10}
	if point, ok := circle.push(Vec{5, 0}, 4); !ok || math.Abs(point.X-14) > 1e-9 {
		t.Fatalf("circle push %v %v", point, ok)
	}
}

func TestReachStopsBeforeWall(t *testing.T) {
	navMap := wallMap()
	from := Vec{X: 100, Y: 300}
	// 朝右走，前面有墙：停在墙前面，并且离起点有一段距离
	end := navMap.Reach(from, Vec{X: 1, Y: 0}, 1000, 10)
	if !navMap.Free(end, 10) || end.X <= from.X || end.Y != from.Y {
		t.Fatalf("reach ended at %+v", end)
	}
	if navMap.Clear(end, end.Add(Vec{X: 16, Y: 0}), 10) {
		t.Fatalf("reach stopped at %+v but the way ahead is still clear", end)
	}
	// 朝空地走：走满距离
	open := navMap.Reach(from, Vec{X: -1, Y: 0}, 50, 10)
	if open.Dist(Vec{X: 50, Y: 300}) > 1e-9 {
		t.Fatalf("open reach ended at %+v, want (50, 300)", open)
	}
}
