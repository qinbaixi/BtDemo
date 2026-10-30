package game

import (
	"log"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/attr"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 换场景、换线（迁移）。
//
//	源场景（自己的 goroutine）                Manager（拿锁）            目标场景（自己的 goroutine）
//	1. 踩传送门 / 切线：检查活着、不在战斗中
//	2. 发 Travel（客户端显示过场）
//	3. 打包：清掉只属于这个场景的状态（Buff、目标、仇恨、路径……），冷却换成“还剩几秒”
//	4. TakeOut：收回宠物，角色移出场景
//	5. depart ─────────────────────────────▶ 选目标线，角色进入迁移途中
//	6. target.Do(arrive) ─────────────────────────────────────────────▶ 7. arrived：角色归目标场景
//	                                                                    8. 冷却按新时钟还原，放到落点
//	                                                                    9. Bring：重新发全部东西
//
// 角色实体对象本身跟着走（ID、等级、背包、装备、技能、血量都不变）；第 4 步之后源场景不再碰它，
// 第 7 步之前只有 Manager（拿着锁）会碰这个会话，所以两个 goroutine 不会同时动同一个角色。
// 宠物在源场景收回，到了目标场景由宠物系统重新召唤。

// combatCooldown 是最近一次挨打或出手之后多少毫秒内算“在战斗中”，这期间不能切线。
const combatCooldown config.Millis = 5000

// 不能迁移的原因（以提示消息发给玩家）。
const (
	reasonDead        = "死亡时不能换线"
	reasonInCombat    = "战斗中不能换线"
	reasonSameLine    = "你已经在这条线了"
	reasonSingleScene = "这里没有别的线"
	reasonDungeon     = "副本里不能换线"
)

// travelPack 是角色离开源场景时记下的、要按目标场景的时钟还原的东西。
type travelPack struct {
	cooldowns map[string]config.Millis // 技能 ID -> 还要冷却多少毫秒
	petSwapIn config.Millis            // 还要多少毫秒才能换宠物
	x, y      float64                  // 离开时的位置（换线时落在同一个位置）
}

// packPlayer 清掉角色身上只属于源场景的状态，记下要带走的计时。
// 切场景时 Buff 和减益全部清掉（和多数 MMO 一样）。
func packPlayer(player *core.Entity, now config.Millis) travelPack {
	// 前摇、击退和韧性是源场景里的事（击退路线还是源场景的坐标），不带过去
	player.Windup, player.Knock = nil, nil
	player.PoiseTaken, player.PoiseHitAt = 0, 0
	player.StunUntil = 0
	player.Guard = core.Guard{}
	pack := travelPack{
		cooldowns: map[string]config.Millis{},
		petSwapIn: max(0, player.PetSwapAt-now),
		x:         player.X,
		y:         player.Y,
	}
	for skillID, readyAt := range player.Cooldowns {
		if left := readyAt - now; left > 0 {
			pack.cooldowns[skillID] = left
		}
	}
	player.Buffs = nil
	attr.Recalc(player)
	player.Target, player.LastAttacker = 0, 0
	player.LastHitAt, player.LastDealtAt, player.AmbushUntil = 0, 0, 0
	player.Steering = core.Steering{}
	player.Control = core.Control{}
	player.AITicks = nil
	player.Checkpoint = nil // 存档点只在这个场景里算
	player.Dirty = 0        // 进入目标场景时周围的玩家收到完整的 Enter
	return pack
}

// unpackPlayer 按目标场景的时钟 now 还原冷却和换宠物的计时。
func unpackPlayer(player *core.Entity, pack travelPack, now config.Millis) {
	player.Cooldowns = map[string]config.Millis{}
	for skillID, left := range pack.cooldowns {
		player.Cooldowns[skillID] = now + left
	}
	player.PetSwapAt = 0
	if pack.petSwapIn > 0 {
		player.PetSwapAt = now + pack.petSwapIn
	}
}

// inCombat 报告 player 最近 combatCooldown 毫秒内有没有挨打或出手。
func inCombat(player *core.Entity, now config.Millis) bool {
	hitRecently := player.LastHitAt > 0 && now-player.LastHitAt < combatCooldown
	dealtRecently := player.LastDealtAt > 0 && now-player.LastDealtAt < combatCooldown
	return hitRecently || dealtRecently
}

// travel 把会话 client 送去场景模板 templateID 的第 wantLine 线（0 = 让 Manager 选）。
// 在源场景 goroutine 上调用，调用之后这个场景不再碰 client。
func (scene *Scene) travel(client *Session, templateID string, wantLine int) {
	template := scene.manager.cfg.Scenes.Scene(templateID)
	player := client.Player
	pack := packPlayer(player, scene.State.Now())
	scene.Sessions.SendTravel(client, template.Name)
	scene.Sessions.TakeOut(client)
	from := scene.Template.ID
	target := scene.manager.depart(client, templateID, wantLine)
	if target == nil {
		return // 正在停服：Manager 已经删掉角色、断开连接
	}
	accepted := target.Do(func() { target.arrive(client, player, pack, from) })
	if !accepted {
		scene.manager.lost(client)
	}
}

// arrive 在目标场景接收从场景模板 from 过来的角色。在目标场景 goroutine 上运行。
func (scene *Scene) arrive(client *Session, player *core.Entity, pack travelPack, from string) {
	scene.manager.arrived(client)
	x, y := pack.x, pack.y // 换线：落在原来的位置
	if from != scene.Template.ID {
		x, y = scene.Portals.Arrival(from, scene.State.Cfg.World.Player.Spawn)
	}
	unpackPlayer(player, pack, scene.State.Now())
	scene.Sessions.Bring(client, player, x, y)
	log.Printf(
		"player %d: entered %s line %d at (%.0f, %.0f)",
		player.ID,
		scene.Template.ID,
		scene.Line,
		player.X,
		player.Y,
	)
}

// eachPlayer 对场景里每个连着的玩家调用 fn（传送门检查用；断线的角色原地站着，不会被传走）。
func (scene *Scene) eachPlayer(fn func(*core.Entity)) {
	if scene.manager == nil {
		return // 单独运行的场景没有别的场景可去
	}
	scene.Sessions.Each(func(client *Session) {
		if client.Link() != nil {
			fn(client.Player)
		}
	})
}

// enterPortal 在玩家 player 在传送门里站够了时调用：送他去传送门通往的场景。
func (scene *Scene) enterPortal(player *core.Entity, portal *config.Portal) {
	if client := scene.Sessions.ByPlayer(player.ID); client != nil {
		scene.travel(client, portal.To, 0)
	}
}

// 下面是 session.Host：会话系统处理不了的、跨场景的事交给场景。

// Gone 在角色被删除之后告诉 Manager。
func (scene *Scene) Gone(client *Session) {
	if scene.manager != nil {
		scene.manager.gone(client, scene)
	}
}

// Lines 回答玩家的线路列表请求：这个场景模板的全部线。
func (scene *Scene) Lines(client *Session) *pb.LineList {
	if scene.manager == nil {
		return nil
	}
	return scene.manager.lineList(scene)
}

// SwitchLine 让玩家换到这个场景的第 wantLine 线：要活着、不在战斗中、那条线存在且没满。
func (scene *Scene) SwitchLine(client *Session, wantLine int) string {
	now := scene.State.Now()
	switch {
	case scene.manager == nil:
		return reasonSingleScene
	case scene.Template.Dungeon():
		return reasonDungeon
	case wantLine == scene.Line:
		return reasonSameLine
	case client.Player.Dead:
		return reasonDead
	case inCombat(client.Player, now):
		return reasonInCombat
	}
	if reason := scene.manager.canEnter(scene.Template.ID, wantLine); reason != "" {
		return reason
	}
	scene.travel(client, scene.Template.ID, wantLine)
	return ""
}

// SceneInfo 是欢迎消息里的场景信息：场景、线号、地图地址和传送门。
func (scene *Scene) SceneInfo() *pb.SceneInfo {
	info := &pb.SceneInfo{
		Id:   proto.String(scene.Template.ID),
		Name: proto.String(scene.Template.Name),
		Line: core.I32(scene.Line),
		Map:  proto.String(MapURL(scene.Template)),
	}
	if template := scene.Template; template.Dungeon() {
		info.Dungeon = proto.Bool(true)
		for _, area := range template.Layout.Rooms {
			room := &pb.RoomInfo{
				Id:    proto.String(area.ID),
				Title: proto.String(area.Title),
				X:     core.I32(area.X),
				Y:     core.I32(area.Y),
				W:     core.I32(area.W),
				H:     core.I32(area.H),
			}
			if cfg := template.Room(area.ID); cfg != nil {
				room.Waves = core.I32(len(cfg.Waves))
				room.Reward = proto.String(cfg.Reward)
				room.Dark = proto.Bool(cfg.Dark)
				if cfg.Key != "" {
					room.Key = proto.String(cfg.Key)
				}
			}
			info.Rooms = append(info.Rooms, room)
		}
		for _, gate := range template.Layout.Gates {
			info.Gates = append(info.Gates, &pb.GateInfo{
				Id:   proto.String(gate.ID),
				X:    core.I32(gate.X),
				Y:    core.I32(gate.Y),
				W:    core.I32(gate.W),
				H:    core.I32(gate.H),
				To:   proto.String(gate.To),
				Key:  proto.String(gate.Key),
				Bare: proto.Bool(gate.Bare()),
			})
		}
	}
	for _, portal := range scene.Portals.List() {
		toName := portal.To
		if scene.manager != nil {
			if target := scene.manager.cfg.Scenes.Scene(portal.To); target != nil {
				toName = target.Name
			}
		}
		info.Portals = append(info.Portals, &pb.PortalInfo{
			X:      core.I32(portal.X),
			Y:      core.I32(portal.Y),
			R:      core.I32(portal.Radius),
			To:     proto.String(portal.To),
			ToName: proto.String(toName),
		})
	}
	return info
}

// MapURL 是浏览器下载场景模板地图的地址。
func MapURL(template *config.Scene) string {
	if template.Map == config.MapFile {
		return "/map.tmj" // 旧的单场景配置
	}
	return "/maps/" + template.Map
}
