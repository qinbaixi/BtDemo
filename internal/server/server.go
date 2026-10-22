// Package server 提供浏览器客户端和游戏 WebSocket 服务。
package server

import (
	"io/fs"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/game"
	"github.com/qinbaixi/BtDemo/internal/pb"
	btproto "github.com/qinbaixi/BtDemo/proto"
)

var upgrader = websocket.Upgrader{ReadBufferSize: 1024, WriteBufferSize: 4096}

// Handler 从 static 目录提供静态文件，在 /map.tmj 提供地图，并在 /ws 提供游戏 socket。
func Handler(world *game.World, static fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(static)))
	mux.HandleFunc("/btdemo.proto", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write(btproto.Source)
	})
	// 地图文件原样提供给浏览器：前端用它画场景，服务端用同一份做碰撞。
	mapSrc := world.State.Cfg.Layout.Source
	mux.HandleFunc("/map.tmj", func(w http.ResponseWriter, r *http.Request) {
		if mapSrc == nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(mapSrc)
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serve(world, conn)
	})
	return mux
}

// serve 处理一个连接：每个连接都会获得一个全新的角色。
func serve(world *game.World, conn *websocket.Conn) {
	defer conn.Close()
	joined := make(chan *game.Session, 1)
	world.Do(func() { joined <- world.Join() })
	session := <-joined
	log.Printf("player %d joined", session.Player.ID)
	defer log.Printf("player %d left", session.Player.ID)

	go func() {
		for data := range session.Out {
			conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
				conn.Close()
				for range session.Out { // 持续读取直到 Leave 关闭通道
				}
				return
			}
		}
		// 世界丢弃了该会话（例如它落后了）：关闭连接，使客户端重新连接。
		conn.WriteMessage(websocket.CloseMessage, nil)
		conn.Close()
	}()

	conn.SetReadLimit(4096)
	for {
		typ, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if typ != websocket.BinaryMessage {
			continue
		}
		msg := &pb.ClientMsg{}
		if proto.Unmarshal(data, msg) != nil {
			continue
		}
		world.Do(func() { world.Input(session, msg) })
	}
	world.Do(func() { world.Leave(session) })
}
