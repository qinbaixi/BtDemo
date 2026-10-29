package game

import (
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/game/session"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 断线后带着 token 重连：同一个角色，Welcome{resumed} 之后把背包、周围实体等全部重新发一遍。
func TestReconnectSendsFullState(t *testing.T) {
	world := shippedWorld(t)
	client := world.Join()
	oldLink := client.Link()
	stepMillis(world, 1000)
	sentFrames(client)
	world.Detach(client, oldLink)
	stepMillis(world, 2000)
	if world.Get(client.Player.ID) == nil {
		t.Fatal("character removed right after disconnect")
	}

	if back := world.Attach(session.NewLink(), client.Token()); back != client {
		t.Fatal("reconnect with the token should return the same character")
	}
	stepMillis(world, 200)
	msgs := sentMessages(t, client)
	welcome := msgs[0].GetWelcome()
	if welcome == nil || !welcome.GetResumed() || welcome.GetId() != int32(client.Player.ID) {
		t.Fatalf("first message should be a resumed welcome for the same player, got %v", msgs[0])
	}
	var sawInventory, sawSelfEnter, sawSelfInfo bool
	for _, msg := range msgs {
		sawInventory = sawInventory || msg.GetInventory() != nil
		sawSelfInfo = sawSelfInfo || msg.GetSelf().GetLv() > 0
		for _, info := range msg.GetEnter().GetEnts() {
			sawSelfEnter = sawSelfEnter || info.GetId() == int32(client.Player.ID)
		}
	}
	if !sawInventory || !sawSelfEnter || !sawSelfInfo {
		t.Fatalf("full state: inventory %v, enter self %v, self info %v", sawInventory, sawSelfEnter, sawSelfInfo)
	}
	if _, closed := oldLink.Take(); !closed {
		t.Fatal("the old connection should be closed")
	}
}

// 不认识的 token：新角色。
func TestUnknownTokenStartsNewCharacter(t *testing.T) {
	world := shippedWorld(t)
	first := world.Join()
	other := world.Attach(session.NewLink(), "not-a-token")
	if other == first || other.Token() == first.Token() {
		t.Fatal("an unknown token must not take over another character")
	}
}

// 断线超过 session.keep 秒没回来就删除角色；断线期间角色站着不动。
func TestDetachedCharacterExpires(t *testing.T) {
	world := shippedWorld(t)
	client := world.Join()
	client.Player.MoveX = 1
	world.Detach(client, client.Link())
	if client.Player.MoveX != 0 {
		t.Fatal("a disconnected character should stop moving")
	}
	keep := world.State.Cfg.World.Session.Keep
	stepMillis(world, keep-1000)
	if world.Get(client.Player.ID) == nil {
		t.Fatal("removed before session.keep")
	}
	stepMillis(world, 2000)
	if world.Get(client.Player.ID) != nil {
		t.Fatal("still there after session.keep")
	}
	if back := world.Attach(session.NewLink(), client.Token()); back == client {
		t.Fatal("an expired token must start a new character")
	}
}

// 客户端跟不上（发送队列积压超过上限）：不断开、不丢角色，清掉积压后发一份全量。
func TestLaggingClientGetsFullState(t *testing.T) {
	world := shippedWorld(t)
	client := world.Join()
	sentFrames(client)
	client.Link().Push(make([]byte, session.LinkByteLimit-10)) // 写协程卡住了，积压快满
	stepMillis(world, 200)
	if world.Get(client.Player.ID) == nil || client.Link() == nil {
		t.Fatal("a lagging client should keep its character and connection")
	}
	stepMillis(world, 200)
	msgs := sentMessages(t, client)
	if len(msgs) == 0 || !msgs[0].GetWelcome().GetResumed() {
		t.Fatal("after falling behind the client should get a resumed welcome first")
	}
}

// 同步帧里的消息合成一个 Frame：一个同步帧最多写出一个包（玩家操作的立即回应除外）。
func TestOneFramePerSync(t *testing.T) {
	world := shippedWorld(t)
	client := world.Join()
	stepMillis(world, 200)
	sentFrames(client)
	syncEvery := world.State.Cfg.World.TickRate / world.State.Cfg.World.SyncRate
	for range syncEvery {
		world.Step()
	}
	if frames := sentFrames(client); len(frames) > 1 {
		t.Fatalf("%d frames in one sync tick, want at most 1", len(frames))
	}
}

// 断线前没来得及处理的输入作废：断线的角色不会因为残留的移动消息继续走。
func TestInputAfterDetachIsDropped(t *testing.T) {
	world := shippedWorld(t)
	client := world.Join()
	move := &pb.ClientMsg{Msg: &pb.ClientMsg_Move{Move: &pb.Move{Dx: proto.Int32(10000), Dy: proto.Int32(0)}}}
	client.Inbox.Push(move)
	world.Detach(client, client.Link())
	world.Sessions.DrainInputs()
	if client.Player.MoveX != 0 {
		t.Fatal("a disconnected character picked up a leftover move")
	}
}
