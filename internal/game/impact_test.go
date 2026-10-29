package game

import (
	"github.com/qinbaixi/BtDemo/internal/config"
	"testing"

	"github.com/qinbaixi/BtDemo/internal/game/combat"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// eventsOf 是队列里种类为 kind 的事件。
func eventsOf(world *World, kind pb.EventKind) []*pb.Event {
	return queuedEvents(world, kind, "")
}

func TestWindupDelaysTheHit(t *testing.T) {
	world := gearWorld(t)
	player := joinAt(world, 1500, 400).Player
	ogre := world.Spawn.Template(world.State.Cfg.Templates["ogre_chief"], 1560, 400)
	ogre.AI = nil // 只测出招本身，不让行为树自己再放技能
	smash := world.State.Cfg.Skills["smash"]
	world.State.Events.Clear()
	if err := world.Combat.Cast(ogre, smash, player.ID); err != nil {
		t.Fatal(err)
	}
	casts := eventsOf(world, pb.EventKind_CAST)
	if len(casts) != 1 || casts[0].GetHitAt() <= world.State.Now() || casts[0].GetWeight() != "heavy" {
		t.Fatalf("cast events %v", casts)
	}
	if player.HP < player.Attr.MaxHP || len(eventsOf(world, pb.EventKind_DAMAGE)) != 0 {
		t.Fatal("hit landed before the windup ended")
	}
	if err := world.Combat.Cast(ogre, smash, player.ID); err != combat.ErrBusy {
		t.Fatalf("second cast during windup: %v", err)
	}
	stepFor(world, smash.Windup+100)
	if player.HP >= player.Attr.MaxHP {
		t.Fatal("hit never landed")
	}
}

func TestWindupMissesWhenTargetEscapes(t *testing.T) {
	world := gearWorld(t)
	player := joinAt(world, 1500, 400).Player
	ogre := world.Spawn.Template(world.State.Cfg.Templates["ogre_chief"], 1560, 400)
	ogre.AI = nil
	if err := world.Combat.Cast(ogre, world.State.Cfg.Skills["smash"], player.ID); err != nil {
		t.Fatal(err)
	}
	player.SetPos(1300, 400) // 前摇期间翻滚躲开
	world.Grid.Moved(player)
	landWindup(world, ogre)
	if player.HP < player.Attr.MaxHP {
		t.Fatal("hit landed on a target that ran away")
	}
}

func TestHitKnocksBackAndStuns(t *testing.T) {
	world := gearWorld(t)
	player := joinAt(world, 1500, 400).Player
	slime := world.Spawn.Template(world.State.Cfg.Templates["slime"], 1540, 400)
	slime.AI = nil
	slime.Attr.MaxHP, slime.HP = 10000, 10000
	whirlwind := world.State.Cfg.Skills["whirlwind"]
	world.State.Events.Clear()
	if err := world.Combat.Cast(player, whirlwind, 0); err != nil {
		t.Fatal(err)
	}
	landWindup(world, player)
	damage := eventsOf(world, pb.EventKind_DAMAGE)
	if len(damage) != 1 || damage[0].GetStun() <= 0 || damage[0].GetKx() <= 1540 {
		t.Fatalf("damage events %v", damage)
	}
	// 重击 50 像素 ÷ 史莱姆重量 0.8（8000 万分比）
	want := 1540 + 50/0.8
	stepFor(world, world.State.Cfg.World.Hit.KnockTime+50)
	if slime.Knock != nil || slime.X < want-1 || slime.X > want+1 {
		t.Fatalf("slime at %.1f (knock %v), want %.1f", slime.X, slime.Knock, want)
	}
	if !slime.Stunned(world.State.Now()) && damage[0].GetStun() > 250 {
		t.Fatal("slime not stunned")
	}
}

func TestPoiseResistsLightHits(t *testing.T) {
	world := gearWorld(t)
	player := joinAt(world, 1500, 400).Player
	ogre := world.Spawn.Template(world.State.Cfg.Templates["ogre_chief"], 1560, 400)
	ogre.AI = nil
	ogre.Attr.MaxHP, ogre.HP = 100000, 100000
	whirlwind := world.State.Cfg.Skills["whirlwind"]
	// 韧性 120，旋风斩每下打掉 45：前两下扛住，第三下打空
	for hit := 1; hit <= 3; hit++ {
		player.Cooldowns = map[string]config.Millis{}
		world.State.Events.Clear()
		if err := world.Combat.Cast(player, whirlwind, 0); err != nil {
			t.Fatal(err)
		}
		landWindup(world, player)
		staggered := ogre.Knock != nil || ogre.Stunned(world.State.Now())
		if staggered != (hit == 3) {
			t.Fatalf("hit %d: staggered = %v", hit, staggered)
		}
	}
}

func TestStaggerInterruptsWindup(t *testing.T) {
	world := gearWorld(t)
	player := joinAt(world, 1500, 400).Player
	slime := world.Spawn.Template(world.State.Cfg.Templates["slime"], 1540, 400)
	slime.AI = nil
	slime.Attr.MaxHP, slime.HP = 10000, 10000
	if err := world.Combat.Cast(slime, world.State.Cfg.Skills["bite"], player.ID); err != nil {
		t.Fatal(err)
	}
	world.State.Events.Clear()
	if err := world.Combat.Cast(player, player.Skills[0], slime.ID); err != nil {
		t.Fatal(err)
	}
	interrupts := eventsOf(world, pb.EventKind_INTERRUPT)
	if slime.Windup != nil || len(interrupts) != 1 || interrupts[0].GetId() != int32(slime.ID) {
		t.Fatalf("windup %v, interrupt events %v", slime.Windup, interrupts)
	}
	if err := world.Combat.Cast(slime, world.State.Cfg.Skills["heavy_bite"], player.ID); err != combat.ErrStunned {
		t.Fatalf("cast while stunned: %v", err)
	}
	stepFor(world, 1000)
	if player.HP < player.Attr.MaxHP {
		t.Fatal("interrupted bite still landed")
	}
}

func TestKnockStopsAtTheMapEdge(t *testing.T) {
	world := gearWorld(t)
	player := joinAt(world, 60, 400).Player
	slime := world.Spawn.Template(world.State.Cfg.Templates["slime"], 30, 400)
	slime.AI = nil
	slime.Attr.MaxHP, slime.HP = 10000, 10000
	slime.SetPos(20, 400)
	world.Grid.Moved(slime)
	world.State.Events.Clear()
	if err := world.Combat.Cast(player, world.State.Cfg.Skills["whirlwind"], 0); err != nil {
		t.Fatal(err)
	}
	landWindup(world, player)
	damage := eventsOf(world, pb.EventKind_DAMAGE)
	if len(damage) != 1 || !damage[0].GetWall() {
		t.Fatalf("damage events %v", damage)
	}
	hit := world.State.Cfg.World.Hit
	if int64(damage[0].GetStun()) < hit.Weights["heavy"].Stun+hit.WallStun {
		t.Fatalf("wall slam stun %v", damage[0].GetStun())
	}
}

func TestBlockedHitDoesNotStun(t *testing.T) {
	world := gearWorld(t)
	player := joinAt(world, 1500, 400).Player
	player.Blocking = true
	monster := world.Spawn.Template(world.State.Cfg.Templates["ogre_chief"], 1560, 400)
	monster.AI = nil
	if err := world.Combat.Cast(monster, world.State.Cfg.Skills["smash"], player.ID); err != nil {
		t.Fatal(err)
	}
	world.State.Events.Clear()
	landWindup(world, monster)
	damage := eventsOf(world, pb.EventKind_DAMAGE)
	if len(damage) != 1 || damage[0].GetStun() != 0 || player.Stunned(world.State.Now()) {
		t.Fatalf("blocked hit: %v", damage)
	}
}
