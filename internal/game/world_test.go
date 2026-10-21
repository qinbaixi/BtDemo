package game

import (
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"testing"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/pb"
	"google.golang.org/protobuf/proto"
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
	if a := w.Get(p.LastAttacker); a == nil || a.Kind != core.KindMonster {
		t.Fatalf("attacker %v is not a monster", a)
	}
	if len(s.Out) == 0 {
		t.Fatal("no messages sent to the session")
	}
}

// A session that watches a monster gets its behavior tree trace with each
// sync, and only while watching.
func TestWatchSendsAITrace(t *testing.T) {
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
	p.X, p.Y = 1000, 900
	w.Grid.Moved(p)
	m := w.Combat.NearestMonster(p, 400)
	if m == nil {
		t.Fatal("no monster near the slime spawn")
	}
	drain := func() *pb.AiTrace {
		var last *pb.AiTrace
		for len(s.Out) > 0 {
			var msg pb.ServerMsg
			if err := proto.Unmarshal(<-s.Out, &msg); err != nil {
				t.Fatal(err)
			}
			if sy := msg.GetSync(); sy != nil && sy.Ai != nil {
				last = sy.Ai
			}
		}
		return last
	}
	for i := 0; i < 4; i++ {
		w.Step()
	}
	if tr := drain(); tr != nil {
		t.Fatal("trace sent without watching")
	}
	w.Input(s, &pb.ClientMsg{Msg: &pb.ClientMsg_Watch{Watch: &pb.Watch{Id: proto.Int32(int32(m.ID))}}})
	for i := 0; i < 4; i++ {
		w.Step()
	}
	tr := drain()
	if tr == nil || tr.GetId() != int32(m.ID) || len(tr.Ticks) == 0 || len(tr.Ticks[0].Nodes) == 0 {
		t.Fatalf("bad trace %v", tr)
	}
	if tr.Ticks[0].Nodes[0].GetDepth() != 0 || tr.GetTree() == "" {
		t.Fatalf("root step %v tree %q", tr.Ticks[0].Nodes[0], tr.GetTree())
	}
}
