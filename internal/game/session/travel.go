package session

import (
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 跨场景：一个玩家（Session）在任何时刻只属于一个场景。换场景、换线时，
// 源场景用 TakeOut 把会话拿出来（连接不断），目标场景用 Bring 接进去，再把全部东西重新发一遍。
// 会话对象本身跟着走：token、连接（Link）和输入队列（Inbox）都不变，所以 WebSocket 不用重连。

// 换线被拒绝的原因（以提示消息发给玩家）。
const reasonNoLines = "这里没有别的线"

// Host 是会话系统所在的场景，处理会话自己做不了的、跨场景的事。没有 Host 时（单场景、测试）
// 换线一律拒绝，欢迎消息里不带场景信息。
type Host interface {
	// Gone 在会话的角色被删除之后调用（离开游戏、断线太久、输入刷爆）。
	Gone(session *Session)
	// Lines 回答玩家的线路列表请求。
	Lines(session *Session) *pb.LineList
	// SwitchLine 让玩家去这个场景的第 line 线。不行时返回给玩家看的原因。
	SwitchLine(session *Session, line int) string
	// SceneInfo 是欢迎消息里的场景信息。
	SceneInfo() *pb.SceneInfo
}

// SetHost 设置会话系统所在的场景。
func (sys *System) SetHost(host Host) { sys.host = host }

// Has 报告会话是不是在这个场景里。
func (sys *System) Has(session *Session) bool { return sys.sessions[session] }

// Count 是这个场景里的会话数（含断线保留中的）。
func (sys *System) Count() int { return len(sys.sessions) }

// Each 对这个场景里的每个会话调用 fn。fn 里不能增删会话。
func (sys *System) Each(fn func(*Session)) {
	for session := range sys.sessions {
		fn(session)
	}
}

// TakeOut 把会话从这个场景拿出来，交给别的场景：收回宠物，把角色移出场景
// （周围的玩家收到 Leave），这一帧没发的消息丢掉；连接保持不断。之后这个场景不再碰这个会话和它的角色。
func (sys *System) TakeOut(session *Session) {
	if !sys.sessions[session] {
		return
	}
	sys.flushFrame(session) // 先把 Travel 之前攒下的消息发掉
	delete(sys.sessions, session)
	delete(sys.byToken, session.token)
	delete(sys.byPlayer, session.Player.ID)
	sys.pets.Dismiss(session.Player)
	sys.spawn.Remove(session.Player)
	session.pending = nil
}

// Bring 把从别的场景过来的会话接进这个场景，角色放在 (x, y) 附近的空地上。
// 迁移途中收到的输入作废（是在旧地图上按的）。还连着就把全部东西重新发一遍（Welcome{resumed}），
// 迁移途中断了线就按断线处理：角色保留 world.yaml session.keep 秒等它重连。
func (sys *System) Bring(session *Session, player *core.Entity, x, y float64) {
	session.Player = player
	session.Watch = 0
	session.Inbox.Take()
	sys.sessions[session] = true
	sys.byToken[session.token] = session
	sys.byPlayer[player.ID] = session
	sys.spawn.Place(player, x, y)
	if session.link == nil {
		session.detachedAt = sys.state.Now()
		return
	}
	session.lag = lagMeter{}
	sys.sendFull(session)
	sys.publishGear(true)
	sys.flushFrame(session)
}

// Reattach 把新连接 link 接到这个场景里已有的会话上，并把全部东西重新发一遍（断线重连）。
func (sys *System) Reattach(session *Session, link *Link) {
	if session.link != nil {
		session.link.Close() // 同一个角色又连了一条：旧连接作废
	}
	session.link = link
	session.lag = lagMeter{}
	sys.sendFull(session)
	sys.publishGear(true)
	sys.flushFrame(session)
}

// ReplaceLink 在会话不属于任何场景（迁移途中）时换上新连接 link（nil 表示断线）。
// 旧连接关掉；到达目标场景时 Bring 会按新连接把全部东西发一遍。只有场景管理器在迁移途中调用。
func ReplaceLink(session *Session, link *Link) {
	if session.link != nil && session.link != link {
		session.link.Close()
	}
	session.link = link
}

// LinkIs 报告 link 是不是会话当前的连接。
func LinkIs(session *Session, link *Link) bool { return session.link == link }

// SendTravel 立即告诉玩家他正在前往场景 scene（显示名）：客户端显示过场，等下一个 Welcome。
func (sys *System) SendTravel(session *Session, scene string) {
	travel := &pb.Travel{Scene: &scene}
	sys.SendNow(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Travel{Travel: travel}})
}

// ByPlayer 返回玩家实体 id 对应的会话，没有返回 nil。
func (sys *System) ByPlayer(id int) *Session { return sys.byPlayer[id] }
