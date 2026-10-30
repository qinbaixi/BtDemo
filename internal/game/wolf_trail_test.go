package game

import (
	"testing"

	"github.com/qinbaixi/BtDemo/internal/game/core"
)

// 第一关「黑松林道」的新玩法：狼王的扑杀和阶段、头狼的嚎叫、召唤、荆棘门、猎人。

// bossArena 让玩家进第一关、把首领房标成清完（不刷狼王），在 (x, y) 放一只不动脑子的 template。
func bossArena(t *testing.T, template string, x, y float64) (*Session, *Scene, *core.Entity) {
	t.Helper()
	manager := shippedManager(t)
	client, scene := enterDungeon(t, manager)
	roomStatus(t, scene, "r6").Phase = core.RoomClear
	monster := scene.Spawn.Template(scene.State.Cfg.Templates[template], x, y)
	monster.AI = nil
	// 宠物会冲上去打首领、挡在扑杀路线上，测试里先拴到别处
	scene.State.Ents.Each(func(entity *core.Entity) {
		if entity.Kind == core.KindPet {
			entity.AI = nil
			moveTo(scene, entity, 400, 3300)
		}
	})
	return client, scene, monster
}

// stepScene 让场景走 ticks 个 tick（同步执行，不经过管理器）。
func stepScene(scene *Scene, ticks int) {
	for range ticks {
		scene.tick()
	}
}

// 扑杀被石头挡住：冲到石头前停下，自己晕好一会儿，玩家不掉血。
func TestPounceIntoRockStunsTheKing(t *testing.T) {
	client, scene, king := bossArena(t, "wolf_king", 1030, 640)
	player := client.Player
	moveTo(scene, player, 1030, 360) // 石头在 (1030, 440)，挡在中间
	pounce := scene.State.Cfg.Skills["pounce"]
	if err := scene.Combat.Cast(king, pounce, player.ID); err != nil {
		t.Fatal(err)
	}
	stepScene(scene, int(pounce.Windup)/50+12)
	if king.StunUntil <= scene.State.Now() {
		t.Fatal("the king should be stunned after hitting the rock")
	}
	if player.HP < player.Attr.MaxHP {
		t.Fatal("the rock should have taken the hit")
	}
	if king.Y < 460 {
		t.Fatalf("the king went through the rock, now at y=%.0f", king.Y)
	}
}

// 扑杀路上有玩家：停在玩家面前打一下，不晕。
func TestPounceHitsThePlayerInTheWay(t *testing.T) {
	client, scene, king := bossArena(t, "wolf_king", 1200, 720)
	player := client.Player
	moveTo(scene, player, 1200, 500)
	pounce := scene.State.Cfg.Skills["pounce"]
	if err := scene.Combat.Cast(king, pounce, player.ID); err != nil {
		t.Fatal(err)
	}
	stepScene(scene, int(pounce.Windup)/50+12)
	if player.HP >= player.Attr.MaxHP {
		t.Fatal("the pounce should hit the player")
	}
	if king.StunUntil > scene.State.Now() {
		t.Fatal("hitting a player is not hitting a wall")
	}
	if gap := core.Dist(king, player) - king.Radius - player.Radius; gap > 90 { // 打中以后玩家被击退 70
		t.Fatalf("the king should stop in front of the player, gap %.0f", gap)
	}
}

// 头狼嚎叫：附近的狼都加上 Buff，玩家不加。
func TestHowlBuffsThePack(t *testing.T) {
	client, scene, alpha := bossArena(t, "alpha_wolf", 1200, 600)
	pack := scene.Spawn.Template(scene.State.Cfg.Templates["pack_wolf"], 1260, 600)
	pack.AI = nil
	player := client.Player
	moveTo(scene, player, 1150, 600)
	if err := scene.Combat.Cast(alpha, scene.State.Cfg.Skills["pack_howl"], alpha.ID); err != nil {
		t.Fatal(err)
	}
	if len(alpha.Buffs) == 0 || len(pack.Buffs) == 0 {
		t.Fatal("the howl should buff the alpha and the pack")
	}
	for _, buff := range player.Buffs {
		if !buff.Cfg.Keep {
			t.Fatalf("the player should not get the howl, buffs %v", player.Buffs)
		}
	}
}

// 首领房：狼王掉到六成血进第二阶段叫狼，叫来的狼算进这个房间，全死光房间才清完。
func TestKingPhaseTwoSummonsIntoTheRoom(t *testing.T) {
	manager := shippedManager(t)
	client, scene := enterDungeon(t, manager)
	player := client.Player
	player.HP = player.Attr.MaxHP * 100 // 测试里别让玩家先倒下
	player.Attr.MaxHP = player.HP
	moveTo(scene, player, 1200, 620)
	stepScene(scene, 1)
	monsters := roomMonsters(scene, "r6")
	if len(monsters) != 1 || monsters[0].Tmpl.ID != "wolf_king" {
		t.Fatalf("r6 should spawn the king, got %d", len(monsters))
	}
	king := monsters[0]
	king.HP = king.Attr.MaxHP / 2
	stepScene(scene, 20)
	if king.Brain.Phase < 2 {
		t.Fatalf("the king should enter phase 2, phase %d", king.Brain.Phase)
	}
	wolves := roomMonsters(scene, "r6")
	if len(wolves) < 3 {
		t.Fatalf("phase 2 should summon the pack, room has %d", len(wolves))
	}
	scene.Combat.Kill(king, player)
	stepScene(scene, 40)
	if roomStatus(t, scene, "r6").Phase == core.RoomClear {
		t.Fatal("the room should wait for the summoned wolves")
	}
	for _, wolf := range roomMonsters(scene, "r6") {
		scene.Combat.Kill(wolf, player)
	}
	stepScene(scene, 40)
	if roomStatus(t, scene, "r6").Phase != core.RoomClear || !gateOpen(t, scene, "g_r6_out") {
		t.Fatal("killing everything should clear the boss room")
	}
}

// 秘密房的门是一丛荆棘：荆棘在门就关着，砍掉才开。
func TestBrambleGateOpensWhenCut(t *testing.T) {
	manager := shippedManager(t)
	_, scene := enterDungeon(t, manager)
	if gateOpen(t, scene, "g_secret") {
		t.Fatal("the bramble should block the secret room")
	}
	var bramble *core.Entity
	scene.State.Ents.Each(func(entity *core.Entity) {
		if entity.Room == "gate:g_secret" {
			bramble = entity
		}
	})
	if bramble == nil {
		t.Fatal("no bramble in the gate")
	}
	scene.Combat.Kill(bramble, nil)
	stepScene(scene, 2)
	if !gateOpen(t, scene, "g_secret") {
		t.Fatal("cutting the bramble should open the gate")
	}
}

// 猎人小屋：第一次进去刷出猎人，团灭重置以后再进不会多刷一个。
func TestHunterJoinsOnlyOnce(t *testing.T) {
	manager := shippedManager(t)
	client, scene := enterDungeon(t, manager)
	player := client.Player
	countHunters := func() int {
		hunters := 0
		scene.State.Ents.Each(func(entity *core.Entity) {
			if entity.Tmpl != nil && entity.Tmpl.ID == "hunter" {
				hunters++
			}
		})
		return hunters
	}
	moveTo(scene, player, 1190, 1560)
	stepScene(scene, 1)
	if countHunters() != 1 {
		t.Fatalf("entering the hut should bring out the hunter, got %d", countHunters())
	}
	scene.Combat.Kill(player, nil)
	stepScene(scene, 80) // 团灭重置，回存档点复活
	moveTo(scene, player, 1190, 1560)
	stepScene(scene, 1)
	if countHunters() != 1 {
		t.Fatalf("the hunter should not be spawned twice, got %d", countHunters())
	}
}
