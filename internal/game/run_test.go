package game

import (
	"context"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/session"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// sentFrames 取走会话发送队列里的全部帧。
func sentFrames(client *Session) [][]byte {
	frames, _ := client.Link().Take()
	return frames
}

// sentMessages 取走会话发送队列里的全部帧，按顺序展开成消息。
func sentMessages(t *testing.T, client *Session) []*pb.ServerMsg {
	t.Helper()
	var msgs []*pb.ServerMsg
	for _, data := range sentFrames(client) {
		frame := &pb.Frame{}
		if err := proto.Unmarshal(data, frame); err != nil {
			t.Fatal(err)
		}
		msgs = append(msgs, frame.Msgs...)
	}
	return msgs
}

// canSee 报告会话的玩家能否看到实体 id（由格子决定）。
func canSee(world *World, client *Session, id int) bool {
	target := world.Get(id)
	return target != nil && world.Grid.CanSee(client.Player, target)
}

func shippedWorld(t *testing.T) *World {
	t.Helper()
	cfg, err := config.Load("../../config", TreeNames())
	if err != nil {
		t.Fatal(err)
	}
	world, err := NewWorld(cfg, 1)
	if err != nil {
		t.Fatal(err)
	}
	return world
}

// Run 在 tick 开头处理排队的输入；停服时跑完已接受的命令、关闭所有会话，之后 Do 返回 false。
func TestRunAppliesInputsAndStopsCleanly(t *testing.T) {
	world := shippedWorld(t)
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		world.Run(ctx)
		close(stopped)
	}()

	joined := make(chan *Session, 1)
	if !world.Do(func() { joined <- world.Join() }) {
		t.Fatal("Do refused before stop")
	}
	client := <-joined
	link := client.Link()
	move := &pb.ClientMsg{Msg: &pb.ClientMsg_Move{Move: &pb.Move{Dx: proto.Int32(10000), Dy: proto.Int32(0)}}}
	if err := client.Inbox.Push(move); err != nil {
		t.Fatal(err)
	}
	moved := make(chan float64, 1)
	deadline := time.Now().Add(2 * time.Second)
	for {
		world.Do(func() { moved <- client.Player.MoveX })
		if <-moved == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("queued move was never applied")
		}
	}

	ran := make(chan bool, 1)
	world.Do(func() { ran <- true })
	cancel()
	<-stopped
	select {
	case <-ran:
	default:
		t.Fatal("a command accepted before stop did not run")
	}
	if world.Do(func() {}) {
		t.Fatal("Do should refuse after stop")
	}
	if _, closed := link.Take(); !closed {
		t.Fatal("stopping the world should close the session's connection")
	}
}

// 输入队列溢出的会话在下一个 tick 被断开。
func TestDrainInputsDisconnectsOverflow(t *testing.T) {
	world := shippedWorld(t)
	client := world.Join()
	cast := &pb.ClientMsg{Msg: &pb.ClientMsg_Cast{Cast: &pb.Cast{Slot: proto.Int32(1)}}}
	for i := 0; i <= session.InboxLimit; i++ {
		client.Inbox.Push(cast)
	}
	world.Sessions.DrainInputs()
	if world.Get(client.Player.ID) != nil {
		t.Fatal("overflowing session's player should be removed")
	}
}
