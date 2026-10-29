package server

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 浏览器通过 WebSocket 连接后会收到 Welcome，随后是 Enter 和 Sync
// 帧（均为二进制 protobuf），并且其 Move 输入会被应用。
func TestWebSocketProtocol(t *testing.T) {
	cfg, err := config.Load("../../config", game.TreeNames())
	if err != nil {
		t.Fatal(err)
	}
	manager, err := game.NewManager(cfg, 1)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go manager.Run(ctx)

	srv := httptest.NewServer(Handler(manager, fstest.MapFS{"index.html": {Data: []byte("x")}}))
	defer srv.Close()

	// 浏览器读到的地图和服务端加载的是同一份
	res, err := http.Get(srv.URL + "/map.tmj")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || !bytes.Equal(body, cfg.Layout.Source) || len(body) == 0 {
		t.Fatalf("/map.tmj: status %d, %d bytes", res.StatusCode, len(body))
	}

	conn, _, err := websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(srv.URL, "http")+"/ws",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	hello, _ := proto.Marshal(&pb.ClientMsg{Msg: &pb.ClientMsg_Hello{Hello: &pb.Hello{}}})
	if err := conn.WriteMessage(websocket.BinaryMessage, hello); err != nil {
		t.Fatal(err)
	}

	var queued []*pb.ServerMsg
	read := func() *pb.ServerMsg {
		t.Helper()
		for len(queued) == 0 {
			conn.SetReadDeadline(time.Now().Add(3 * time.Second))
			typ, data, err := conn.ReadMessage()
			if err != nil {
				t.Fatal(err)
			}
			if typ != websocket.BinaryMessage {
				t.Fatalf("frame type %d, want binary", typ)
			}
			frame := &pb.Frame{}
			if err := proto.Unmarshal(data, frame); err != nil {
				t.Fatal(err)
			}
			queued = frame.Msgs
		}
		msg := queued[0]
		queued = queued[1:]
		return msg
	}

	welcome := read().GetWelcome()
	if welcome == nil || welcome.GetId() == 0 || len(welcome.GetSkills()) == 0 {
		t.Fatalf("bad welcome: %v", welcome)
	}
	myID := welcome.GetId()

	move, _ := proto.Marshal(
		&pb.ClientMsg{
			Msg: &pb.ClientMsg_Move{Move: &pb.Move{Dx: proto.Int32(10000), Dy: proto.Int32(0)}},
		},
	)
	if err := conn.WriteMessage(websocket.BinaryMessage, move); err != nil {
		t.Fatal(err)
	}

	var sawSelf bool
	var firstX, lastX int32
	for i := 0; i < 40; i++ {
		msg := read()
		if enter := msg.GetEnter(); enter != nil {
			for _, info := range enter.GetEnts() {
				if info.GetId() == myID {
					sawSelf = info.GetModel() == "knight"
					firstX = info.GetState().GetX()
				}
			}
		}
		if entityState := msg.GetState(); entityState.GetId() == myID && entityState.X != nil {
			if firstX == 0 {
				firstX = entityState.GetX()
			}
			lastX = entityState.GetX()
		}
	}
	if !sawSelf {
		t.Fatal("never entered own character with the knight model")
	}
	if lastX <= firstX {
		t.Fatalf("move input not applied: x %v -> %v", firstX, lastX)
	}

	resp, err := srv.Client().Get(srv.URL + "/btdemo.proto")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("proto not served: %v %v", err, resp)
	}
}

// 连接断开后带着 token 重连：同一个角色，先收到 Welcome{resumed}。
func TestWebSocketReconnect(t *testing.T) {
	cfg, err := config.Load("../../config", game.TreeNames())
	if err != nil {
		t.Fatal(err)
	}
	manager, err := game.NewManager(cfg, 1)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go manager.Run(ctx)
	srv := httptest.NewServer(Handler(manager, fstest.MapFS{}))
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"

	dial := func(hello *pb.Hello) *websocket.Conn {
		t.Helper()
		conn, _, err := websocket.DefaultDialer.Dial(url, nil)
		if err != nil {
			t.Fatal(err)
		}
		data, _ := proto.Marshal(&pb.ClientMsg{Msg: &pb.ClientMsg_Hello{Hello: hello}})
		if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
			t.Fatal(err)
		}
		return conn
	}
	firstMessage := func(conn *websocket.Conn) *pb.ServerMsg {
		t.Helper()
		conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		frame := &pb.Frame{}
		if err := proto.Unmarshal(data, frame); err != nil || len(frame.Msgs) == 0 {
			t.Fatalf("bad frame: %v", err)
		}
		return frame.Msgs[0]
	}

	first := dial(&pb.Hello{})
	welcome := firstMessage(first).GetWelcome()
	if welcome.GetToken() == "" {
		t.Fatal("welcome has no token")
	}
	first.Close()

	second := dial(&pb.Hello{Token: welcome.Token})
	defer second.Close()
	again := firstMessage(second).GetWelcome()
	if again == nil || !again.GetResumed() || again.GetId() != welcome.GetId() {
		t.Fatalf("reconnect: got %v, want a resumed welcome for player %d", again, welcome.GetId())
	}
}

// 第一帧不是 Hello 的连接被关闭，不会创建角色。
func TestFirstFrameMustBeHello(t *testing.T) {
	cfg, err := config.Load("../../config", game.TreeNames())
	if err != nil {
		t.Fatal(err)
	}
	manager, err := game.NewManager(cfg, 1)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go manager.Run(ctx)
	srv := httptest.NewServer(Handler(manager, fstest.MapFS{}))
	defer srv.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	move, _ := proto.Marshal(&pb.ClientMsg{Msg: &pb.ClientMsg_Move{Move: &pb.Move{Dx: proto.Int32(10000), Dy: proto.Int32(0)}}})
	conn.WriteMessage(websocket.BinaryMessage, move)
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("server answered a connection that did not start with Hello")
	}
}
