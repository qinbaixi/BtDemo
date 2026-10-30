package game

import (
	"errors"
	"testing"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/combat"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// coverWorld 是随附配置、没有刷怪的世界，(1000, 400) 立着一块半径 30 的墓碑。
func coverWorld(t *testing.T) *World {
	t.Helper()
	cfg, err := config.Load("../../config", TreeNames())
	if err != nil {
		t.Fatal(err)
	}
	cfg.Spawns = nil
	cfg.World.HealZones = nil
	cfg.World.Map.Width, cfg.World.Map.Height = 2400, 1600
	tombstone := nav.Shape{Kind: nav.Circle, A: nav.Vec{X: 1000, Y: 400}, Radius: 30}
	world, err := newWorld(cfg, 1, []nav.Shape{tombstone})
	if err != nil {
		t.Fatal(err)
	}
	return world
}

// 墓碑挡在中间时射不出箭；走出来就能射。
func TestArrowNeedsSight(t *testing.T) {
	world := coverWorld(t)
	player := joinAt(world, 1100, 400).Player
	archer := world.Spawn.Template(world.State.Cfg.Templates["skeleton_archer"], 880, 400)
	archer.AI = nil
	arrow := world.State.Cfg.Skills["arrow"]
	if err := world.Combat.Cast(archer, arrow, player.ID); !errors.Is(err, combat.ErrNoSight) {
		t.Fatalf("shooting through the tombstone: %v", err)
	}
	player.X, player.Y = 1060, 560
	world.Grid.Moved(player)
	if err := world.Combat.Cast(archer, arrow, player.ID); err != nil {
		t.Fatalf("shooting in the open: %v", err)
	}
}

// 箭飞到半路，目标躲到墓碑后面：打在墓碑上，不掉血，发 COVER 事件。
func TestShotHitsCoverMidFlight(t *testing.T) {
	world := coverWorld(t)
	player := joinAt(world, 1060, 560).Player
	archer := world.Spawn.Template(world.State.Cfg.Templates["skeleton_archer"], 880, 400)
	archer.AI = nil
	if err := world.Combat.Cast(archer, world.State.Cfg.Skills["arrow"], player.ID); err != nil {
		t.Fatal(err)
	}
	player.X, player.Y = 1100, 400
	world.Grid.Moved(player)
	world.State.Events.Clear()
	landWindup(world, archer)
	if player.HP < player.Attr.MaxHP {
		t.Fatal("the tombstone should take the arrow")
	}
	covered := false
	for _, event := range eventsOf(world, pb.EventKind_DAMAGE) {
		covered = covered || event.GetResult() == pb.HitResult_COVER
	}
	if !covered {
		t.Fatal("expected a COVER damage event")
	}
}

// 骷髅弓手看不见人时横着挪，找到看得见的位置再射。
func TestArcherFindsAShotSpot(t *testing.T) {
	world := coverWorld(t)
	player := joinAt(world, 1100, 400).Player
	archer := world.Spawn.Template(world.State.Cfg.Templates["skeleton_archer"], 880, 400)
	archer.SetTarget(player.ID)
	stepFor(world, 4000)
	if !world.Combat.HasSight(archer, player) && player.HP >= player.Attr.MaxHP {
		t.Fatalf("the archer stayed behind the tombstone at (%.0f, %.0f)", archer.X, archer.Y)
	}
	if player.HP >= player.Attr.MaxHP {
		t.Fatal("the archer should have found a spot and shot")
	}
}
