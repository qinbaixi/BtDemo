package aoi

import (
	"testing"

	"github.com/qinbaixi/BtDemo/internal/game/core"
)

func ent(id int, x, y float64) *core.Entity {
	return &core.Entity{Identity: core.Identity{ID: id}, Transform: core.Transform{X: x, Y: y}}
}

func TestGridNeighborsAndMove(t *testing.T) {
	grid := NewGrid(1000, 1000, 100)
	near := ent(1, 150, 150)
	diag := ent(2, 250, 250) // 对角相邻的格子
	far := ent(3, 450, 150)  // 相隔两个格子
	for _, entity := range []*core.Entity{near, diag, far} {
		grid.Add(entity)
	}
	seen := func() map[int]bool {
		out := map[int]bool{}
		grid.Neighbors(
			grid.CellOf(near.X, near.Y),
			func(entity *core.Entity) { out[entity.ID] = true },
		)
		return out
	}
	if s := seen(); !s[1] || !s[2] || s[3] {
		t.Fatalf("visible %v", s)
	}
	far.X = 250 // 现在相邻了
	grid.Moved(far)
	if s := seen(); !s[3] {
		t.Fatalf("moved entity not visible: %v", s)
	}
	grid.Remove(diag)
	if s := seen(); s[2] {
		t.Fatalf("removed entity still visible: %v", s)
	}
	if !grid.Sees(grid.CellOf(0, 0), grid.CellOf(199, 199)) ||
		grid.Sees(grid.CellOf(0, 0), grid.CellOf(250, 0)) {
		t.Fatal("Sees is wrong")
	}
	var got []int
	grid.InRange(150, 150, 90, func(entity *core.Entity) { got = append(got, entity.ID) })
	if len(got) != 1 || got[0] != 1 {
		t.Fatalf("InRange %v", got)
	}
}
