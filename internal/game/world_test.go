package game

import (
	"testing"

	"github.com/qinbaixi/BtDemo/internal/config"
)

// The shipped config and every exported tree load, and a player who walks
// into the slime field gets attacked by behavior-tree driven monsters.
func TestWorldWithShippedConfig(t *testing.T) {
	cfg, err := config.Load("../../config", TreeNames())
	if err != nil {
		t.Fatal(err)
	}
	w, err := NewWorld(cfg, 1)
	if err != nil {
		t.Fatal(err)
	}
	s := w.Join()
	p := s.Player
	p.X, p.Y = 1000, 900 // middle of the slime spawn
	w.Grid.Moved(p)
	for i := 0; i < 20*20 && p.LastAttacker == 0; i++ {
		w.Step()
	}
	if p.LastAttacker == 0 {
		t.Fatal("no monster attacked the player within 20s")
	}
	if a := w.Get(p.LastAttacker); a == nil || a.Kind != KindMonster {
		t.Fatalf("attacker %v is not a monster", a)
	}
	if len(s.Out) == 0 {
		t.Fatal("no messages sent to the session")
	}
}
