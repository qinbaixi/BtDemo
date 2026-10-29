package game

import (
	"testing"

	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// guardSetup 放一个朝右举盾的骑士和它右边的一只食人魔首领（不让行为树自己出招），
// 时钟先走一会儿，保证第一次举盾就有完美格挡窗口。
func guardSetup(t *testing.T) (*World, *core.Entity, *core.Entity) {
	world := gearWorld(t)
	player := joinAt(world, 1500, 400).Player
	ogre := world.Spawn.Template(world.State.Cfg.Templates["ogre_chief"], 1560, 400)
	ogre.AI = nil
	stepFor(world, 0.5)
	return world, player, ogre
}

// landSmash 让 ogre 对 player 放一记重锤，在命中前 beforeHit 秒做 raise，然后结算，返回这一下的 DAMAGE 事件。
func landSmash(t *testing.T, world *World, ogre, player *core.Entity, raise func(), beforeHit float64) *pb.Event {
	t.Helper()
	smash := world.State.Cfg.Skills["smash"]
	if err := world.Combat.Cast(ogre, smash, player.ID); err != nil {
		t.Fatal(err)
	}
	if beforeHit > 0 {
		raise()
		stepFor(world, beforeHit-world.State.Clock.Dt/2)
	} else {
		raise()
	}
	world.State.Events.Clear()
	landWindup(world, ogre)
	damage := eventsOf(world, pb.EventKind_DAMAGE)
	if len(damage) != 1 {
		t.Fatalf("damage events %v", damage)
	}
	return damage[0]
}

func TestParryRepelsTheAttacker(t *testing.T) {
	world, player, ogre := guardSetup(t)
	raise := func() { world.Combat.RaiseBlock(player, true, 1) }
	damage := landSmash(t, world, ogre, player, raise, 0)
	if damage.GetResult() != pb.HitResult_PARRY || damage.GetValue() != 0 || player.HP < player.Attr.MaxHP {
		t.Fatalf("parry: %v, hp %.0f/%.0f", damage, player.HP, player.Attr.MaxHP)
	}
	if player.GuardSpent != 0 || player.Stunned(world.State.Now()) {
		t.Fatalf("parry cost guard %.2f or stunned the blocker", player.GuardSpent)
	}
	// 攻击者被弹开（往右），而且不管韧性多高都硬直
	if ogre.Knock == nil || ogre.Knock.To.X <= 1560 || !ogre.Stunned(world.State.Now()) {
		t.Fatalf("ogre knock %v, stunned %v", ogre.Knock, ogre.Stunned(world.State.Now()))
	}
	if damage.GetKx() <= 1560 || damage.GetStun() <= 0 {
		t.Fatalf("parry event should describe the attacker's recoil: %v", damage)
	}
}

func TestHeldBlockCostsGuard(t *testing.T) {
	world, player, ogre := guardSetup(t)
	raise := func() { world.Combat.RaiseBlock(player, true, 1) }
	damage := landSmash(t, world, ogre, player, raise, 0.3)
	if damage.GetResult() != pb.HitResult_BLOCK || damage.GetBlocked() <= 0 {
		t.Fatalf("held block: %v", damage)
	}
	cfg := world.State.Cfg.World
	want := cfg.Hit.Weights["heavy"].Guard / cfg.Player.Block.Guard
	if player.GuardSpent < want-0.001 || player.GuardSpent > want+0.001 {
		t.Fatalf("guard spent %.3f, want %.3f", player.GuardSpent, want)
	}
	if ogre.Knock != nil || ogre.Stunned(world.State.Now()) {
		t.Fatal("a plain block repelled the attacker")
	}
}

func TestShieldOnlyCoversTheFront(t *testing.T) {
	world, player, ogre := guardSetup(t)
	// 盾朝左，食人魔在右边：照样挨打
	raise := func() { world.Combat.RaiseBlock(player, true, -1) }
	damage := landSmash(t, world, ogre, player, raise, 0)
	if damage.Result != nil || damage.GetBlocked() != 0 || player.HP >= player.Attr.MaxHP {
		t.Fatalf("hit from behind: %v", damage)
	}
}

func TestShieldFacesTheTarget(t *testing.T) {
	world, player, ogre := guardSetup(t)
	player.SetTarget(ogre.ID)
	// 举盾时朝左，但选着右边的食人魔：盾朝着目标
	raise := func() { world.Combat.RaiseBlock(player, true, -1) }
	damage := landSmash(t, world, ogre, player, raise, 0.3)
	if damage.GetResult() != pb.HitResult_BLOCK {
		t.Fatalf("block toward the target: %v", damage)
	}
}

func TestGuardBreaks(t *testing.T) {
	world, player, ogre := guardSetup(t)
	raise := func() {
		world.Combat.RaiseBlock(player, true, 1)
		player.SetGuardSpent(0.9)
		player.GuardHitAt = world.State.Now() // 不让架势在等待期间回复
	}
	damage := landSmash(t, world, ogre, player, raise, 0.3)
	if damage.GetResult() != pb.HitResult_GUARD_BREAK || player.Blocking {
		t.Fatalf("guard break: %v, blocking %v", damage, player.Blocking)
	}
	if player.Knock == nil || player.Knock.To.X >= 1500 || !player.Stunned(world.State.Now()) {
		t.Fatalf("broken guard: knock %v, stunned %v", player.Knock, player.Stunned(world.State.Now()))
	}
	// 硬直中举不起盾；硬直过了、架势回到一半以前也举不起来（不然再挨一下又被破）
	if world.Combat.RaiseBlock(player, true, 1) || player.Blocking {
		t.Fatal("raised the shield while staggered")
	}
	stepFor(world, world.State.Cfg.World.Player.Block.BreakStun+0.1)
	if world.Combat.RaiseBlock(player, true, 1) {
		t.Fatalf("raised the shield right after a guard break (spent %.2f)", player.GuardSpent)
	}
	stepFor(world, 3)
	if !world.Combat.RaiseBlock(player, true, 1) {
		t.Fatalf("cannot raise the shield after the guard recovered (spent %.2f)", player.GuardSpent)
	}
}

func TestParryWindowStopsOneHit(t *testing.T) {
	world, player, ogre := guardSetup(t)
	second := world.Spawn.Template(world.State.Cfg.Templates["ogre_chief"], 1555, 420)
	second.AI = nil
	smash := world.State.Cfg.Skills["smash"]
	for _, attacker := range []*core.Entity{ogre, second} {
		if err := world.Combat.Cast(attacker, smash, player.ID); err != nil {
			t.Fatal(err)
		}
	}
	world.Combat.RaiseBlock(player, true, 1)
	// 两锤同一瞬间砸下来：只有第一下被完美格挡，窗口用掉了
	ogre.Windup.HitAt = world.State.Now()
	second.Windup.HitAt = world.State.Now()
	world.State.Events.Clear()
	world.Combat.Tick()
	results := map[pb.HitResult]int{}
	for _, damage := range eventsOf(world, pb.EventKind_DAMAGE) {
		results[damage.GetResult()]++
	}
	if results[pb.HitResult_PARRY] != 1 || results[pb.HitResult_BLOCK] != 1 {
		t.Fatalf("results %v", results)
	}
}

func TestRangedHitsCannotBeParried(t *testing.T) {
	world := gearWorld(t)
	player := joinAt(world, 1500, 400).Player
	archer := world.Spawn.Template(world.State.Cfg.Templates["skeleton_archer"], 1700, 400)
	archer.AI = nil
	stepFor(world, 0.5)
	if err := world.Combat.Cast(archer, world.State.Cfg.Skills["arrow"], player.ID); err != nil {
		t.Fatal(err)
	}
	world.Combat.RaiseBlock(player, true, 1)
	world.State.Events.Clear()
	landWindup(world, archer)
	damage := eventsOf(world, pb.EventKind_DAMAGE)
	if len(damage) != 1 || damage[0].GetResult() != pb.HitResult_BLOCK || archer.Stunned(world.State.Now()) {
		t.Fatalf("arrow into a fresh shield: %v", damage)
	}
}

func TestParryWindowNeedsTheShieldDownFirst(t *testing.T) {
	world, player, _ := guardSetup(t)
	world.Combat.RaiseBlock(player, true, 1)
	if player.ParryUntil <= world.State.Now() {
		t.Fatal("first raise has no parry window")
	}
	world.Combat.RaiseBlock(player, false, 0)
	world.Combat.RaiseBlock(player, true, 1)
	if player.ParryUntil > world.State.Now() {
		t.Fatal("re-raising at once opened a new parry window")
	}
	world.Combat.RaiseBlock(player, false, 0)
	stepFor(world, world.State.Cfg.World.Player.Block.ParryRearm+0.05)
	world.Combat.RaiseBlock(player, true, 1)
	if player.ParryUntil <= world.State.Now() {
		t.Fatal("no parry window after the shield was down long enough")
	}
}

func TestGuardRegenerates(t *testing.T) {
	world, player, _ := guardSetup(t)
	block := world.State.Cfg.World.Player.Block
	player.SetGuardSpent(0.5)
	player.GuardHitAt = world.State.Now()
	stepFor(world, block.GuardDelay*0.5)
	if player.GuardSpent != 0.5 {
		t.Fatalf("guard regenerated during the delay: %.3f", player.GuardSpent)
	}
	stepFor(world, block.GuardDelay*0.5+0.5)
	if player.GuardSpent >= 0.5 || player.GuardSpent <= 0 {
		t.Fatalf("guard after regen: %.3f", player.GuardSpent)
	}
	stepFor(world, 3)
	if player.GuardSpent != 0 {
		t.Fatalf("guard never refilled: %.3f", player.GuardSpent)
	}
}
