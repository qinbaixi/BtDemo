package game

import (
	"testing"
	"time"

	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/session"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// enterDungeon 让一个新角色从晨曦村进第一关，返回会话和它所在的副本。
func enterDungeon(t *testing.T, manager *Manager) (*Session, *Scene) {
	t.Helper()
	client := attachNow(t, manager, session.NewLink(), "")
	village := sceneOf(manager, client)
	village.Do(func() { village.travel(client, "wolf_trail", 0) })
	pump(manager, 3)
	dungeon := sceneOf(manager, client)
	if dungeon == nil || dungeon.Template.ID != "wolf_trail" {
		t.Fatal("the player should be in the dungeon")
	}
	return client, dungeon
}

// roomStatus 返回副本里房间 id 的进度。
func roomStatus(t *testing.T, scene *Scene, id string) *core.RoomStatus {
	t.Helper()
	for _, room := range scene.State.Level.Rooms {
		if room.ID == id {
			return room
		}
	}
	t.Fatalf("no room %s", id)
	return nil
}

// gateOpen 报告副本里门 id 开没开。
func gateOpen(t *testing.T, scene *Scene, id string) bool {
	t.Helper()
	for _, gate := range scene.State.Level.Gates {
		if gate.ID == id {
			return gate.Open
		}
	}
	t.Fatalf("no gate %s", id)
	return false
}

// roomMonsters 返回房间 id 刷出来、还活着的怪。
func roomMonsters(scene *Scene, id string) []*core.Entity {
	var alive []*core.Entity
	scene.State.Ents.Each(func(entity *core.Entity) {
		if entity.Room == id && entity.Alive() {
			alive = append(alive, entity)
		}
	})
	return alive
}

// moveTo 把角色直接放到 (x, y)。
func moveTo(scene *Scene, player *core.Entity, x, y float64) {
	scene.Move.Place(player, x, y)
}

// 每个进副本的玩家单独开一份，副本里不能换线；出生在入口，入口的门开着，后面的门关着。
func TestDungeonIsAnInstancePerPlayer(t *testing.T) {
	manager := shippedManager(t)
	first, firstScene := enterDungeon(t, manager)
	_, secondScene := enterDungeon(t, manager)
	if firstScene == secondScene {
		t.Fatal("two players should get two instances")
	}
	if reason := firstScene.SwitchLine(first, secondScene.Line); reason != reasonDungeon {
		t.Fatalf("switching line in a dungeon: %q", reason)
	}
	entranceOpen := gateOpen(t, firstScene, "g_r1_in")
	laterOpen := gateOpen(t, firstScene, "g_r1_out") || gateOpen(t, firstScene, "g_shortcut")
	if !entranceOpen || laterOpen {
		t.Fatal("only the gate into the first room should be open at the start")
	}
	welcome := lastWelcome(sentMessages(t, first))
	info := welcome.GetScene()
	if !info.GetDungeon() || len(info.GetRooms()) != 10 || len(info.GetGates()) != 11 {
		t.Fatalf("welcome scene = %v", info)
	}
}

// 走进房间：门关上，一波一波刷怪；打完最后一波房间清完，后面的门打开，进度发给客户端。
func TestRoomLocksSpawnsWavesAndClears(t *testing.T) {
	manager := shippedManager(t)
	client, scene := enterDungeon(t, manager)
	player := client.Player
	sentMessages(t, client)
	moveTo(scene, player, 460, 2840)
	pump(manager, 1)
	room := roomStatus(t, scene, "r1")
	if room.Phase != core.RoomFight || room.Wave != 1 || gateOpen(t, scene, "g_r1_in") {
		t.Fatalf("r1 = %+v, entrance open %v", room, gateOpen(t, scene, "g_r1_in"))
	}
	if !scene.Nav.Solid(len(scene.Nav.Shapes()) - 11) { // 第一扇门是 g_r1_in
		t.Fatal("the closed gate should block the way")
	}
	for wave := 1; wave <= 2; wave++ {
		monsters := roomMonsters(scene, "r1")
		if len(monsters) == 0 {
			t.Fatalf("wave %d spawned nothing", wave)
		}
		for _, monster := range monsters {
			scene.Combat.Kill(monster, player)
		}
		pump(manager, 40) // 隔一会儿刷下一波
	}
	bothOpen := gateOpen(t, scene, "g_r1_in") && gateOpen(t, scene, "g_r1_out")
	if room.Phase != core.RoomClear || !bothOpen {
		t.Fatalf("r1 = %+v after two waves", room)
	}
	var level *pb.LevelState
	for _, msg := range sentMessages(t, client) {
		if msg.GetLevel() != nil {
			level = msg.GetLevel()
		}
	}
	if level == nil {
		t.Fatal("the client should get the level progress")
	}
	pump(manager, 200) // 尸体到时间移除，不复活
	scene.State.Ents.Each(func(entity *core.Entity) {
		if entity.Room == "r1" {
			t.Fatalf("room monster %d should be gone, dead=%v", entity.ID, entity.Dead)
		}
	})
}

// 岔路：走进一边，另一边的门永远关上；清完拿到房间的奖励（祝福死了也不掉）。
func TestForkExcludesTheOtherSideAndRewards(t *testing.T) {
	manager := shippedManager(t)
	client, scene := enterDungeon(t, manager)
	player := client.Player
	roomStatus(t, scene, "r1").Phase = core.RoomClear
	roomStatus(t, scene, "r2").Phase = core.RoomClear
	moveTo(scene, player, 1010, 2110)
	pump(manager, 1)
	if roomStatus(t, scene, "r3b").Phase != core.RoomSkipped || gateOpen(t, scene, "g_r2_b") {
		t.Fatal("walking into r3a should close the way to r3b")
	}
	for wave := 1; wave <= 2; wave++ {
		for _, monster := range roomMonsters(scene, "r3a") {
			scene.Combat.Kill(monster, player)
		}
		pump(manager, 40)
	}
	if roomStatus(t, scene, "r3a").Phase != core.RoomClear || !gateOpen(t, scene, "g_r3a_out") {
		t.Fatal("r3a should be cleared and open the way on")
	}
	boons := 0
	for _, buff := range player.Buffs {
		if buff.Cfg.Keep {
			boons++
		}
	}
	if boons != 1 {
		t.Fatalf("player should have one boon, buffs %v", player.Buffs)
	}
	scene.Combat.Kill(player, nil)
	if len(player.Buffs) != 1 {
		t.Fatal("a boon should survive death")
	}
}

// 房间里的玩家都死了：房间重置（怪移走、门打开），玩家在最近走过的存档点复活。
func TestWipeResetsRoomAndRespawnsAtCheckpoint(t *testing.T) {
	manager := shippedManager(t)
	client, scene := enterDungeon(t, manager)
	player := client.Player
	pump(manager, 2)
	if player.Checkpoint == nil || player.Checkpoint.Y != 3300 {
		t.Fatalf("the camp spring should be the checkpoint, got %v", player.Checkpoint)
	}
	moveTo(scene, player, 460, 2840)
	pump(manager, 1)
	scene.Combat.Kill(player, nil)
	pump(manager, 40)
	room := roomStatus(t, scene, "r1")
	monstersLeft := len(roomMonsters(scene, "r1"))
	if room.Phase != core.RoomIdle || monstersLeft != 0 || !gateOpen(t, scene, "g_r1_in") {
		t.Fatalf("r1 should reset after the wipe: %+v", room)
	}
	pump(manager, 40)
	if player.Dead || player.Y < 3100 {
		t.Fatalf(
			"player should respawn at the camp, at (%v, %v) dead=%v",
			player.X,
			player.Y,
			player.Dead,
		)
	}
}

// 安全屋走进去就算清完；猎人小屋清完打开回林口的捷径；离开副本时存档点和祝福都清掉。
func TestSafeRoomOpensShortcutAndLeavingClears(t *testing.T) {
	manager := shippedManager(t)
	client, scene := enterDungeon(t, manager)
	player := client.Player
	moveTo(scene, player, 1200, 140)
	pump(manager, 1)
	if roomStatus(t, scene, "r7").Phase != core.RoomClear {
		t.Fatal("walking into a room without waves should clear it")
	}
	moveTo(scene, player, 1190, 1560)
	pump(manager, 1)
	for _, monster := range roomMonsters(scene, "r4") {
		scene.Combat.Kill(monster, player)
	}
	pump(manager, 40)
	if roomStatus(t, scene, "r4").Phase != core.RoomClear || !gateOpen(t, scene, "g_shortcut") {
		t.Fatal("clearing the hut should open the shortcut")
	}
	scene.Combat.AddBuff(player, scene.Template.Boons[0])
	scene.Do(func() { scene.travel(client, "village", 0) })
	pump(manager, 3)
	if player.Checkpoint != nil || len(player.Buffs) != 0 {
		t.Fatal("leaving the dungeon should drop the checkpoint and boons")
	}
	pump(manager, 200) // 副本空了一会儿就关掉
	manager.closeIdle(time.Now().Add(time.Minute))
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if len(manager.lines["wolf_trail"]) != 0 {
		t.Fatal("the empty dungeon should close")
	}
}

// 一波怪很久没倒下（可能卡在走不到的角落）：活着的、离玩家远的怪被挪到玩家附近。
func TestStuckMonstersAreMovedToThePlayer(t *testing.T) {
	manager := shippedManager(t)
	client, scene := enterDungeon(t, manager)
	player := client.Player
	moveTo(scene, player, 460, 2840)
	pump(manager, 1)
	monsters := roomMonsters(scene, "r1")
	for _, monster := range monsters {
		monster.Speed = 0 // 站着不动，模拟卡住
		monster.AI = nil
		moveTo(scene, monster, 200, 2680)
	}
	pump(manager, 20*21) // 20 秒多一点
	for _, monster := range monsters {
		if core.Dist(monster, player) > 240 {
			t.Fatalf("stuck monster %d still %.0f away", monster.ID, core.Dist(monster, player))
		}
	}
}

// 进房锁门时落在门外的宠物被传送到主人身边，不会被关在外面。
func TestPetLeftOutsideIsBroughtIn(t *testing.T) {
	manager := shippedManager(t)
	client, scene := enterDungeon(t, manager)
	player := client.Player
	var pet *core.Entity
	scene.State.Ents.Each(func(entity *core.Entity) {
		if entity.Kind == core.KindPet && entity.Owner == player.ID {
			pet = entity
		}
	})
	if pet == nil {
		t.Fatal("the player should have a pet")
	}
	moveTo(scene, pet, 800, 3290) // 还在营地
	moveTo(scene, player, 460, 2840)
	pump(manager, 1)
	if roomStatus(t, scene, "r1").Phase != core.RoomFight {
		t.Fatal("r1 should start")
	}
	if core.Dist(pet, player) > 80 {
		t.Fatalf("the pet should be next to its owner, %.0f away", core.Dist(pet, player))
	}
}
