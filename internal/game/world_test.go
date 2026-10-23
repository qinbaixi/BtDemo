package game

import (
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"testing"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/pb"
	"google.golang.org/protobuf/proto"
)

// 随附的配置和每个导出的行为树都能正常加载，走进史莱姆区域的玩家
// 会被由行为树驱动的怪物攻击。
func TestWorldWithShippedConfig(t *testing.T) {
	cfg, err := config.Load("../../config", TreeNames())
	if err != nil {
		t.Fatal(err)
	}
	world, err := NewWorld(cfg, 1)
	if err != nil {
		t.Fatal(err)
	}
	session := world.Join()
	player := session.Player
	player.X, player.Y = 1000, 900 // 史莱姆出生点的中央
	world.Grid.Moved(player)
	for i := 0; i < 20*20 && player.LastAttacker == 0; i++ {
		world.Step()
	}
	if player.LastAttacker == 0 {
		t.Fatal("no monster attacked the player within 20s")
	}
	if attacker := world.Get(player.LastAttacker); attacker == nil ||
		attacker.Kind != core.KindMonster {
		t.Fatalf("attacker %v is not a monster", attacker)
	}
	if len(sentFrames(session)) == 0 {
		t.Fatal("no messages sent to the session")
	}
}

// 监视某个怪物的会话，每次同步都会收到该怪物的行为树跟踪，
// 且仅在监视期间收到。
func TestWatchSendsAITrace(t *testing.T) {
	cfg, err := config.Load("../../config", TreeNames())
	if err != nil {
		t.Fatal(err)
	}
	world, err := NewWorld(cfg, 1)
	if err != nil {
		t.Fatal(err)
	}
	session := world.Join()
	player := session.Player
	player.X, player.Y = 1000, 900
	world.Grid.Moved(player)
	monster := world.Combat.NearestMonster(player, 400)
	if monster == nil {
		t.Fatal("no monster near the slime spawn")
	}
	drain := func() *pb.AiTrace {
		var last *pb.AiTrace
		for _, msg := range sentMessages(t, session) {
			if msg.GetAi() != nil {
				last = msg.GetAi()
			}
		}
		return last
	}
	for i := 0; i < 4; i++ {
		world.Step()
	}
	if trace := drain(); trace != nil {
		t.Fatal("trace sent without watching")
	}
	world.Input(
		session,
		&pb.ClientMsg{
			Msg: &pb.ClientMsg_Watch{Watch: &pb.Watch{Id: proto.Int32(int32(monster.ID))}},
		},
	)
	for i := 0; i < 4; i++ {
		world.Step()
	}
	trace := drain()
	if trace == nil || trace.GetId() != int32(monster.ID) || len(trace.Ticks) == 0 ||
		len(trace.Ticks[0].Nodes) == 0 {
		t.Fatalf("bad trace %v", trace)
	}
	if trace.Ticks[0].Nodes[0].GetDepth() != 0 || trace.GetTree() == "" {
		t.Fatalf("root step %v tree %q", trace.Ticks[0].Nodes[0], trace.GetTree())
	}
}
