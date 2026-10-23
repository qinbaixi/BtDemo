package session

import "sync"

// LinkByteLimit 是一个连接还没写出去的字节上限。超过说明客户端（或它的网络）跟不上：
// 不再往里塞，改为清掉积压、给它发一份全量（见 System.lagging）。
const LinkByteLimit = 1 << 20

// Link 是会话和一条 WebSocket 连接之间的发送队列：世界 goroutine Push，
// 连接的写协程等 Wake 后 Take 全部写出去。断线重连时会话换一个新的 Link，角色不变。
//
// 用互斥锁加切片而不是有界 channel：队列满不满按字节算，满了由世界决定怎么处理（发全量），
// 而不是在某个 channel 上阻塞或悄悄丢帧。
type Link struct {
	mutex  sync.Mutex
	frames [][]byte
	bytes  int
	closed bool
	wake   chan struct{}
}

// NewLink 创建一个连接的发送队列。
func NewLink() *Link {
	return &Link{wake: make(chan struct{}, 1)}
}

// Push 把一帧放进队列。队列已关闭返回 true（帧直接丢弃，会话已经不用这个连接了）；
// 积压超过 LinkByteLimit 时不放入并返回 false。队列是空的时候总能放入，
// 否则一个本身就超过上限的帧（比如实体很密集时的全量）永远发不出去。
func (link *Link) Push(frame []byte) bool {
	link.mutex.Lock()
	defer link.mutex.Unlock()
	if link.closed {
		return true
	}
	if link.bytes > 0 && link.bytes+len(frame) > LinkByteLimit {
		return false
	}
	link.frames = append(link.frames, frame)
	link.bytes += len(frame)
	link.notify()
	return true
}

// Discard 清掉还没写出去的帧（客户端跟不上时，接下来要发全量，旧的不用再发）。
func (link *Link) Discard() {
	link.mutex.Lock()
	defer link.mutex.Unlock()
	link.frames, link.bytes = nil, 0
}

// Take 取走全部待写的帧，并报告队列是否已关闭（关闭后写协程写完这些帧就该断开连接）。
func (link *Link) Take() (frames [][]byte, closed bool) {
	link.mutex.Lock()
	defer link.mutex.Unlock()
	frames, link.frames, link.bytes = link.frames, nil, 0
	return frames, link.closed
}

// Wake 在有新帧或队列关闭时收到信号。
func (link *Link) Wake() <-chan struct{} { return link.wake }

// Close 关闭队列：之后的 Push 都被忽略，写协程写完剩下的帧后断开连接。
func (link *Link) Close() {
	link.mutex.Lock()
	defer link.mutex.Unlock()
	link.closed = true
	link.notify()
}

// notify 叫醒写协程；已经有一个信号没被取走时不用再发。须持有 mutex。
func (link *Link) notify() {
	select {
	case link.wake <- struct{}{}:
	default:
	}
}
