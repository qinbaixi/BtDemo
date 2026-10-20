// Package server serves the browser client and the game WebSocket.
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

// Handler serves static files from static and the game socket at /ws.
func Handler(w *game.World, static fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(static)))
	mux.HandleFunc("/btdemo.proto", func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "text/plain; charset=utf-8")
		rw.Write(btproto.Source)
	})
	mux.HandleFunc("/ws", func(rw http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(rw, r, nil)
		if err != nil {
			return
		}
		serve(w, conn)
	})
	return mux
}

// serve runs one connection: every connection gets a brand new character.
func serve(w *game.World, conn *websocket.Conn) {
	defer conn.Close()
	joined := make(chan *game.Session, 1)
	w.Do(func() { joined <- w.Join() })
	s := <-joined
	log.Printf("player %d joined", s.Player.ID)
	defer log.Printf("player %d left", s.Player.ID)

	go func() {
		for data := range s.Out {
			conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
				conn.Close()
				for range s.Out { // drain until Leave closes the channel
				}
				return
			}
		}
		// The world dropped the session (e.g. it fell behind): close so the client reconnects.
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
		w.Do(func() { w.Input(s, msg) })
	}
	w.Do(func() { w.Leave(s) })
}
