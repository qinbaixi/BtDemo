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
	w, err := game.NewWorld(cfg, 1)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go w.Run(ctx)

	srv := httptest.NewServer(Handler(w, fstest.MapFS{"index.html": {Data: []byte("x")}}))
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

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	read := func() *pb.ServerMsg {
		t.Helper()
		conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		typ, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if typ != websocket.BinaryMessage {
			t.Fatalf("frame type %d, want binary", typ)
		}
		msg := &pb.ServerMsg{}
		if err := proto.Unmarshal(data, msg); err != nil {
			t.Fatal(err)
		}
		return msg
	}

	welcome := read().GetWelcome()
	if welcome == nil || welcome.GetId() == 0 || len(welcome.GetSkills()) == 0 {
		t.Fatalf("bad welcome: %v", welcome)
	}
	me := welcome.GetId()

	move, _ := proto.Marshal(&pb.ClientMsg{Msg: &pb.ClientMsg_Move{Move: &pb.Move{Dx: proto.Float32(1), Dy: proto.Float32(0)}}})
	if err := conn.WriteMessage(websocket.BinaryMessage, move); err != nil {
		t.Fatal(err)
	}

	var sawSelf bool
	var firstX, lastX float32
	for i := 0; i < 40; i++ {
		msg := read()
		if e := msg.GetEnter(); e != nil {
			for _, info := range e.GetEnts() {
				if info.GetId() == me {
					sawSelf = info.GetModel() == "knight"
				}
			}
		}
		if s := msg.GetSync(); s != nil {
			for _, st := range s.GetEnts() {
				if st.GetId() == me {
					if firstX == 0 {
						firstX = st.GetX()
					}
					lastX = st.GetX()
				}
			}
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
