package game

import (
	"testing"

	"github.com/qinbaixi/BtDemo/internal/game/core"
)

// 第二关首领「血槌」：冲撞撞碎石柱、震地的冲击环、二阶段坑边站起骷髅弓手。

// pitBoss 进第二关，把前面的房间都当成清完，把玩家放进献祭坑，返回会话、副本和首领。
func pitBoss(t *testing.T) (*Session, *Scene, *core.Entity) {
	t.Helper()
	client, scene := enterCrypt(t)
	for _, room := range []string{"r1", "r2", "r3a", "r3b", "secret", "r4", "r5"} {
		roomStatus(t, scene, room).Phase = core.RoomClear
	}
	moveTo(scene, client.Player, 800, 3420)
	stepScene(scene, 2)
	boss := findTemplate(scene, "r6", "blood_hammer")
	if boss == nil {
		t.Fatal("the boss should be in the pit")
	}
	return client, scene, boss
}

// pillarAt 返回献祭坑石柱门 gateID 里的石柱。
func pillarAt(scene *Scene, gateID string) *core.Entity {
	var pillar *core.Entity
	scene.State.Ents.Each(func(entity *core.Entity) {
		if entity.Room == "gate:"+gateID {
			pillar = entity
		}
	})
	return pillar
}

// 冲撞被石柱挡住：石柱碎了、那里不再挡路，首领自己晕 2.5 秒。
func TestChargeBreaksThePillar(t *testing.T) {
	client, scene, boss := pitBoss(t)
	player := client.Player
	pillar := pillarAt(scene, "g_pillar1") // (620, 3480)
	if pillar == nil || !pillar.Alive() || gateOpen(t, scene, "g_pillar1") {
		t.Fatal("the pillar should stand and block")
	}
	boss.AI, boss.Windup, boss.Knock = nil, nil, nil
	moveTo(scene, player, 520, 3480)       // 玩家躲在柱子后面
	scene.Move.PlaceExact(boss, 800, 3480) // 首领在柱子另一边
	charge := scene.State.Cfg.Skills["hammer_charge"]
	strikeNow(t, scene, boss, charge, player.ID)
	if pillar.Alive() {
		t.Fatal("charging into the pillar should break it")
	}
	if boss.StunUntil-scene.State.Now() < charge.SelfStun {
		t.Fatalf("the boss should be stunned for %d ms", charge.SelfStun)
	}
	stepScene(scene, 2)
	if !gateOpen(t, scene, "g_pillar1") {
		t.Fatal("a broken pillar should not block any more")
	}
	if player.HP < player.Attr.MaxHP {
		t.Fatal("the pillar should have shielded the player")
	}
}

// 震地：三圈冲击环从落点往外扩，站在环扫过的地方每圈挨一下，站在最远半径外不挨。
func TestQuakeRingsSpreadOut(t *testing.T) {
	client, scene, boss := pitBoss(t)
	player := client.Player
	boss.AI, boss.Windup, boss.Knock = nil, nil, nil
	scene.Move.PlaceExact(boss, 800, 3600)
	moveTo(scene, player, 800+200, 3600)
	quake := scene.State.Cfg.Skills["blood_quake"]
	hp := player.HP
	strikeNow(t, scene, boss, quake, 0)
	hits := 0
	for range 80 { // 4 秒：三圈都扩完
		before := player.HP
		stepScene(scene, 1)
		if player.HP < before {
			hits++
		}
	}
	if hits != quake.Rings || player.HP >= hp {
		t.Fatalf("each ring should hit once, got %d hits", hits)
	}
	moveTo(scene, player, 800-float64(quake.Radius)-60, 3600)
	if player.X > 800-float64(quake.Radius)-40 {
		t.Skip("the pit is too small to stand outside the rings here")
	}
	hp = player.HP
	strikeNow(t, scene, boss, quake, 0)
	stepScene(scene, 80)
	if player.HP < hp {
		t.Fatal("standing beyond the radius should be safe")
	}
}

// 二阶段：血量掉到 60% 以下进二阶段，敲地以后坑边两处骨堆台子各站起一个骷髅弓手。
func TestPhaseTwoRaisesArchers(t *testing.T) {
	client, scene, boss := pitBoss(t)
	player := client.Player
	moveTo(scene, player, boss.X+60, boss.Y)
	boss.SetTarget(player.ID)
	boss.SetHP(boss.Attr.MaxHP / 2)
	stepScene(scene, 60) // 3 秒：进阶段、狂暴、敲地
	if boss.Phase < 2 {
		t.Fatalf("the boss should be in phase 2, phase %d", boss.Phase)
	}
	archers := 0
	scene.State.Ents.Each(func(entity *core.Entity) {
		if entity.Alive() && entity.Room == "r6" && entity.Tmpl != nil &&
			entity.Tmpl.ID == "skeleton_archer" {
			archers++
		}
	})
	if archers != 2 {
		t.Fatalf("knocking the ground should raise 2 archers, got %d", archers)
	}
}

// 首次通关：打死血槌（献祭坑清完）解锁骸骨守卫、守墓人两个皮肤；没解锁前换不上。
func TestClearingThePitUnlocksSkins(t *testing.T) {
	client, scene, boss := pitBoss(t)
	player := client.Player
	if reason := scene.Items.SetSkin(player, "boneguard"); reason == "" {
		t.Fatal("a locked skin should not be wearable")
	}
	scene.Combat.Kill(boss, player)
	stepScene(scene, 4)
	if roomStatus(t, scene, "r6").Phase != core.RoomClear {
		t.Fatal("killing the boss should clear the pit")
	}
	if len(player.UnlockedSkins) != 2 {
		t.Fatalf("clearing the pit should unlock 2 skins, got %v", player.UnlockedSkins)
	}
	if reason := scene.Items.SetSkin(player, "boneguard"); reason != "" {
		t.Fatalf("the unlocked skin should be wearable: %s", reason)
	}
}
