package game

import (
	"testing"

	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
)

// 冲锋出发时不掉血，冲到被撞的人面前才结算伤害。
func TestPounceDamageLandsOnArrival(t *testing.T) {
	client, scene, king := bossArena(t, "wolf_king", 1200, 720)
	player := client.Player
	moveTo(scene, player, 1200, 500)
	pounce := scene.State.Cfg.Skills["pounce"]
	if err := scene.Combat.Cast(king, pounce, player.ID); err != nil {
		t.Fatal(err)
	}
	landWindup(scene, king) // 冲出去
	if king.Knock == nil || king.Knock.Charge == nil {
		t.Fatal("the king should be dashing toward the player")
	}
	if player.HP < player.Attr.MaxHP {
		t.Fatal("the pounce should not hurt before the king arrives")
	}
	stepScene(scene, int(king.Knock.Duration)/50+2)
	if player.HP >= player.Attr.MaxHP {
		t.Fatal("the pounce should hurt once the king arrives")
	}
}

// 冲锋途中冲锋者被别的击退顶掉：这一下作废，被撞的人不掉血。
func TestPounceInterruptedMidwayMisses(t *testing.T) {
	client, scene, king := bossArena(t, "wolf_king", 1200, 720)
	player := client.Player
	moveTo(scene, player, 1200, 500)
	pounce := scene.State.Cfg.Skills["pounce"]
	if err := scene.Combat.Cast(king, pounce, player.ID); err != nil {
		t.Fatal(err)
	}
	landWindup(scene, king)
	stepScene(scene, 1)
	// 模拟被别人一锤打退：新的击退覆盖了冲锋的位移
	here := nav.Vec{X: king.X, Y: king.Y}
	king.Knock = &core.Knock{From: here, To: here, Start: scene.State.Now(), Duration: 100}
	stepScene(scene, 20)
	if player.HP < player.Attr.MaxHP {
		t.Fatal("an interrupted pounce should not hit")
	}
}

// 击退途中前面突然冒出障碍物（门关上）：停在障碍物前，不会被放进去。
func TestKnockStopsAtObstacleThatAppearsMidway(t *testing.T) {
	world := testWorld(nav.Shape{Kind: nav.Rect, A: nav.Vec{X: 500, Y: 0}, B: nav.Vec{X: 540, Y: 1000}})
	navMap := world.Move.Nav()
	navMap.SetSolid(0, false) // 门开着
	monster := addTestEntity(world, 2, "monster", 400, 500, monsterBase)
	now := world.State.Now()
	monster.Knock = &core.Knock{
		From:     nav.Vec{X: 400, Y: 500},
		To:       nav.Vec{X: 700, Y: 500},
		Start:    now,
		Duration: 400,
	}
	navMap.SetSolid(0, true) // 击退开始后门关上了
	for range 12 {
		world.State.Clock.Advance()
		world.Move.Tick()
	}
	if monster.Knock != nil {
		t.Fatal("the knock should end at the closed door")
	}
	if monster.X+monster.Radius > 500 {
		t.Fatalf("the monster should stop before the door, x=%.0f", monster.X)
	}
	if !navMap.Free(nav.Vec{X: monster.X, Y: monster.Y}, monster.Radius) {
		t.Fatal("the monster should not end up inside the door")
	}
}
