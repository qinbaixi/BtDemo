package session

import (
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 视野进出。谁能看到谁只由格子决定（两者格子相邻），不另外记录每个玩家看得到谁。
// aoi.Grid 在实体出现、消失、换格子时调用 Shown / Hidden（System 实现 aoi.Watcher），
// 这正是“看得见”和“看不见”切换的时刻，在这里发 Enter / Leave。
// 能看到是相互的，所以一次通知同时决定两边：
//   - cells 里的玩家看到 / 看不到 entity；
//   - entity 自己是玩家时，它看到 / 看不到 cells 里的所有实体。
// 平时的状态和事件广播直接问格子要九宫格里的玩家（outbox.go 的 Broadcast），和这里无关。

// Shown 实现 aoi.Watcher：entity 出现在 cells 里的玩家视野中。
func (sys *System) Shown(entity *core.Entity, cells []int) {
	sys.grid.PlayersIn(cells, func(player *core.Entity) {
		if session := sys.byPlayer[player.ID]; session != nil && player != entity {
			sys.enter(session, []*core.Entity{entity})
		}
	})
	if session := sys.byPlayer[entity.ID]; session != nil {
		var seen []*core.Entity
		sys.grid.EachIn(cells, func(other *core.Entity) {
			if other != entity { // 自己一直在自己的视野里，进游戏时由 showAround 发过
				seen = append(seen, other)
			}
		})
		sys.enter(session, seen)
	}
}

// Hidden 实现 aoi.Watcher：entity 从 cells 里的玩家视野中消失。
func (sys *System) Hidden(entity *core.Entity, cells []int) {
	sys.grid.PlayersIn(cells, func(player *core.Entity) {
		if session := sys.byPlayer[player.ID]; session != nil && player != entity {
			sys.leave(session, []int{entity.ID})
		}
	})
	if session := sys.byPlayer[entity.ID]; session != nil {
		var gone []int
		sys.grid.EachIn(cells, func(other *core.Entity) {
			if other != entity {
				gone = append(gone, other.ID)
			}
		})
		sys.leave(session, gone)
	}
}

// showAround 把玩家周围九宫格里的全部实体（含自己）发给它（刚加入、重连发全量时）。
func (sys *System) showAround(session *Session) {
	player := session.Player
	var seen []*core.Entity
	sys.grid.Neighbors(sys.grid.CellOf(player.X, player.Y), func(other *core.Entity) {
		seen = append(seen, other)
	})
	sys.enter(session, seen)
}

// reshow 给能看到 entity 的玩家重发它的 Enter（换了职业、皮肤或武器；客户端收到已有实体的 Enter 时更新外观）。
func (sys *System) reshow(entity *core.Entity) {
	sys.grid.PlayersAround(entity.X, entity.Y, func(player *core.Entity) {
		if session := sys.byPlayer[player.ID]; session != nil {
			sys.enter(session, []*core.Entity{entity})
		}
	})
}

// enter 给 session 发这些实体的 Enter。
func (sys *System) enter(session *Session, entities []*core.Entity) {
	if len(entities) == 0 {
		return
	}
	enter := &pb.Enter{}
	for _, entity := range entities {
		enter.Ents = append(enter.Ents, entityInfo(entity))
	}
	sys.SendTo(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Enter{Enter: enter}})
}

// leave 给 session 发这些实体的 Leave。
func (sys *System) leave(session *Session, ids []int) {
	if len(ids) == 0 {
		return
	}
	leave := &pb.Leave{}
	for _, id := range ids {
		leave.Ids = append(leave.Ids, int32(id))
	}
	sys.SendTo(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Leave{Leave: leave}})
}
