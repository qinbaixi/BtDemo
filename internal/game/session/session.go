// Package session 把玩家连接到世界：把客户端消息转换为动作，把世界里的变化推给附近的玩家。
//
// 推送都按 AOI 走（aoi.Grid 只遍历九宫格里的玩家）：
//   - 视野进出（view.go）：实体出现、消失、换格子时 Grid 通知 Shown / Hidden，只给相关格子里的玩家发 Enter / Leave。
//   - 实体状态：各系统改字段时记下脏标记（core.Dirty），每个同步帧只把变了的字段按实体位置广播。
//   - 事件：按事件发生的位置广播。
//   - 自身属性、背包、宠物状态：只发给自己，只在变了时发。
//
// 发送（outbox.go）：Broadcast / SendTo 放进玩家这一帧的待发列表，每个同步帧合成一个 Frame 写出；
// BroadcastNow / SendNow 立即写出（玩家操作的回应、Welcome）。
// 连接（connect.go）：断线保留角色，带 token 重连时把全部东西重新发一遍。
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
	"github.com/qinbaixi/BtDemo/internal/game/item"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/game/pet"
	"github.com/qinbaixi/BtDemo/internal/game/spawn"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// Session 是一个玩家（角色）。它比连接活得长：断线后角色保留 world.yaml session.keep 秒，
// 客户端带着 token 重连就换上新的 Link 接着用，见 connect.go。
type Session struct {
	Player  *core.Entity
	Inbox   *Inbox // 网络读协程放进来的客户端消息，世界 goroutine 每个 tick 开头处理
	Watch   int    // 本会话想要查看其行为树跟踪的实体
	defSent string // 已经给本会话发过结构的行为树名；换了观察对象或树时重发
	// zonesSent 是已经发给本会话的回血区版本（core.Zones.Version）
	zonesSent int
	// selfSent 是上次发出的完整自身信息，用来算这次变了什么；nil 表示下次发全部
	selfSent *pb.SelfInfo

	token      string          // 重连时认出这个角色用，在 Welcome 里发给客户端
	link       *Link           // 当前连接的发送队列；断线期间为 nil
	detachedAt float64         // 断线的时刻（游戏时间），link 为 nil 时有效
	pending    []*pb.ServerMsg // 这一帧待发的消息，同步帧结束时合成一个 Frame
	resync     bool            // 客户端跟不上了：下次 Flush 前先发一份全量
	lag        lagMeter
}

// Token 是重连时认出这个角色的凭证（Welcome.token）。
func (session *Session) Token() string { return session.token }

// Link 返回会话当前连接的发送队列（断线时为 nil）。
func (session *Session) Link() *Link { return session.link }

// System 保存所有会话。
type System struct {
	state    *core.State
	grid     *aoi.Grid
	combat   *combat.System
	aiSys    *ai.System
	spawn    *spawn.System
	items    *item.System
	pets     *pet.System
	nav      *nav.Map
	host     Host // 所在的场景；nil 表示单场景（测试）
	sessions map[*Session]bool
	byToken  map[string]*Session
	byPlayer map[int]*Session // 玩家实体 ID -> 会话，广播时由格子里的玩家找到会话

	obstacles []*pb.Obstacle // 构建一次，并在每条欢迎消息中发送
	itemInfos []*pb.ItemInfo // 装备图鉴，构建一次，并在每条欢迎消息中发送
	petInfos  []*pb.PetInfo  // 宠物图鉴，构建一次，并在每条欢迎消息中发送
}

// New 创建会话系统，并让它接收 grid 的视野变化。
func New(
	state *core.State,
	grid *aoi.Grid,
	navMap *nav.Map,
	combatSys *combat.System,
	aiSys *ai.System,
	spawnSys *spawn.System,
	itemSys *item.System,
	petSys *pet.System,
) *System {
	sys := &System{
		state:    state,
		grid:     grid,
		nav:      navMap,
		combat:   combatSys,
		aiSys:    aiSys,
		spawn:    spawnSys,
		items:    itemSys,
		pets:     petSys,
		sessions: map[*Session]bool{},
		byToken:  map[string]*Session{},
		byPlayer: map[int]*Session{},
	}
	sys.obstacles = obstacles(navMap)
	sys.itemInfos = itemInfos(state.Cfg.Items)
	sys.petInfos = petInfos(state.Cfg.Pets)
	grid.SetWatcher(sys)
	return sys
}

// Join 为连接 link 创建新角色：发欢迎消息，再把周围的实体、新手装备、宠物发给它。
func (sys *System) Join(link *Link) *Session {
	player := sys.spawn.Player() // 加入网格时，周围的玩家就收到了它的 Enter
	session := &Session{
		Player:    player,
		Inbox:     &Inbox{},
		zonesSent: -1,
		token:     newToken(),
		link:      link,
	}
	sys.sessions[session] = true
	sys.byToken[session.token] = session
	sys.byPlayer[player.ID] = session
	player.CanPick = true // 刚进游戏，放第一个技能之前可以挑技能
	sys.SendNow(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Welcome{Welcome: sys.welcome(session)}})
	sys.showAround(session)
	sys.items.GiveStarter(player)
	sys.pets.Join(player)
	sys.publishGear(false)
	sys.flushFrame(session) // 周围的实体、背包、宠物马上发出去，不等同步帧
	return session
}

// welcome 是发给会话的欢迎消息：角色 id、地图、技能、职业、图鉴，以及重连用的 token。
func (sys *System) welcome(session *Session) *pb.Welcome {
	cfg := sys.state.Cfg.World
	welcome := &pb.Welcome{
		Id:        core.I32(session.Player.ID),
		MapW:      core.F32(cfg.Map.Width),
		MapH:      core.F32(cfg.Map.Height),
		AoiCell:   core.F32(sys.grid.Cell),
		Obstacles: sys.obstacles,
		Items:     sys.itemInfos,
		Pets:      sys.petInfos,
	}
	class := cfg.Player.Class(session.Player.Class)
	welcome.Skills = skillBar(session.Player.Skills)
	welcome.Pool = skillPool(sys.state.Cfg, class)
	welcome.Pick = core.I32(class.Pick())
	welcome.Class = proto.String(class.ID)
	for _, option := range cfg.Player.Classes {
		welcome.Classes = append(welcome.Classes, classInfo(sys.state.Cfg, option))
	}
	welcome.Token = proto.String(session.token)
	if sys.host != nil {
		welcome.Scene = sys.host.SceneInfo()
	}
	return welcome
}

// 挑技能被拒绝的原因（以提示消息发给玩家）。
const (
	reasonCannotPick = "只能在刚进游戏或死亡时更换技能"
	reasonBadPick    = "技能选择无效"
	reasonBadClass   = "职业无效"
)

// loadout 换上玩家挑的职业和技能：classID 为空表示不换职业；换职业时先换成新职业
// （外观、属性、技能栏都按新职业），再把 ids 依次放到第 2 格起，第 1 格是职业的普攻。
// 只能从职业的技能池里挑、不能重复、数量要正好；不满足时返回给玩家看的原因，什么都不改。
func (sys *System) loadout(entity *core.Entity, classID string, ids []string) string {
	if !entity.CanPick {
		return reasonCannotPick
	}
	player := sys.state.Cfg.World.Player
	if classID == "" {
		classID = entity.Class
	}
	class := player.Class(classID)
	if class == nil {
		return reasonBadClass
	}
	if len(ids) != class.Pick() {
		return reasonBadPick
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] || !slices.Contains(class.SkillPool, id) {
			return reasonBadPick
		}
		seen[id] = true
	}
	if class.ID != entity.Class {
		sys.spawn.ApplyClass(entity, class)
		sys.items.ClassChanged(entity, class)
		sys.reshow(entity)
	}
	skills := []*config.Skill{entity.Skills[0]}
	for _, id := range ids {
		skills = append(skills, sys.state.Cfg.Skills[id])
	}
	entity.Skills = skills
	return ""
}

// Leave 删除会话的角色，并关闭它的连接（如果还连着）。
func (sys *System) Leave(session *Session) {
	if !sys.sessions[session] {
		return
	}
	delete(sys.sessions, session)
	delete(sys.byToken, session.token)
	delete(sys.byPlayer, session.Player.ID)
	sys.pets.Dismiss(session.Player)
	sys.spawn.Remove(session.Player) // 移出网格时，周围的玩家收到 Leave
	if session.link != nil {
		session.link.Close()
		session.link = nil
	}
	if sys.host != nil {
		sys.host.Gone(session)
	}
}

// DrainInputs 按到达顺序处理每个会话排队的客户端消息。须在世界 goroutine 上、
// 每个 tick 的系统运行之前调用，这样输入总在固定的时机生效。
// 输入队列溢出过的会话直接删除（客户端异常或刷包），不影响其他人。
func (sys *System) DrainInputs() {
	for session := range sys.sessions {
		messages, overflow := session.Inbox.Take()
		if session.link == nil {
			continue // 断线前没来得及处理的输入作废：断线的角色原地站着（见 detach）
		}
		if overflow {
			log.Printf("player %d: input queue overflow, disconnecting", session.Player.ID)
			sys.Leave(session)
			continue
		}
		for _, msg := range messages {
			sys.Input(session, msg)
			if !sys.sessions[session] {
				break // 处理消息时会话被删掉了
			}
		}
	}
}

// CloseAll 删除所有会话（停服时调用）：关闭发送队列，写协程写完剩下的帧后发关闭帧。
func (sys *System) CloseAll() {
	for session := range sys.sessions {
		sys.flushFrame(session)
		sys.Leave(session)
	}
}

// publishGear 把物品和宠物系统留下的变化发出去：每个玩家的提示（Toast）、变了的背包（Inventory）、
// 宠物状态（PetStatus），外观（皮肤、武器）变了的玩家给周围重发 Enter。
// urgent 为 true（处理完客户端消息后）时立即发出，让操作马上有回应；
// 同步帧里调用时随这一帧的包发出（例如战斗里的掉落）。
func (sys *System) publishGear(urgent bool) {
	for session := range sys.sessions {
		player := session.Player
		var messages []*pb.ServerMsg
		for _, text := range player.Notices {
			messages = append(messages, toastMsg(text))
		}
		player.Notices = nil
		if player.InventoryDirty {
			player.InventoryDirty = false
			inventory := inventoryInfo(player, sys.items.Capacity())
			messages = append(messages, &pb.ServerMsg{Msg: &pb.ServerMsg_Inventory{Inventory: inventory}})
		}
		if player.PetDirty {
			player.PetDirty = false
			status := petStatus(sys.state, player)
			messages = append(messages, &pb.ServerMsg{Msg: &pb.ServerMsg_PetStatus{PetStatus: status}})
		}
		if player.LookDirty {
			player.LookDirty = false
			sys.reshow(player)
		}
		for _, msg := range messages {
			sys.SendTo(session, msg)
		}
		if urgent && len(messages) > 0 {
			sys.flushFrame(session)
		}
	}
}

// toastMsg 是一行提示。
func toastMsg(text string) *pb.ServerMsg {
	return &pb.ServerMsg{Msg: &pb.ServerMsg_Toast{Toast: &pb.Toast{Text: proto.String(text)}}}
}

// toast 立即给会话发一行提示（回应玩家的操作）。
func (sys *System) toast(session *Session, text string) {
	sys.SendNow(session, toastMsg(text))
}

// Input 应用一条客户端消息。
func (sys *System) Input(session *Session, msg *pb.ClientMsg) {
	defer sys.publishGear(true)
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
		// 不能格挡的职业（游侠）忽略格挡消息；松开总是允许的
		if on := body.Block.GetOn(); !on || sys.canBlock(entity) {
			entity.SetBlocking(on)
		}
	case *pb.ClientMsg_Target:
		entity.SetTarget(int(body.Target.GetId()))
	case *pb.ClientMsg_Watch:
		session.Watch = int(body.Watch.GetId())
		session.defSent = ""
	case *pb.ClientMsg_Loadout:
		reason := sys.loadout(entity, body.Loadout.GetClass(), body.Loadout.GetSkills())
		if reason != "" {
			sys.toast(session, reason)
			return
		}
		bar := &pb.SkillBar{Skills: skillBar(entity.Skills), Class: proto.String(entity.Class)}
		sys.SendNow(session, &pb.ServerMsg{Msg: &pb.ServerMsg_SkillBar{SkillBar: bar}})
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
				target = targetEnt.ID
				entity.SetTarget(targetEnt.ID)
			}
		}
		aimX, aimY := float64(body.Cast.GetDx()), float64(body.Cast.GetDy())
		if err := sys.combat.CastAimed(entity, skill, target, aimX, aimY); err != nil {
			sys.toast(session, err.Error())
			// 客户端按下技能时先在本地转上了冷却；被拒绝时下一帧重发完整的自身信息把它纠正回来
			session.selfSent = nil
		}
	case *pb.ClientMsg_Equip:
		if reason := sys.items.Equip(entity, int(body.Equip.GetUid())); reason != "" {
			sys.toast(session, reason)
		}
	case *pb.ClientMsg_Unequip:
		if reason := sys.items.Unequip(entity, body.Unequip.GetSlot()); reason != "" {
			sys.toast(session, reason)
		}
	case *pb.ClientMsg_Pet:
		if reason := sys.pets.Set(entity, body.Pet.GetPet()); reason != "" {
			sys.toast(session, reason)
		}
	case *pb.ClientMsg_Skin:
		if reason := sys.items.SetSkin(entity, body.Skin.GetSkin()); reason != "" {
			sys.toast(session, reason)
		}
	case *pb.ClientMsg_Lines:
		if sys.host == nil {
			return
		}
		if lines := sys.host.Lines(session); lines != nil {
			sys.SendNow(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Lines{Lines: lines}})
		}
	case *pb.ClientMsg_SwitchLine:
		reason := reasonNoLines
		if sys.host != nil {
			reason = sys.host.SwitchLine(session, int(body.SwitchLine.GetLine()))
		}
		if reason != "" {
			sys.toast(session, reason)
		}
	}
}

// canBlock 报告 entity 的职业能不能格挡。
func (sys *System) canBlock(entity *core.Entity) bool {
	class := sys.state.Cfg.World.Player.Class(entity.Class)
	return class != nil && class.CanBlock
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

// Flush 是同步帧的结尾：先给跟不上的会话发全量，再把这一帧攒下的变化推出去——
// 变了的实体字段（按实体位置广播）、事件（按发生位置广播）、每个玩家自己的属性、回血区、
// 行为树跟踪——最后把每个会话的待发消息合成一个 Frame 写出。
func (sys *System) Flush() {
	for session := range sys.sessions {
		if session.resync {
			sys.sendFull(session)
		}
	}
	sys.publishGear(false)
	sys.state.Ents.Each(func(entity *core.Entity) {
		if entity.Dirty == 0 {
			return
		}
		if entity.Dirty&core.DirtyPos != 0 {
			sys.grid.Moved(entity) // 保险：位置变了而调用方忘了更新格子时，先把视野进出补上
		}
		delta := entityDelta(entity, entity.Dirty)
		entity.Dirty = 0
		sys.Broadcast(entity.X, entity.Y, &pb.ServerMsg{Msg: &pb.ServerMsg_State{State: delta}})
	})
	for _, pending := range sys.state.Events.List() {
		sys.Broadcast(pending.X, pending.Y, &pb.ServerMsg{Msg: &pb.ServerMsg_Event{Event: pending.Event}})
	}
	sys.state.Events.Clear()
	now := sys.state.Now()
	for session := range sys.sessions {
		current := selfInfo(session.Player, now)
		if delta := selfDelta(session.selfSent, current); delta != nil {
			sys.SendTo(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Self{Self: delta}})
		}
		session.selfSent = current
		if version := sys.state.Zones.Version; session.zonesSent != version {
			zones := &pb.ZoneList{Zones: zoneInfos(sys.state.Zones.List())}
			sys.SendTo(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Zones{Zones: zones}})
			session.zonesSent = version
		}
		if watched := sys.state.Ents.Get(session.Watch); watched != nil && sys.grid.CanSee(session.Player, watched) {
			trace := sys.aiSys.Trace(watched, session.defSent)
			if trace.GetDef() != nil {
				session.defSent = trace.GetTree()
			}
			sys.SendTo(session, &pb.ServerMsg{Msg: &pb.ServerMsg_Ai{Ai: trace}})
		}
	}
	sys.aiSys.ClearTraces()
	for session := range sys.sessions {
		sys.flushFrame(session)
	}
}
