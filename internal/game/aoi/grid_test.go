package aoi

import (
	"testing"

	"github.com/qinbaixi/BtDemo/internal/game/core"
)

func ent(id int, x, y float64) *core.Entity {
	return &core.Entity{Identity: core.Identity{ID: id}, Transform: core.Transform{X: x, Y: y}}
}

func TestGridNeighborsAndMove(t *testing.T) {
	g := NewGrid(1000, 1000, 100)
	a := ent(1, 150, 150)
	b := ent(2, 250, 250) // diagonal neighbor cell
	c := ent(3, 450, 150) // two cells away
	for _, e := range []*core.Entity{a, b, c} {
		g.Add(e)
	}
	seen := func() map[int]bool {
		out := map[int]bool{}
		g.Neighbors(g.CellOf(a.X, a.Y), func(e *core.Entity) { out[e.ID] = true })
		return out
	}
	if s := seen(); !s[1] || !s[2] || s[3] {
		t.Fatalf("visible %v", s)
	}
	c.X = 250 // now adjacent
	g.Moved(c)
	if s := seen(); !s[3] {
		t.Fatalf("moved entity not visible: %v", s)
	}
	g.Remove(b)
	if s := seen(); s[2] {
		t.Fatalf("removed entity still visible: %v", s)
	}
	if !g.Sees(g.CellOf(0, 0), g.CellOf(199, 199)) || g.Sees(g.CellOf(0, 0), g.CellOf(250, 0)) {
		t.Fatal("Sees is wrong")
	}
	var in []int
	g.InRange(150, 150, 90, func(e *core.Entity) { in = append(in, e.ID) })
	if len(in) != 1 || in[0] != 1 {
		t.Fatalf("InRange %v", in)
	}
}
