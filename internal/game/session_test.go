package game

import (
	"testing"

	"github.com/qinbaixi/BtDemo/internal/config"
)

// A player only receives entities in the nine cells around it, and gets
// leave when they go out of view.
func TestFlushEnterLeave(t *testing.T) {
	w := testWorld()
	w.State.Cfg.World.Player.Respawn = 3
	s := w.Join()
	drain(s)
	s.Player.X, s.Player.Y = 100, 100
	w.Grid.Moved(s.Player)
	far := addTestEntity(w, 50, "monster", 900, 900, config.Attrs{Vit: 5})
	w.Sessions.Flush()
	if s.Visible(far.ID) || !s.Visible(s.Player.ID) {
		t.Fatalf("far visible %v, self visible %v", s.Visible(far.ID), s.Visible(s.Player.ID))
	}
	far.X, far.Y = 250, 250
	w.Grid.Moved(far)
	w.Sessions.Flush()
	if !s.Visible(far.ID) {
		t.Fatal("entity in view not entered")
	}
	far.X, far.Y = 900, 900
	w.Grid.Moved(far)
	w.Sessions.Flush()
	if s.Visible(far.ID) {
		t.Fatal("entity out of view not left")
	}
}

func drain(s *Session) {
	for len(s.Out) > 0 {
		<-s.Out
	}
}
