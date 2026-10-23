package session

import (
	"crypto/rand"
	"encoding/hex"
	"log"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 连接与重连。
//
// WebSocket 跑在 TCP 上，传输途中不会丢；会丢的只有两头的队列和断线。协议里不带序号，规则很简单：
//   - 断线时角色不删，只把 link 置空（原地站着，照样会被打会死），world.yaml session.keep 秒内
//     带着 token 重连就接回来，并且把这个玩家需要的东西全部重新发一遍（sendFull）。
//   - 客户端跟不上（Link 积压超过 LinkByteLimit）时不踢人也不悄悄丢帧：清掉积压、下一帧发全量；
//     lagLimit 秒内第 lagStrikes 次才断开连接，客户端重连后同样拿到全量。

// 客户端跟不上的判定：lagLimit 秒内触发 lagStrikes 次积压溢出就断开连接。
const (
	lagStrikes = 3
	lagLimit   = 10.0
)

// lagMeter 记录最近一段时间里客户端跟不上的次数。
type lagMeter struct {
	since   float64 // 这一轮计数开始的时刻
	strikes int
}

// newToken 生成一个随机的重连凭证。
func newToken() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(err) // crypto/rand 不会失败；真失败了说明系统有问题
	}
	return hex.EncodeToString(raw[:])
}

// lagging 处理跟不上的客户端：清掉连接里的积压和这一帧没发的消息，下次 Flush 前发全量；
// lagLimit 秒内第 lagStrikes 次就断开连接（角色保留，客户端重连后接着玩）。
func (sys *System) lagging(session *Session) {
	now := sys.state.Now()
	if now-session.lag.since > lagLimit {
		session.lag = lagMeter{since: now}
	}
	session.lag.strikes++
	session.link.Discard()
	session.pending = nil
	session.resync = true
	if session.lag.strikes >= lagStrikes {
		log.Printf("player %d: client keeps falling behind, closing connection", session.Player.ID)
		sys.detach(session)
		return
	}
	log.Printf("player %d: client fell behind, sending full state", session.Player.ID)
}

// sendFull 把这个玩家需要的东西全部重新发一遍：Welcome{resumed}（客户端收到后清空实体），
// 周围所有实体的 Enter，背包、宠物状态、自身属性、回血区和行为树结构也标记为要重发。
func (sys *System) sendFull(session *Session) {
	session.resync = false
	session.pending = nil
	welcome := sys.welcome(session)
	welcome.Resumed = proto.Bool(true)
	sys.SendTo(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Welcome{Welcome: welcome}})
	sys.showAround(session)
	session.zonesSent = -1
	session.defSent = ""
	session.selfSent = nil
	session.Player.InventoryDirty = true
	session.Player.PetDirty = true
}

// Attach 把一条新连接接到角色上：token 认得的角色就接回去并发全量，
// 认不得（空、过期、伪造）就创建新角色。
func (sys *System) Attach(link *Link, token string) *Session {
	session := sys.byToken[token]
	if token == "" || session == nil {
		return sys.Join(link)
	}
	log.Printf("player %d: reconnected, sending full state", session.Player.ID)
	sys.Reattach(session, link)
	return session
}

// Detach 处理连接断开：link 还是会话当前的连接时，角色进入断线保留状态，
// world.yaml session.keep 秒内没重连就删除。link 已经被新连接替换时什么都不做。
func (sys *System) Detach(session *Session, link *Link) {
	if !sys.sessions[session] || session.link != link {
		return
	}
	sys.detach(session)
}

// detach 关闭会话当前的连接，角色留下，停下移动和格挡。
func (sys *System) detach(session *Session) {
	session.link.Close()
	session.link = nil
	session.pending = nil
	session.detachedAt = sys.state.Now()
	player := session.Player
	player.MoveX, player.MoveY = 0, 0
	player.SetBlocking(false)
}

// ExpireDetached 删除断线超过 world.yaml session.keep 秒的角色。每个 tick 调用一次。
func (sys *System) ExpireDetached() {
	keep := sys.state.Cfg.World.Session.Keep
	now := sys.state.Now()
	for session := range sys.sessions {
		if session.link == nil && now-session.detachedAt > keep {
			log.Printf("player %d: did not reconnect within %.0fs, removing", session.Player.ID, keep)
			sys.Leave(session)
		}
	}
}
