// Package session 把玩家连接到世界：将客户端消息转换为动作，
// 并在每次同步时向每个玩家发送 AOI 变化、
// 其所见实体的状态、附近的事件以及其自身属性。
package session

import (
	"log"
	"math"
	"slices"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
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
	defSent string      // 已经给本会话发过结构的行为树名；换了观察对象或树时重发
	visible map[int]bool
	// zonesSent 是已经发给本会话的回血区版本（core.Zones.Version）
	zonesSent int
}

// Visible 报告玩家当前是否看到实体 id（供测试使用）。
func (session *Session) Visible(id int) bool { return session.visible[id] }

// System 保存已连接的会话。
type System struct {
	state    *core.State
	grid     *aoi.Grid
	combat   *combat.System
	aiSys    *ai.System
	spawn    *spawn.System
	nav      *nav.Map
	sessions map[*Session]bool

	obstacles []*pb.Obstacle // 构建一次，并在每条欢迎消息中发送
}

// New 创建会话系统。
func New(
	state *core.State,
	grid *aoi.Grid,
	navMap *nav.Map,
	combatSys *combat.System,
	aiSys *ai.System,
	spawnSys *spawn.System,
) *System {
	sys := &System{
		state:    state,
		grid:     grid,
		nav:      navMap,
		combat:   combatSys,
		aiSys:    aiSys,
		spawn:    spawnSys,
		sessions: map[*Session]bool{},
	}
	sys.obstacles = obstacles(navMap)
	return sys
}

// Join 为一个连接创建新角色，并向其发送欢迎消息。
func (sys *System) Join() *Session {
	session := &Session{
		Player:    sys.spawn.Player(),
		Out:       make(chan []byte, 64),
		visible:   map[int]bool{},
		zonesSent: -1,
	}
	sys.sessions[session] = true
	cfg := sys.state.Cfg.World
	welcome := &pb.Welcome{
		Id:        core.I32(session.Player.ID),
		MapW:      core.F32(cfg.Map.Width),
		MapH:      core.F32(cfg.Map.Height),
		AoiCell:   core.F32(sys.grid.Cell),
		Obstacles: sys.obstacles,
	}
	welcome.Skills = skillBar(session.Player.Skills)
	for _, id := range cfg.Player.SkillPool {
		welcome.Pool = append(welcome.Pool, skillInfo(0, sys.state.Cfg.Skills[id]))
	}
	welcome.Pick = core.I32(cfg.Player.Pick())
	session.Player.CanPick = true // 刚进游戏，放第一个技能之前可以挑技能
	sys.send(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Welcome{Welcome: welcome}})
	return session
}

// 挑技能被拒绝的原因（以提示消息发给玩家）。
const (
	reasonCannotPick = "只能在刚进游戏或死亡时更换技能"
	reasonBadPick    = "技能选择无效"
)

// loadout 换上玩家挑的技能：第 1 格普攻不变，ids 依次放到第 2 格起。
// 只能从技能池里挑、不能重复、数量要正好；不满足时返回给玩家看的原因。
func (sys *System) loadout(entity *core.Entity, ids []string) string {
	player := sys.state.Cfg.World.Player
	if !entity.CanPick {
		return reasonCannotPick
	}
	if len(ids) != player.Pick() {
		return reasonBadPick
	}
	skills := []*config.Skill{entity.Skills[0]}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] || !slices.Contains(player.SkillPool, id) {
			return reasonBadPick
		}
		seen[id] = true
		skills = append(skills, sys.state.Cfg.Skills[id])
	}
	entity.Skills = skills
	return ""
}

// Leave 移除会话的角色并关闭其输出。
func (sys *System) Leave(session *Session) {
	if !sys.sessions[session] {
		return
	}
	delete(sys.sessions, session)
	sys.spawn.Remove(session.Player)
	close(session.Out)
}

// Input 应用一条客户端消息。
func (sys *System) Input(session *Session, msg *pb.ClientMsg) {
	entity := session.Player
	switch body := msg.Msg.(type) {
	case *pb.ClientMsg_Move:
		dx, dy := float64(body.Move.GetDx()), float64(body.Move.GetDy())
		length := math.Hypot(dx, dy)
		if length > 0 && !math.IsNaN(length) && !math.IsInf(length, 0) {
			entity.MoveX, entity.MoveY = dx/length, dy/length
		} else {
			entity.MoveX, entity.MoveY = 0, 0
		}
	case *pb.ClientMsg_Block:
		entity.Blocking = body.Block.GetOn()
	case *pb.ClientMsg_Target:
		entity.Target = int(body.Target.GetId())
	case *pb.ClientMsg_Watch:
		session.Watch = int(body.Watch.GetId())
		session.defSent = ""
	case *pb.ClientMsg_Loadout:
		if reason := sys.loadout(entity, body.Loadout.GetSkills()); reason != "" {
			toast := &pb.Toast{Text: proto.String(reason)}
			sys.send(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Toast{Toast: toast}})
			return
		}
		bar := &pb.SkillBar{Skills: skillBar(entity.Skills)}
		sys.send(session, &pb.ServerMsg{Msg: &pb.ServerMsg_SkillBar{SkillBar: bar}})
	case *pb.ClientMsg_Cast:
		slot := int(body.Cast.GetSlot())
		if slot < 1 || slot > len(entity.Skills) {
			return
		}
		skill := entity.Skills[slot-1]
		target := int(body.Cast.GetTarget())
		if target == 0 {
			target = entity.Target
		}
		targetEnt := sys.state.Ents.Get(target)
		unusable := !targetEnt.Alive() ||
			!sys.state.Hostile(entity, targetEnt) ||
			core.EdgeDist(entity, targetEnt) > skill.Range
		if skill.Kind == "target" && unusable {
			// 未选择可用目标：选取范围内最近的怪物。
			targetEnt = sys.combat.NearestMonster(entity, skill.Range+entity.Radius+40)
			if targetEnt != nil {
				target, entity.Target = targetEnt.ID, targetEnt.ID
			}
		}
		aimX, aimY := float64(body.Cast.GetDx()), float64(body.Cast.GetDy())
		if err := sys.combat.CastAimed(entity, skill, target, aimX, aimY); err != nil {
			toast := &pb.Toast{Text: proto.String(err.Error())}
			sys.send(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Toast{Toast: toast}})
		}
	}
}

// Watched 返回某些会话想要查看行为树跟踪的实体。
func (sys *System) Watched() map[int]bool {
	var ids map[int]bool
	for session := range sys.sessions {
		if session.Watch != 0 {
			if ids == nil {
				ids = map[int]bool{}
			}
			ids[session.Watch] = true
		}
	}
	return ids
}

func (sys *System) send(session *Session, msg *pb.ServerMsg) {
	if !sys.sessions[session] {
		return
	}
	data, err := proto.Marshal(msg)
	if err != nil {
		log.Printf("marshal: %v", err)
		return
	}
	select {
	case session.Out <- data:
	default:
		// 客户端落后了。丢弃一帧会使其 AOI
		// 状态不同步，因此改为断开连接；客户端会以新的视野重新连接。
		log.Printf("player %d: send buffer full, disconnecting", session.Player.ID)
		sys.Leave(session)
	}
}

// Flush 向每个会话发送 AOI 的进入/离开、可见实体的状态、排队中的事件
// 以及玩家自身属性，然后清空事件队列。
func (sys *System) Flush() {
	events := sys.state.Events.List()
	cells := make([]int, len(events))
	for i, pending := range events {
		cells[i] = sys.grid.CellOf(pending.X, pending.Y)
	}
	for session := range sys.sessions {
		player := session.Player
		cell := sys.grid.CellOf(player.X, player.Y)
		now := map[int]*core.Entity{}
		sys.grid.Neighbors(cell, func(entity *core.Entity) { now[entity.ID] = entity })
		enter := &pb.Enter{}
		leave := &pb.Leave{}
		for id, entity := range now {
			if !session.visible[id] {
				enter.Ents = append(enter.Ents, entityInfo(entity))
			}
		}
		for id := range session.visible {
			if now[id] == nil {
				leave.Ids = append(leave.Ids, int32(id))
			}
		}
		session.visible = map[int]bool{}
		for id := range now {
			session.visible[id] = true
		}
		if len(leave.Ids) > 0 {
			sys.send(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Leave{Leave: leave}})
		}
		if len(enter.Ents) > 0 {
			sys.send(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Enter{Enter: enter}})
		}

		sync := &pb.Sync{
			Time: core.F32(core.Round1(sys.state.Now())),
			Self: selfInfo(player, sys.state.Now()),
		}
		for _, entity := range now {
			sync.Ents = append(sync.Ents, entityState(entity))
		}
		for i, pending := range events {
			if sys.grid.Sees(cell, cells[i]) {
				sync.Ev = append(sync.Ev, pending.Event)
			}
		}
		if version := sys.state.Zones.Version; session.zonesSent != version {
			sync.Zones, sync.ZonesSet = zoneInfos(sys.state.Zones.List()), proto.Bool(true)
			session.zonesSent = version
		}
		if session.Watch != 0 && now[session.Watch] != nil {
			sync.Ai = sys.aiSys.Trace(now[session.Watch], session.defSent)
			if def := sync.Ai.GetDef(); def != nil {
				session.defSent = sync.Ai.GetTree()
			}
		}
		sys.send(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Sync{Sync: sync}})
	}
	sys.state.Events.Clear()
	sys.aiSys.ClearTraces()
}
