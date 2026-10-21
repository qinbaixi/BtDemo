package game

import (
	"testing"

	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
)

// overlap is how deep e sits inside an obstacle (0 when it is clear).
func overlap(w *World, e *core.Entity) float64 {
	worst := 0.0
	for _, s := range w.Nav.Shapes() {
		if d := e.Radius - s.Dist(nav.Vec{X: e.X, Y: e.Y}); d > worst {
			worst = d
		}
	}
	return worst
}

// With the shipped map, everything spawns clear of props and nothing ends up
// inside one after a minute of fighting and wandering.
func TestShippedMapKeepsEntitiesOutOfProps(t *testing.T) {
	cfg, err := config.Load("../../config", TreeNames())
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Layout.Props) == 0 || len(cfg.Layout.Shapes) == 0 {
		t.Fatal("map.yaml has no props or shapes")
	}
	w, err := NewWorld(cfg, 7)
	if err != nil {
		t.Fatal(err)
	}
	s := w.Join()
	check := func(when string) {
		w.State.Ents.Each(func(e *core.Entity) {
			if d := overlap(w, e); d > 0.5 {
				t.Errorf("%s: %s #%d at (%.0f, %.0f) is %.1fpx inside an obstacle", when, e.Name, e.ID, e.X, e.Y, d)
			}
		})
	}
	check("spawn")
	s.Player.MoveX = 1 // walk east through the sanctuary wall, the meadow and the trees
	for i := 0; i < 60*20; i++ {
		w.Step()
		drain(s)
	}
	check("after 60s")
}

// A player cannot walk through a house; walking into it slides along it.
func TestPlayerBlockedByHouse(t *testing.T) {
	w := testWorld(nav.Shape{Kind: nav.Rect, A: nav.Vec{X: 400, Y: 400}, B: nav.Vec{X: 600, Y: 450}})
	p := addTestEntity(w, 1, "player", 500, 300, playerBase)
	p.MoveY = 1
	for i := 0; i < 40; i++ {
		w.Step()
	}
	if p.Y > 400-p.Radius+0.01 {
		t.Fatalf("player walked into the house: y = %.1f", p.Y)
	}
	p.MoveX, p.MoveY = 0.7071, 0.7071 // diagonal: slides east along the wall
	x0 := p.X
	for i := 0; i < 10; i++ {
		w.Step()
	}
	if p.X <= x0+20 || p.Y > 400-p.Radius+0.01 {
		t.Fatalf("no slide: x %.1f -> %.1f, y %.1f", x0, p.X, p.Y)
	}
}

// A monster chasing a player behind a wall walks around it and reaches it.
func TestChaseFindsWayAroundWall(t *testing.T) {
	w := testWorld(nav.Shape{Kind: nav.Capsule, A: nav.Vec{X: 500, Y: 150}, B: nav.Vec{X: 500, Y: 850}, R: 10})
	m := addTestEntity(w, 1, "monster", 350, 500, monsterBase)
	p := addTestEntity(w, 2, "player", 650, 500, playerBase)
	m.Target = p.ID
	inst := aiInstance(t, w, m, map[int]map[string]any{
		1: {"node_id": 1, "type": "task", "sub_type": "chase_target", "properties": map[string]any{"StopRange": 10}},
	})
	for i := 0; i < 20*20; i++ {
		if tickAI(w, inst) == bt.Success {
			break
		}
		if overlap(w, m) > 0.5 {
			t.Fatalf("monster went into the wall at (%.0f, %.0f)", m.X, m.Y)
		}
	}
	if d := core.EdgeDist(m, p); d > 10 {
		t.Fatalf("monster did not reach the player: %.0f px apart, at (%.0f, %.0f)", d, m.X, m.Y)
	}
}

// A goal sealed off by walls: the mover walks to the closest spot it can
// reach, counts that as arrived, and only searches again on the replan
// schedule rather than every tick.
func TestUnreachableGoalDoesNotReplanEveryTick(t *testing.T) {
	box := []nav.Shape{
		{Kind: nav.Capsule, A: nav.Vec{X: 600, Y: 400}, B: nav.Vec{X: 800, Y: 400}, R: 10},
		{Kind: nav.Capsule, A: nav.Vec{X: 800, Y: 400}, B: nav.Vec{X: 800, Y: 600}, R: 10},
		{Kind: nav.Capsule, A: nav.Vec{X: 800, Y: 600}, B: nav.Vec{X: 600, Y: 600}, R: 10},
		{Kind: nav.Capsule, A: nav.Vec{X: 600, Y: 600}, B: nav.Vec{X: 600, Y: 400}, R: 10},
	}
	w := testWorld(box...)
	m := addTestEntity(w, 1, "monster", 300, 500, monsterBase)
	arrived := false
	for i := 0; i < 400 && !arrived; i++ {
		w.State.Clock.Now += w.State.Clock.Dt
		arrived = w.Move.Toward(m, 700, 500, 6)
	}
	if !arrived {
		t.Fatalf("never settled next to the box: at (%.0f, %.0f)", m.X, m.Y)
	}
	if m.X > 600-m.Radius+0.5 || m.X < 560 {
		t.Fatalf("stopped at (%.0f, %.0f), want just outside the west wall", m.X, m.Y)
	}
	planAt := m.Steering.RepathAt
	w.State.Clock.Now += w.State.Clock.Dt
	if !w.Move.Toward(m, 700, 500, 6) || m.Steering.RepathAt != planAt {
		t.Fatal("replanned on the very next tick after settling")
	}
}
