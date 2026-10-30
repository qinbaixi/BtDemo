package core

// RoomPhase 是副本里一个房间的进度。
type RoomPhase int

const (
	RoomIdle    RoomPhase = iota // 还没人进来
	RoomFight                    // 打起来了：门关着，一波一波刷怪
	RoomClear                    // 清完了
	RoomSkipped                  // 岔路选了另一边，再也去不了
)

// RoomStatus 是一个房间现在的样子（同步给客户端）。
type RoomStatus struct {
	ID    string
	Phase RoomPhase
	Wave  int // 打到第几波（从 1 开始），没开打是 0
}

// GateStatus 是一扇门现在开没开（同步给客户端）。
type GateStatus struct {
	ID   string
	Open bool
}

// Level 是副本的进度：每个房间、每扇门。不是副本的场景两个列表都是空的。
// 变化很少，变了整份重发给客户端，Version 每次变化都加一，会话靠它知道要不要重发。
type Level struct {
	Rooms   []*RoomStatus
	Gates   []*GateStatus
	Keys    []string // 拿到的钥匙（清完配了 key 的房间给），按拿到的顺序
	Version int
}
