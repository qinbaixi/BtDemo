// Package session 把玩家连接到世界：将客户端消息转换为动作，
// 并在每次同步时向每个玩家发送 AOI 变化、
// 其所见实体的状态、附近的事件以及其自身属性。
package session

import (
	"log"
	"math"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/game/ai"
	"github.com/qinbaixi/BtDemo/internal/game/aoi"
	"github.com/qinbaixi/BtDemo/internal/game/combat"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/game/spawn"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// Session 是一个已连接的玩家。
type Session struct {
	Player  *core.Entity
	Out     chan []byte // 编码后的 pb.ServerMsg 帧
	Watch   int         // 本会话想要查看其行为树跟踪的实体
	visible map[int]bool
}

// Visible 报告玩家当前是否看到实体 id（供测试使用）。
func (s *Session) Visible(id int) bool { return s.visible[id] }

// System 保存已连接的会话。
type System struct {
	s        *core.State
	grid     *aoi.Grid
	combat   *combat.System
	ai       *ai.System
	spawn    *spawn.System
	nav      *nav.Map
	sessions map[*Session]bool

	obstacles []*pb.Obstacle // 构建一次，并在每条欢迎消息中发送
}

// New 创建会话系统。
func New(s *core.State, grid *aoi.Grid, m *nav.Map, cb *combat.System, a *ai.System, sp *spawn.System) *System {
	n := &System{s: s, grid: grid, nav: m, combat: cb, ai: a, spawn: sp, sessions: map[*Session]bool{}}
	n.obstacles = obstacles(m)
	return n
}

// Join 为一个连接创建新角色，并向其发送欢迎消息。
func (n *System) Join() *Session {
	s := &Session{Player: n.spawn.Player(), Out: make(chan []byte, 64), visible: map[int]bool{}}
	n.sessions[s] = true
	cfg := n.s.Cfg.World
	welcome := &pb.Welcome{
		Id:        core.I32(s.Player.ID),
		MapW:      core.F32(cfg.Map.Width),
		MapH:      core.F32(cfg.Map.Height),
		AoiCell:   core.F32(n.grid.Cell),
		Obstacles: n.obstacles,
	}
	for i, sk := range s.Player.Skills {
		welcome.Skills = append(welcome.Skills, &pb.SkillInfo{
			Slot: core.I32(i + 1), Id: proto.String(sk.ID), Name: proto.String(sk.Name), Kind: proto.String(sk.Kind),
			Range: core.F32(sk.Range), Radius: core.F32(sk.Radius), Cooldown: core.F32(sk.Cooldown),
			Color: proto.String(sk.Color), Fx: proto.String(sk.FX),
		})
	}
	n.send(s, &pb.ServerMsg{Msg: &pb.ServerMsg_Welcome{Welcome: welcome}})
	return s
}

// Leave 移除会话的角色并关闭其输出。
func (n *System) Leave(s *Session) {
	if !n.sessions[s] {
		return
	}
	delete(n.sessions, s)
	n.spawn.Remove(s.Player)
	close(s.Out)
}

// Input 应用一条客户端消息。
func (n *System) Input(s *Session, msg *pb.ClientMsg) {
	e := s.Player
	switch m := msg.Msg.(type) {
	case *pb.ClientMsg_Move:
		dx, dy := float64(m.Move.GetDx()), float64(m.Move.GetDy())
		if d := math.Hypot(dx, dy); d > 0 && !math.IsNaN(d) && !math.IsInf(d, 0) {
			e.MoveX, e.MoveY = dx/d, dy/d
		} else {
			e.MoveX, e.MoveY = 0, 0
		}
	case *pb.ClientMsg_Target:
		e.Target = int(m.Target.GetId())
	case *pb.ClientMsg_Watch:
		s.Watch = int(m.Watch.GetId())
	case *pb.ClientMsg_Cast:
		slot := int(m.Cast.GetSlot())
		if slot < 1 || slot > len(e.Skills) {
			return
		}
		sk := e.Skills[slot-1]
		target := int(m.Cast.GetTarget())
		if target == 0 {
			target = e.Target
		}
		if t := n.s.Ents.Get(target); sk.Kind == "target" && (!t.Alive() || !n.s.Hostile(e, t) || core.EdgeDist(e, t) > sk.Range) {
			// 未选择可用目标：选取范围内最近的怪物。
			if t = n.combat.NearestMonster(e, sk.Range+e.Radius+40); t != nil {
				target, e.Target = t.ID, t.ID
			}
		}
		if err := n.combat.Cast(e, sk, target); err != nil {
			n.send(s, &pb.ServerMsg{Msg: &pb.ServerMsg_Toast{Toast: &pb.Toast{Text: proto.String(err.Error())}}})
		}
	}
}

// Watched 返回某些会话想要查看行为树跟踪的实体。
func (n *System) Watched() map[int]bool {
	var ids map[int]bool
	for s := range n.sessions {
		if s.Watch != 0 {
			if ids == nil {
				ids = map[int]bool{}
			}
			ids[s.Watch] = true
		}
	}
	return ids
}

func (n *System) send(s *Session, msg *pb.ServerMsg) {
	if !n.sessions[s] {
		return
	}
	data, err := proto.Marshal(msg)
	if err != nil {
		log.Printf("marshal: %v", err)
		return
	}
	select {
	case s.Out <- data:
	default:
		// 客户端落后了。丢弃一帧会使其 AOI
		// 状态不同步，因此改为断开连接；客户端会以新的视野重新连接。
		log.Printf("player %d: send buffer full, disconnecting", s.Player.ID)
		n.Leave(s)
	}
}

// Flush 向每个会话发送 AOI 的进入/离开、可见实体的状态、排队中的事件
// 以及玩家自身属性，然后清空事件队列。
func (n *System) Flush() {
	events := n.s.Events.List()
	cells := make([]int, len(events))
	for i, pe := range events {
		cells[i] = n.grid.CellOf(pe.X, pe.Y)
	}
	for s := range n.sessions {
		p := s.Player
		pc := n.grid.CellOf(p.X, p.Y)
		now := map[int]*core.Entity{}
		n.grid.Neighbors(pc, func(e *core.Entity) { now[e.ID] = e })
		enter := &pb.Enter{}
		leave := &pb.Leave{}
		for id, e := range now {
			if !s.visible[id] {
				enter.Ents = append(enter.Ents, entityInfo(e))
			}
		}
		for id := range s.visible {
			if now[id] == nil {
				leave.Ids = append(leave.Ids, int32(id))
			}
		}
		s.visible = map[int]bool{}
		for id := range now {
			s.visible[id] = true
		}
		if len(leave.Ids) > 0 {
			n.send(s, &pb.ServerMsg{Msg: &pb.ServerMsg_Leave{Leave: leave}})
		}
		if len(enter.Ents) > 0 {
			n.send(s, &pb.ServerMsg{Msg: &pb.ServerMsg_Enter{Enter: enter}})
		}

		sync := &pb.Sync{Time: core.F32(core.Round1(n.s.Now())), Self: selfInfo(p, n.s.Now())}
		for _, e := range now {
			sync.Ents = append(sync.Ents, entityState(e))
		}
		for i, pe := range events {
			if n.grid.Sees(pc, cells[i]) {
				sync.Ev = append(sync.Ev, pe.Ev)
			}
		}
		if s.Watch != 0 && now[s.Watch] != nil {
			sync.Ai = n.ai.Trace(now[s.Watch])
		}
		n.send(s, &pb.ServerMsg{Msg: &pb.ServerMsg_Sync{Sync: sync}})
	}
	n.s.Events.Clear()
	n.ai.ClearTraces()
}
