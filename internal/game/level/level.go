// Package level 负责副本（scenes.yaml 里 kind: dungeon 的场景）的房间玩法，参考 Hades 的房间制：
//   - 玩家走进一个房间，通往这个房间的门关上，怪一波一波刷出来，上一波死光了才刷下一波；
//   - 最后一波死光，房间清完：后面的门打开，房间里的玩家拿到奖励（回血、装备或关内祝福）；
//   - 岔路：走进其中一边，另一边（房间的 excludes）的门永远关上；
//   - 房间里没有活着的玩家了（都死了，回存档点复活了）：房间重置，怪清掉，门重新打开，可以再来。
//
// 存档点是带 checkpoint 的回血区：玩家走进去以后，死了在那里复活（这部分在所有场景都生效）。
package level

import (
	"fmt"
	"math"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/combat"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/item"
	"github.com/qinbaixi/BtDemo/internal/game/move"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/game/spawn"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

const (
	// enterInset 是玩家离房间边多远才算“进了房间”：要走过门（门在房间边上），关门时不会把人夹在门里
	enterInset = 48
	// waveGap 是上一波死光以后隔多少毫秒刷下一波
	waveGap config.Millis = 1500
	// wipeDelay 是房间里没有活着的玩家多少毫秒之后重置（刚倒下时怪不会马上消失）
	wipeDelay config.Millis = 1500
	// spawnInset 是怪刷在离房间边多远以内（不刷在墙里、门口）
	spawnInset = 56
	// spawnClearance 是怪尽量刷在离玩家多远之外（不贴脸刷）
	spawnClearance = 160
	// stuckLimit 是一波怪多少毫秒没有倒下一只就当作卡住了，见 unstick
	stuckLimit config.Millis = 20000
	// unstickRange 是卡住的怪离玩家多远以上才挪（近的说明玩家打得到，只是还没打死）
	unstickRange = 240
)

// 给玩家的提示。
const (
	NoticeCheckpoint = "已记录存档点"
	NoticeHeal       = "生命回满了"
)

// System 是一个副本场景的关卡进度。不是副本的场景也有一个，只处理存档点。
type System struct {
	state  *core.State
	nav    *nav.Map
	move   *move.System
	spawn  *spawn.System
	combat *combat.System
	items  *item.System
	scene  *config.Scene
	rooms  []*room
	byID   map[string]*room
	gates  []*gate
}

// room 是一个房间的运行状态。
type room struct {
	area     *config.RoomArea
	cfg      *config.LevelRoom // 没在 scenes.yaml 里配玩法的房间是 nil（当安全屋）
	status   *core.RoomStatus
	monsters []*core.Entity // 这个房间刷出来、还在场景里的怪（含尸体）
	waveAt   config.Millis  // 下一波的刷怪时刻，0 表示没有在等
	emptyAt  config.Millis  // 房间里最近一次没有活着的玩家的时刻，0 表示有人
	// alive 和 progressAt：这一波还活着几只、最近一次有怪倒下的时刻，用来发现卡住的怪（见 unstick）
	alive      int
	progressAt config.Millis
	// alliesSpawned 记下友方 NPC 刷过了没有（只刷一次）
	alliesSpawned bool
}

// gate 是一扇门：地图上的矩形，关着时是寻路图里第 shape 个障碍物。
type gate struct {
	cfg       config.Gate
	shape     int
	status    *core.GateStatus
	breakable *core.Entity // 挡在门里、砍掉门才开的东西（cfg.Breakable），没有为 nil
}

// GateShapes 把场景地图里的门换算成障碍物，接在地图物件的障碍物后面交给 nav.New；
// New 的 firstGate 就是它们在障碍物列表里的起始下标。
func GateShapes(layout config.Layout) []nav.Shape {
	shapes := make([]nav.Shape, 0, len(layout.Gates))
	for _, cfg := range layout.Gates {
		shapes = append(shapes, nav.Shape{
			Kind: nav.Rect,
			A:    nav.Vec{X: float64(cfg.X), Y: float64(cfg.Y)},
			B:    nav.Vec{X: float64(cfg.X + cfg.W), Y: float64(cfg.Y + cfg.H)},
		})
	}
	return shapes
}

// New 创建关卡系统。firstGate 是门在 navMap 障碍物列表里的起始下标（见 GateShapes）。
func New(
	state *core.State,
	navMap *nav.Map,
	moveSys *move.System,
	spawnSys *spawn.System,
	combatSys *combat.System,
	itemSys *item.System,
	scene *config.Scene,
	firstGate int,
) *System {
	sys := &System{
		state:  state,
		nav:    navMap,
		move:   moveSys,
		spawn:  spawnSys,
		combat: combatSys,
		items:  itemSys,
		scene:  scene,
		byID:   map[string]*room{},
	}
	state.Level = core.Level{}
	if scene == nil || !scene.Dungeon() {
		return sys
	}
	for i := range scene.Layout.Rooms {
		area := &scene.Layout.Rooms[i]
		status := &core.RoomStatus{ID: area.ID}
		created := &room{area: area, cfg: scene.Room(area.ID), status: status}
		sys.rooms = append(sys.rooms, created)
		sys.byID[area.ID] = created
		state.Level.Rooms = append(state.Level.Rooms, status)
	}
	for i, cfg := range scene.Layout.Gates {
		status := &core.GateStatus{ID: cfg.ID}
		created := &gate{cfg: cfg, shape: firstGate + i, status: status}
		if cfg.Breakable != "" {
			// 放在门正中（门的碰撞挡着它，所以不找空地），死了不复活
			x, y := cfg.Center()
			created.breakable = spawnSys.Template(state.Cfg.Templates[cfg.Breakable], x, y)
			created.breakable.Room = "gate:" + cfg.ID
			moveSys.PlaceExact(created.breakable, x, y)
		}
		sys.gates = append(sys.gates, created)
		state.Level.Gates = append(state.Level.Gates, status)
	}
	sys.updateGates()
	state.Level.Version++
	return sys
}

// Tick 在每个 tick 运行：存档点、房间进度、门的开关。players 列出场景里的玩家。
func (sys *System) Tick(players func(fn func(*core.Entity))) {
	var alive []*core.Entity
	players(func(player *core.Entity) {
		if player.Alive() {
			alive = append(alive, player)
		}
	})
	sys.checkpoints(alive)
	if len(sys.rooms) == 0 {
		return
	}
	now := sys.state.Now()
	for _, current := range sys.rooms {
		switch current.status.Phase {
		case core.RoomIdle:
			if someoneInside(current.area, alive, enterInset) {
				sys.enter(current)
			}
		case core.RoomFight:
			sys.fight(current, alive, now)
		}
	}
	if sys.updateGates() {
		sys.state.Level.Version++
	}
}

// checkpoints 记下走进存档点（带 checkpoint 的回血区）的玩家。
func (sys *System) checkpoints(alive []*core.Entity) {
	for _, player := range alive {
		for _, zone := range sys.state.Zones.List() {
			if !zone.Cfg.Checkpoint || !zone.Cfg.Contains(zone.X, zone.Y, player.X, player.Y) {
				continue
			}
			// 只认站着的第一个存档点：两个存档点挨在一起时不会来回切换、一直弹提示
			point := config.Point{X: zone.Cfg.X, Y: zone.Cfg.Y, Spread: zone.Cfg.Radius / 3}
			if player.Checkpoint == nil || *player.Checkpoint != point {
				player.Checkpoint = &point
				player.Notices = append(player.Notices, NoticeCheckpoint+"："+zone.Cfg.Name)
			}
			break
		}
	}
}

// enter 在第一个玩家走进房间时调用：岔路的另一边作废；有波次就开打，没有就直接算清完。
func (sys *System) enter(current *room) {
	if current.cfg != nil {
		for _, excluded := range current.cfg.Excludes {
			if other := sys.byID[excluded]; other != nil && other.status.Phase == core.RoomIdle {
				other.status.Phase = core.RoomSkipped
			}
		}
	}
	sys.state.Level.Version++
	if current.cfg != nil && !current.alliesSpawned {
		current.alliesSpawned = true
		for _, ally := range current.cfg.Allies {
			for range ally.Count {
				x, y := sys.state.Scatter(float64(ally.X), float64(ally.Y), float64(ally.Spread))
				sys.spawn.Template(sys.state.Cfg.Templates[ally.Template], x, y)
			}
		}
	}
	if current.cfg == nil || len(current.cfg.Waves) == 0 {
		sys.clear(current)
		return
	}
	current.status.Phase = core.RoomFight
	current.emptyAt = 0
	current.progressAt = sys.state.Now()
	sys.spawnWave(current, 1)
}

// fight 推进打着的房间：没人了就重置，这一波死光了就刷下一波或者清完。
func (sys *System) fight(current *room, alive []*core.Entity, now config.Millis) {
	if !someoneInside(current.area, alive, 0) {
		if current.emptyAt == 0 {
			current.emptyAt = now
		}
		if now-current.emptyAt >= wipeDelay {
			sys.reset(current)
		}
		return
	}
	current.emptyAt = 0
	if current.waveAt > 0 {
		if now >= current.waveAt {
			current.waveAt = 0
			sys.spawnWave(current, current.status.Wave+1)
		}
		return
	}
	monstersLeft := 0
	for _, monster := range current.monsters {
		if monster.Alive() {
			monstersLeft++
		}
	}
	if monstersLeft != current.alive {
		current.alive, current.progressAt = monstersLeft, now
	}
	if monstersLeft > 0 {
		if now-current.progressAt >= stuckLimit {
			sys.unstick(current)
			current.progressAt = now
		}
		return
	}
	if current.status.Wave < len(current.cfg.Waves) {
		current.waveAt = now + waveGap
		return
	}
	sys.clear(current)
}

// Summon 在 owner 周围 radius 处召唤 count 个模板 template 的怪（首领叫狼），返回叫出来几个。
// 叫来的怪和 owner 同一个房间（算进房间这一波，死光了房间才清完），一出来就盯上 owner 的目标。
func (sys *System) Summon(owner *core.Entity, template string, count int, radius float64) int {
	cfg := sys.state.Cfg.Templates[template]
	current := sys.byID[owner.Room]
	made := 0
	for range count {
		x, y, ok := sys.ringSpot(owner, radius)
		if !ok {
			break
		}
		monster := sys.spawn.Template(cfg, x, y)
		monster.Room = owner.Room
		monster.SetTarget(owner.Target)
		if current != nil {
			current.monsters = append(current.monsters, monster)
		}
		sys.state.Events.Emit(
			monster,
			&core.Event{Kind: pb.EventKind_RESPAWN.Enum(), Id: core.I32(monster.ID)},
		)
		made++
	}
	return made
}

// ringSpot 在 owner 周围 radius 的圆上找一个能站的地方（试几个随机角度）。
func (sys *System) ringSpot(owner *core.Entity, radius float64) (float64, float64, bool) {
	for range 12 {
		angle := sys.state.Rand.Float64() * 2 * math.Pi
		x := owner.X + math.Cos(angle)*radius
		y := owner.Y + math.Sin(angle)*radius
		spot := nav.Vec{X: x, Y: y}
		from := nav.Vec{X: owner.X, Y: owner.Y}
		if sys.nav.Free(spot, 16) && sys.nav.Clear(from, spot, 4) {
			return x, y, true
		}
	}
	return 0, 0, false
}

// unstick 在一波怪很久没有倒下时调用：活着的怪可能卡在玩家走不到的角落（门关着，玩家出不去，
// 房间就永远清不完），把它们挪到离玩家近一点的地方重新盯上玩家。
func (sys *System) unstick(current *room) {
	inside := sys.playersInside(current.area)
	if len(inside) == 0 {
		return
	}
	for _, monster := range current.monsters {
		if !monster.Alive() {
			continue
		}
		nearest := nearestOf(monster, inside)
		if core.Dist(monster, nearest) <= unstickRange {
			continue
		}
		angle := sys.state.Rand.Float64() * 2 * math.Pi
		x := nearest.X + math.Cos(angle)*unstickRange/2
		y := nearest.Y + math.Sin(angle)*unstickRange/2
		sys.move.Place(monster, x, y)
		monster.Steering = core.Steering{}
		monster.SetTarget(nearest.ID)
	}
}

// spawnWave 刷出房间的第 number 波（从 1 开始），刷出来的怪直接盯上离得最近的玩家。
func (sys *System) spawnWave(current *room, number int) {
	current.status.Wave = number
	sys.state.Level.Version++
	sys.dropRemoved(current)
	inside := sys.playersInside(current.area)
	for _, group := range current.cfg.Waves[number-1] {
		template := sys.state.Cfg.Templates[group.Template]
		for range group.Count {
			x, y := sys.spawnSpot(current.area, inside)
			if group.At() {
				x, y = sys.state.Scatter(float64(group.X), float64(group.Y), float64(group.Spread))
			}
			monster := sys.spawn.Template(template, x, y)
			monster.Room = current.area.ID
			if nearest := nearestOf(monster, inside); nearest != nil {
				monster.SetTarget(nearest.ID)
			}
			current.monsters = append(current.monsters, monster)
			sys.state.Events.Emit(
				monster,
				&core.Event{Kind: pb.EventKind_RESPAWN.Enum(), Id: core.I32(monster.ID)},
			)
		}
	}
}

// spawnSpot 在房间里挑一个刷怪的位置：尽量离 players 都远一点，试几次挑最远的。
func (sys *System) spawnSpot(area *config.RoomArea, players []*core.Entity) (float64, float64) {
	bestX, bestY, bestGap := 0.0, 0.0, -1.0
	width := float64(area.W - 2*spawnInset)
	height := float64(area.H - 2*spawnInset)
	for range 12 {
		x := float64(area.X+spawnInset) + sys.state.Rand.Float64()*math.Max(1, width)
		y := float64(area.Y+spawnInset) + sys.state.Rand.Float64()*math.Max(1, height)
		if !sys.nav.Free(nav.Vec{X: x, Y: y}, 16) {
			continue
		}
		gap := math.Inf(1)
		for _, player := range players {
			gap = math.Min(gap, math.Hypot(player.X-x, player.Y-y))
		}
		if gap >= spawnClearance {
			return x, y
		}
		if gap > bestGap {
			bestX, bestY, bestGap = x, y, gap
		}
	}
	if bestGap < 0 { // 一次都没找到空地：刷在房间中间，spawn 会挪到附近的空地
		return float64(area.X + area.W/2), float64(area.Y + area.H/2)
	}
	return bestX, bestY
}

// clear 把房间标成清完，给房间里活着的玩家发奖励。
func (sys *System) clear(current *room) {
	current.status.Phase = core.RoomClear
	current.waveAt, current.emptyAt = 0, 0
	sys.state.Level.Version++
	if current.cfg == nil || current.cfg.Reward == "" {
		return
	}
	for _, player := range sys.playersInside(current.area) {
		sys.reward(player, current.cfg.Reward)
	}
}

// playersInside 返回房间 area 里活着的玩家，按实体 ID 排序。
func (sys *System) playersInside(area *config.RoomArea) []*core.Entity {
	var inside []*core.Entity
	sys.state.Ents.Each(func(entity *core.Entity) {
		if entity.Kind == core.KindPlayer && entity.Alive() && area.Contains(entity.X, entity.Y, 0) {
			inside = append(inside, entity)
		}
	})
	return inside
}

// reward 给玩家 player 一份房间奖励。
func (sys *System) reward(player *core.Entity, kind string) {
	switch kind {
	case config.RewardHeal:
		healed := player.Attr.MaxHP - player.HP
		player.SetHP(player.Attr.MaxHP)
		player.Notices = append(player.Notices, NoticeHeal)
		sys.state.Events.Emit(
			player,
			&core.Event{
				Kind:  pb.EventKind_HEAL.Enum(),
				Dst:   core.I32(player.ID),
				Value: core.I32(healed),
			},
		)
	case config.RewardGear:
		if given := sys.items.Reward(player); given != nil {
			player.Notices = append(player.Notices, "获得装备「"+given.Name+"」")
		}
	case config.RewardBoon:
		boons := sys.scene.Boons
		boon := boons[sys.state.Luck.Intn(len(boons))]
		sys.combat.AddBuff(player, boon)
		player.Notices = append(player.Notices, fmt.Sprintf("获得祝福「%s」", boon.Name))
	}
}

// reset 在打着的房间里没有活着的玩家时调用：怪全部移走，房间回到没人进过的样子，可以重新挑战。
func (sys *System) reset(current *room) {
	for _, monster := range current.monsters {
		if sys.state.Ents.Get(monster.ID) == monster {
			sys.spawn.Remove(monster)
		}
	}
	current.monsters = nil
	current.status.Phase = core.RoomIdle
	current.status.Wave = 0
	current.waveAt, current.emptyAt = 0, 0
	sys.state.Level.Version++
}

// dropRemoved 从房间的怪物列表里去掉已经被移出场景的尸体。
func (sys *System) dropRemoved(current *room) {
	kept := current.monsters[:0]
	for _, monster := range current.monsters {
		if sys.state.Ents.Get(monster.ID) == monster {
			kept = append(kept, monster)
		}
	}
	clear(current.monsters[len(kept):])
	current.monsters = kept
}

// updateGates 按房间进度算每扇门该开该关，改寻路图；有门变了返回 true。
//
//	开着 = after 房间清完了（没写 after 就不管）且 to 房间没在打、没被岔路作废。
func (sys *System) updateGates() bool {
	changed := false
	for _, current := range sys.gates {
		open := true
		after := sys.byID[current.cfg.After]
		if after != nil && after.status.Phase != core.RoomClear {
			open = false
		}
		if to := sys.byID[current.cfg.To]; to != nil &&
			(to.status.Phase == core.RoomFight || to.status.Phase == core.RoomSkipped) {
			open = false
		}
		if current.breakable.Alive() {
			open = false
		}
		if current.status.Open != open {
			current.status.Open = open
			changed = true
		}
		sys.nav.SetSolid(current.shape, !open)
	}
	return changed
}

// someoneInside 报告 players 里有没有人在房间 area 里（离边至少 inset）。
func someoneInside(area *config.RoomArea, players []*core.Entity, inset float64) bool {
	for _, player := range players {
		if area.Contains(player.X, player.Y, inset) {
			return true
		}
	}
	return false
}

// nearestOf 返回 players 里离 entity 最近的一个，没有返回 nil。
func nearestOf(entity *core.Entity, players []*core.Entity) *core.Entity {
	var nearest *core.Entity
	for _, player := range players {
		if nearest == nil || core.Dist(entity, player) < core.Dist(entity, nearest) {
			nearest = player
		}
	}
	return nearest
}
