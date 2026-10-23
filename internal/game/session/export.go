package session

import (
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// FullState 返回实体当前的完整同步状态（每个字段都设置），给测试和压测用：
// 把客户端按增量合并出来的状态和它比较，就能发现漏标脏标记造成的不同步。
func FullState(entity *core.Entity) *pb.EntityState { return entityDelta(entity, core.DirtyAll) }
