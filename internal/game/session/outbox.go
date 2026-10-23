package session

import (
	"log"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 发送：每个玩家有一个这一帧的待发列表。SendTo / Broadcast 只往列表里放，同步帧结束时（Flush）
// 列表里的消息按顺序合成一个 Frame，一次写进连接；SendNow / BroadcastNow 不等，连同列表里
// 已经攒着的消息立即写出（先发攒着的，保证顺序不乱）。
// 断线期间（link 为 nil）什么都不攒：重连时反正要把全部东西重新发一遍。

// SendTo 把 msg 放进 session 这一帧的包里。
func (sys *System) SendTo(session *Session, msg *pb.ServerMsg) {
	if !sys.sessions[session] || session.link == nil || session.resync {
		return
	}
	session.pending = append(session.pending, msg)
}

// SendNow 立即把 msg（连同这一帧已经攒着的消息）发给 session。
func (sys *System) SendNow(session *Session, msg *pb.ServerMsg) {
	sys.SendTo(session, msg)
	sys.flushFrame(session)
}

// Broadcast 把 msg 放进能看到 (x, y) 的每个玩家这一帧的包里。
func (sys *System) Broadcast(x, y float64, msg *pb.ServerMsg) {
	sys.grid.PlayersAround(x, y, func(player *core.Entity) {
		if session := sys.byPlayer[player.ID]; session != nil {
			sys.SendTo(session, msg)
		}
	})
}

// BroadcastNow 立即把 msg 发给能看到 (x, y) 的每个玩家。
func (sys *System) BroadcastNow(x, y float64, msg *pb.ServerMsg) {
	sys.grid.PlayersAround(x, y, func(player *core.Entity) {
		if session := sys.byPlayer[player.ID]; session != nil {
			sys.SendNow(session, msg)
		}
	})
}

// flushFrame 把 session 待发的消息合成一个 Frame 写进连接。连接积压太多时交给 lagging 处理。
func (sys *System) flushFrame(session *Session) {
	if len(session.pending) == 0 {
		return
	}
	frame := &pb.Frame{Time: core.F32(sys.state.Now()), Msgs: session.pending}
	session.pending = nil
	if session.link == nil {
		return
	}
	data, err := proto.Marshal(frame)
	if err != nil {
		// 少了一帧客户端的视野就对不上了：下一帧发全量
		log.Printf("player %d: marshal: %v, sending full state next", session.Player.ID, err)
		session.resync = true
		return
	}
	if !session.link.Push(data) {
		sys.lagging(session)
	}
}
