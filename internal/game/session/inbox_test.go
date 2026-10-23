package session

import (
	"errors"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/pb"
)

func moveMsg(dx float32) *pb.ClientMsg {
	return &pb.ClientMsg{Msg: &pb.ClientMsg_Move{Move: &pb.Move{Dx: proto.Float32(dx), Dy: proto.Float32(0)}}}
}

func targetMsg(id int32) *pb.ClientMsg {
	return &pb.ClientMsg{Msg: &pb.ClientMsg_Target{Target: &pb.SetTarget{Id: proto.Int32(id)}}}
}

func castMsg(slot int32) *pb.ClientMsg {
	return &pb.ClientMsg{Msg: &pb.ClientMsg_Cast{Cast: &pb.Cast{Slot: proto.Int32(slot)}}}
}

// 连续的同类状态消息只留最新的；动作消息全部保留；先后顺序不变。
func TestInboxCoalescesStateKeepsOrder(t *testing.T) {
	inbox := &Inbox{}
	for _, msg := range []*pb.ClientMsg{
		moveMsg(1), moveMsg(2), targetMsg(5), castMsg(1), castMsg(1), targetMsg(6), targetMsg(7), moveMsg(3),
	} {
		if err := inbox.Push(msg); err != nil {
			t.Fatal(err)
		}
	}
	messages, overflow := inbox.Take()
	if overflow {
		t.Fatal("unexpected overflow")
	}
	var got []string
	for _, msg := range messages {
		switch body := msg.Msg.(type) {
		case *pb.ClientMsg_Move:
			got = append(got, "move"+string(rune('0'+int(body.Move.GetDx()))))
		case *pb.ClientMsg_Target:
			got = append(got, "target"+string(rune('0'+int(body.Target.GetId()))))
		case *pb.ClientMsg_Cast:
			got = append(got, "cast")
		}
	}
	want := []string{"move2", "target5", "cast", "cast", "target7", "move3"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	if messages, _ := inbox.Take(); len(messages) != 0 {
		t.Fatalf("Take should empty the queue, still %d", len(messages))
	}
}

// 超过上限后 Push 返回错误，并且一直失败，Take 报告溢出。
func TestInboxOverflow(t *testing.T) {
	inbox := &Inbox{}
	for i := 0; i < InboxLimit; i++ {
		if err := inbox.Push(castMsg(1)); err != nil {
			t.Fatalf("push %d: %v", i, err)
		}
	}
	if err := inbox.Push(castMsg(1)); !errors.Is(err, ErrInboxFull) {
		t.Fatalf("want ErrInboxFull, got %v", err)
	}
	if err := inbox.Push(moveMsg(1)); !errors.Is(err, ErrInboxFull) {
		t.Fatalf("after overflow every push should fail, got %v", err)
	}
	if _, overflow := inbox.Take(); !overflow {
		t.Fatal("Take should report overflow")
	}
}
