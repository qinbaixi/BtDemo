package game

import (
	"testing"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 第二关「亡者地穴」的骷髅：持盾格挡、绕盾、倒下变骨堆、骨堆重组、骑士破防。

// findTemplate 返回场景里房间 room、模板 template 的活着的实体（没有返回 nil）。
func findTemplate(scene *Scene, room, template string) *core.Entity {
	var found *core.Entity
	scene.State.Ents.Each(func(entity *core.Entity) {
		if found == nil && entity.Alive() && entity.Room == room && entity.Tmpl != nil &&
			entity.Tmpl.ID == template {
			found = entity
		}
	})
	return found
}

// damageOn 返回最近一个打在 dst 身上的 DAMAGE 事件。
func damageOn(scene *Scene, dst *core.Entity) *core.Event {
	var found *core.Event
	for _, pending := range scene.State.Events.List() {
		if pending.Event.GetKind() == pb.EventKind_DAMAGE && int(pending.Event.GetDst()) == dst.ID {
			found = pending.Event
		}
	}
	return found
}

// strikeNow 让 src 马上对 target 打一下 skill（清掉冷却，前摇直接落下）。
func strikeNow(t *testing.T, scene *Scene, src *core.Entity, skill *config.Skill, target int) {
	t.Helper()
	src.Cooldowns = map[string]config.Millis{}
	src.StunUntil = 0
	if err := scene.Combat.Cast(src, skill, target); err != nil {
		t.Fatalf("%s: %v", skill.ID, err)
	}
	landWindup(scene, src)
}

// 骷髅兵在副本房间里倒下变成骨堆；骨堆不怕轻击，6 秒后重新站起来。
func TestSoldierBecomesAPileThatRisesAgain(t *testing.T) {
	client, scene, soldier := bossArena(t, "skeleton_soldier", 1200, 700)
	player := client.Player
	soldier.Room = "r6"
	scene.Spawn.Adopt(soldier)
	scene.Combat.Kill(soldier, player)
	stepScene(scene, int(soldier.Tmpl.Respawn)/50+2)
	pile := findTemplate(scene, "r6", "bone_pile")
	if pile == nil {
		t.Fatal("the soldier should leave a bone pile")
	}
	moveTo(scene, player, pile.X-40, pile.Y)
	scene.State.Events.Clear()
	strikeNow(t, scene, player, scene.State.Cfg.Skills["slash"], pile.ID)
	if pile.HP < pile.Attr.MaxHP {
		t.Fatal("a light hit should not hurt the pile")
	}
	if event := damageOn(scene, pile); event == nil || event.GetResult() != pb.HitResult_IMMUNE {
		t.Fatalf("the pile should shrug off the slash, event %v", event)
	}
	moveTo(scene, player, 400, 3300) // 走远一点，别让站起来的骷髅兵马上打起来
	stepScene(scene, 6000/50+10)
	if findTemplate(scene, "r6", "bone_pile") != nil {
		t.Fatal("the pile should be gone after it reassembles")
	}
	if findTemplate(scene, "r6", "skeleton_soldier") == nil {
		t.Fatal("the pile should rise as a skeleton soldier")
	}
}

// 重击或范围技能能砸碎骨堆，砸碎了就不会再站起来；房间要等骨堆砸碎才算清完。
func TestSmashingThePileClearsTheRoom(t *testing.T) {
	client, scene, soldier := bossArena(t, "skeleton_soldier", 1200, 700)
	player := client.Player
	player.HP = player.Attr.MaxHP * 100
	player.Attr.MaxHP = player.HP
	status := roomStatus(t, scene, "r6")
	status.Phase = core.RoomFight
	status.Wave = 99 // 当成最后一波打完了，只剩这只骷髅兵
	soldier.Room = "r6"
	scene.Spawn.Adopt(soldier)
	moveTo(scene, player, 1200, 620)
	scene.Combat.Kill(soldier, player)
	stepScene(scene, int(soldier.Tmpl.Respawn)/50+2)
	if status.Phase == core.RoomClear {
		t.Fatal("the room should wait for the pile")
	}
	pile := findTemplate(scene, "r6", "bone_pile")
	if pile == nil {
		t.Fatal("no pile")
	}
	pile.AI = nil // 别让它在测试里站起来
	pile.HP = 1
	moveTo(scene, player, pile.X-40, pile.Y)
	strikeNow(t, scene, player, scene.State.Cfg.Skills["whirlwind"], 0)
	if pile.Alive() {
		t.Fatal("the whirlwind should smash the pile")
	}
	stepScene(scene, 40)
	if findTemplate(scene, "r6", "skeleton_soldier") != nil {
		t.Fatal("a smashed pile should not rise")
	}
	if status.Phase != core.RoomClear {
		t.Fatalf("smashing the last pile should clear the room, phase %v", status.Phase)
	}
}

// 骷髅兵举盾：正面的一下被挡住，从背后打就挡不住。
func TestSoldierShieldCoversTheFront(t *testing.T) {
	world := coverWorld(t)
	front := joinAt(world, 1100, 800).Player
	back := joinAt(world, 1300, 800).Player
	soldier := world.Spawn.Template(world.State.Cfg.Templates["skeleton_soldier"], 1200, 800)
	soldier.AI = nil
	soldier.SetTarget(front.ID)
	if !world.Combat.RaiseBlock(soldier, true, 0) {
		t.Fatal("the soldier should raise its shield")
	}
	slash := world.State.Cfg.Skills["slash"]
	front.X, back.X = soldier.X-50, soldier.X+50
	world.Grid.Moved(front)
	world.Grid.Moved(back)
	world.State.Events.Clear()
	soldier.ParryUntil = 0 // 只看普通格挡，不看完美格挡
	strikeNow(t, world, front, slash, soldier.ID)
	if event := damageOn(world, soldier); event == nil || event.GetResult() != pb.HitResult_BLOCK {
		t.Fatalf("a hit from the front should be blocked, event %v", event)
	}
	world.State.Events.Clear()
	strikeNow(t, world, back, slash, soldier.ID)
	if event := damageOn(world, soldier); event == nil || event.GetResult() != pb.HitResult_HIT {
		t.Fatalf("a hit from behind should land, event %v", event)
	}
}

// 骷髅骑士架势厚，打空了硬直 2 秒（比玩家破防久）。
func TestKnightGuardBreakStunsTwoSeconds(t *testing.T) {
	world := coverWorld(t)
	player := joinAt(world, 1150, 800).Player
	knight := world.Spawn.Template(world.State.Cfg.Templates["skeleton_knight"], 1200, 800)
	knight.AI = nil
	knight.SetTarget(player.ID)
	world.Combat.RaiseBlock(knight, true, 0)
	knight.ParryUntil = 0
	slash := world.State.Cfg.Skills["slash"]
	hits := 0
	for knight.Blocking && hits < 100 {
		strikeNow(t, world, player, slash, knight.ID)
		hits++
	}
	if hits < 10 {
		t.Fatalf("the knight's guard should take many slashes, broke after %d", hits)
	}
	if knight.Blocking || knight.StunUntil-world.State.Now() < 2000 {
		t.Fatalf("the guard break should stun 2s, stun left %d", knight.StunUntil-world.State.Now())
	}
}

// 玩家举盾对着别的骷髅时，另一只骷髅兵会绕到盾挡不到的侧面去打。
func TestSoldierFlanksTheShield(t *testing.T) {
	world := coverWorld(t)
	player := joinAt(world, 1000, 800).Player
	player.HP = player.Attr.MaxHP * 100
	player.Attr.MaxHP = player.HP
	decoy := world.Spawn.Template(world.State.Cfg.Templates["skeleton_soldier"], 1070, 800)
	decoy.AI = nil
	soldier := world.Spawn.Template(world.State.Cfg.Templates["skeleton_soldier"], 1100, 830)
	soldier.SetTarget(player.ID)
	player.SetTarget(decoy.ID)
	world.Combat.RaiseBlock(player, true, 1)
	if !world.Combat.ShieldCovers(player, soldier) {
		t.Fatal("the soldier should start in front of the shield")
	}
	for range 60 {
		world.tick()
		player.SetBlocking(true)
		if !world.Combat.ShieldCovers(player, soldier) {
			return
		}
	}
	t.Fatalf("the soldier should walk around the shield, now at (%.0f, %.0f)", soldier.X, soldier.Y)
}
