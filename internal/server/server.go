// Package server 提供浏览器客户端和游戏 WebSocket 服务。
package server

import (
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/game"
	"github.com/qinbaixi/BtDemo/internal/game/session"
	"github.com/qinbaixi/BtDemo/internal/pb"
	btproto "github.com/qinbaixi/BtDemo/proto"
)

var upgrader = websocket.Upgrader{ReadBufferSize: 1024, WriteBufferSize: 4096}

// Handler 从 static 目录提供静态文件，在 /maps/<文件名> 提供各场景的地图（/map.tmj 是默认场景的），
// 在 /debug/scenes 列出每条线的运行情况，并在 /ws 提供游戏 socket。
func Handler(manager *game.Manager, static fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(static)))
	mux.HandleFunc("/btdemo.proto", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write(btproto.Source)
	})
	// 地图文件原样提供给浏览器：前端用它画场景，服务端用同一份做碰撞。
	serveMap := func(w http.ResponseWriter, r *http.Request, source []byte) {
		if source == nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(source)
	}
	mux.HandleFunc("/map.tmj", func(w http.ResponseWriter, r *http.Request) {
		serveMap(w, r, manager.DefaultMap())
	})
	mux.HandleFunc("/maps/", func(w http.ResponseWriter, r *http.Request) {
		serveMap(w, r, manager.MapSource(strings.TrimPrefix(r.URL.Path, "/maps/")))
	})
	mux.HandleFunc("/debug/scenes", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		encoder := json.NewEncoder(w)
		encoder.SetIndent("", "  ")
		encoder.Encode(manager.Status())
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serve(manager, conn)
	})
	return mux
}

// 连接参数。
const (
	readLimit    = 64 << 10         // 单个客户端帧的字节上限
	helloTimeout = 10 * time.Second // 连上后多久内必须发来 Hello
	readTimeout  = 15 * time.Second // 这么久没收到任何东西（含 pong）就认为连接已死
	pingInterval = 5 * time.Second  // 服务端发 WebSocket ping 的间隔
	writeTimeout = 10 * time.Second // 单帧写出的超时
	badFrameMax  = 10               // 解不开的帧超过这么多就断开
)

// serve 处理一条连接：先读 Hello，按 token 接回原来的角色或创建新角色，
// 然后一个写协程负责发送，当前协程负责接收。连接断开时角色保留，等客户端重连。
func serve(manager *game.Manager, conn *websocket.Conn) {
	defer conn.Close()
	conn.SetReadLimit(readLimit)
	hello, ok := readHello(conn)
	if !ok {
		return
	}
	link := session.NewLink()
	client := manager.Attach(link, hello.GetToken())
	if client == nil {
		return // 正在停服
	}
	playerID := client.Player.ID
	log.Printf("player %d connected", playerID)
	defer log.Printf("player %d disconnected", playerID)

	go writeLoop(conn, link)
	readLoop(conn, client, playerID)
	manager.Detach(client, link)
}

// readHello 读连接的第一帧，它必须是 Hello。
func readHello(conn *websocket.Conn) (*pb.Hello, bool) {
	conn.SetReadDeadline(time.Now().Add(helloTimeout))
	typ, data, err := conn.ReadMessage()
	if err != nil || typ != websocket.BinaryMessage {
		return nil, false
	}
	msg := &pb.ClientMsg{}
	if proto.Unmarshal(data, msg) != nil || msg.GetHello() == nil {
		log.Printf("connection from %s: first frame is not Hello", conn.RemoteAddr())
		return nil, false
	}
	return msg.GetHello(), true
}

// readLoop 把收到的客户端消息放进会话的输入队列，直到连接出错、超时或客户端异常。
func readLoop(conn *websocket.Conn, client *game.Session, playerID int) {
	conn.SetReadDeadline(time.Now().Add(readTimeout))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(readTimeout))
	})
	badFrames := 0
	for {
		typ, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		conn.SetReadDeadline(time.Now().Add(readTimeout))
		msg := &pb.ClientMsg{}
		if typ != websocket.BinaryMessage || proto.Unmarshal(data, msg) != nil {
			badFrames++
			if badFrames > badFrameMax {
				log.Printf("player %d: too many bad frames, closing connection", playerID)
				return
			}
			continue
		}
		if err := client.Inbox.Push(msg); err != nil {
			// 世界下一个 tick 会看到溢出并删掉角色；这里不再读，直接断开
			log.Printf("player %d: %v", playerID, err)
			return
		}
	}
}

// writeLoop 把发送队列里的帧写给客户端，并定时发 ping。
// 队列关闭（角色被删、换了新连接、停服）时写完剩下的帧，发关闭帧后断开；写失败时直接断开。
func writeLoop(conn *websocket.Conn, link *session.Link) {
	ping := time.NewTicker(pingInterval)
	defer ping.Stop()
	defer conn.Close() // 让读协程也退出
	for {
		select {
		case <-link.Wake():
			frames, closed := link.Take()
			for _, data := range frames {
				conn.SetWriteDeadline(time.Now().Add(writeTimeout))
				if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
					return
				}
			}
			if closed {
				conn.SetWriteDeadline(time.Now().Add(writeTimeout))
				conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
		case <-ping.C:
			deadline := time.Now().Add(writeTimeout)
			if err := conn.WriteControl(websocket.PingMessage, nil, deadline); err != nil {
				return
			}
		}
	}
}
