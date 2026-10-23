package session

import (
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 视野进出。aoi.Grid 在实体出现、消失、换格子时调用 Shown / Hidden（System 实现 aoi.Watcher）。
// “玩家 P 能看到实体 E” 等价于 “两者的格子相邻”，所以一次通知同时决定两边：
//   - cells 里的玩家看到 / 看不到 entity；
//   - entity 自己是玩家时，它看到 / 看不到 cells 里的所有实体。

// Shown 实现 aoi.Watcher：entity 出现在 cells 里的玩家视野中。
func (sys *System) Shown(entity *core.Entity, cells []int) {
	sys.grid.PlayersIn(cells, func(player *core.Entity) {
		if session := sys.byPlayer[player.ID]; session != nil && player != entity {
			sys.enter(session, []*core.Entity{entity})
		}
	})
	if session := sys.byPlayer[entity.ID]; session != nil {
		var seen []*core.Entity
		sys.grid.EachIn(cells, func(other *core.Entity) { seen = append(seen, other) })
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
		sys.grid.EachIn(cells, func(other *core.Entity) { gone = append(gone, other.ID) })
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
			delete(session.visible, entity.ID)
			sys.enter(session, []*core.Entity{entity})
		}
	})
}

// enter 给 session 发这些实体的 Enter（已经发过的跳过）。
func (sys *System) enter(session *Session, entities []*core.Entity) {
	enter := &pb.Enter{}
	for _, entity := range entities {
		if !session.visible[entity.ID] {
			session.visible[entity.ID] = true
			enter.Ents = append(enter.Ents, entityInfo(entity))
		}
	}
	if len(enter.Ents) > 0 {
		sys.SendTo(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Enter{Enter: enter}})
	}
}

// leave 给 session 发这些实体的 Leave（没发过 Enter 的跳过）。
func (sys *System) leave(session *Session, ids []int) {
	leave := &pb.Leave{}
	for _, id := range ids {
		if session.visible[id] {
			delete(session.visible, id)
			leave.Ids = append(leave.Ids, int32(id))
		}
	}
	if len(leave.Ids) > 0 {
		sys.SendTo(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Leave{Leave: leave}})
	}
}
