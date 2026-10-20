package game

import (
	"testing"

	"github.com/qinbaixi/BtDemo/internal/config"
)

func TestGridNeighborsAndMove(t *testing.T) {
	g := NewGrid(1000, 1000, 100)
	a := &Entity{ID: 1, X: 150, Y: 150}
	b := &Entity{ID: 2, X: 250, Y: 250} // diagonal neighbor cell
	c := &Entity{ID: 3, X: 450, Y: 150} // two cells away
	for _, e := range []*Entity{a, b, c} {
		g.Add(e)
	}
	seen := func() map[int]bool {
		out := map[int]bool{}
		g.Neighbors(a.cell, func(e *Entity) { out[e.ID] = true })
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
	g.InRange(150, 150, 90, func(e *Entity) { in = append(in, e.ID) })
	if len(in) != 1 || in[0] != 1 {
		t.Fatalf("InRange %v", in)
	}
}

// A player only receives entities in the nine cells around it, and gets
// leave when they go out of view.
func TestFlushEnterLeave(t *testing.T) {
	w := testWorld()
	w.Cfg.World.Player.Respawn = 3
	s := w.Join()
	drain(s)
	s.Player.X, s.Player.Y = 100, 100
	w.Grid.Moved(s.Player)
	far := addTestEntity(w, 50, "monster", 900, 900, config.Attrs{Vit: 5})
	w.flush()
	if s.visible[far.ID] || !s.visible[s.Player.ID] {
		t.Fatalf("visible %v", s.visible)
	}
	far.X, far.Y = 250, 250
	w.Grid.Moved(far)
	w.flush()
	if !s.visible[far.ID] {
		t.Fatal("entity in view not entered")
	}
	far.X, far.Y = 900, 900
	w.Grid.Moved(far)
	w.flush()
	if s.visible[far.ID] {
		t.Fatal("entity out of view not left")
	}
}

func drain(s *Session) {
	for len(s.Out) > 0 {
		<-s.Out
	}
}
