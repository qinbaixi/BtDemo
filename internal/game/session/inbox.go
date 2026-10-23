package session

import (
	"errors"
	"sync"

	"github.com/qinbaixi/BtDemo/internal/pb"
)

// InboxLimit 是一个会话在两个 tick 之间最多能排队的客户端消息数。
// 正常客户端每 tick 只有几条；超过说明客户端异常或恶意刷包，直接断开它，不影响其他人。
const InboxLimit = 128

// ErrInboxFull 表示会话的输入队列超过了 InboxLimit。
var ErrInboxFull = errors.New("输入队列已满")

// Inbox 是一个会话的客户端消息队列：网络读协程 Push，世界 goroutine 每个 tick 开头 Take。
// 不阻塞写入方，也不丢消息：要么入队，要么返回错误让调用方断开连接。
//
// 状态型消息（移动、选目标、格挡）只关心最新值：如果队尾正好是同类消息，就用新的替换它。
// 只和队尾比较，所以消息之间的先后顺序不会变（例如“选目标”之后的“施法”仍然用新目标）。
type Inbox struct {
	mutex    sync.Mutex
	messages []*pb.ClientMsg
	overflow bool
}

// Push 把一条客户端消息放进队列。队列满时返回 ErrInboxFull，之后的 Push 也都失败。
func (inbox *Inbox) Push(msg *pb.ClientMsg) error {
	inbox.mutex.Lock()
	defer inbox.mutex.Unlock()
	if inbox.overflow {
		return ErrInboxFull
	}
	if last := len(inbox.messages) - 1; last >= 0 && sameStateKind(inbox.messages[last], msg) {
		inbox.messages[last] = msg
		return nil
	}
	if len(inbox.messages) >= InboxLimit {
		inbox.overflow = true
		return ErrInboxFull
	}
	inbox.messages = append(inbox.messages, msg)
	return nil
}

// Take 取走队列里的全部消息（按到达顺序），并报告队列是否溢出过。
func (inbox *Inbox) Take() (messages []*pb.ClientMsg, overflow bool) {
	inbox.mutex.Lock()
	defer inbox.mutex.Unlock()
	messages, inbox.messages = inbox.messages, nil
	return messages, inbox.overflow
}

// sameStateKind 报告 previous 和 next 是不是同一种状态型消息（新的可以直接替换旧的）。
func sameStateKind(previous, next *pb.ClientMsg) bool {
	switch next.Msg.(type) {
	case *pb.ClientMsg_Move:
		_, same := previous.Msg.(*pb.ClientMsg_Move)
		return same
	case *pb.ClientMsg_Target:
		_, same := previous.Msg.(*pb.ClientMsg_Target)
		return same
	case *pb.ClientMsg_Block:
		_, same := previous.Msg.(*pb.ClientMsg_Block)
		return same
	case *pb.ClientMsg_Watch:
		_, same := previous.Msg.(*pb.ClientMsg_Watch)
		return same
	}
	return false
}
