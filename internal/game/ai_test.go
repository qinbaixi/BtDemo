package game

import (
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"testing"

	"github.com/qinbaixi/BtDemo/internal/bt"
)

// aiInstance 将 raw 作为 e 的行为树加载，检查每个节点都有处理器，并返回一个可运行的实例。
func aiInstance(
	t *testing.T,
	world *World,
	entity *core.Entity,
	raw map[int]map[string]any,
) *bt.Instance {
	t.Helper()
	tree, err := bt.Load("test", 1, raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := tree.Validate(world.AI.Registry()); err != nil {
		t.Fatal(err)
	}
	return world.AI.Instance(entity, tree)
}

// tickAI 将世界时钟推进一个 tick，并对 inst 执行一次 tick。
func tickAI(world *World, inst *bt.Instance) bt.Status {
	world.State.Clock.Now += world.State.Clock.Dt
	return inst.Tick(world.State.Clock.Now)
}

// condHolds 报告条件 sub（带属性 props）对 e 是否通过。它把该条件挂在 selector 下的
// Wait(0) 之上，因此 Success 即表示条件成立。
func condHolds(
	t *testing.T,
	world *World,
	entity *core.Entity,
	sub string,
	props map[string]any,
) bool {
	t.Helper()
	inst := aiInstance(t, world, entity, map[int]map[string]any{
		1: {"node_id": 1, "type": "composite", "sub_type": "selector", "children": []int{2}},
		2: {
			"node_id":    2,
			"type":       "task",
			"sub_type":   "wait",
			"decorators": []int{3},
			"properties": map[string]any{"Seconds": 0},
		},
		3: {"node_id": 3, "type": "decorator", "sub_type": sub, "properties": props},
	})
	return tickAI(world, inst) == bt.Success
}

func TestFindTargetAndChase(t *testing.T) {
	world := testWorld()
	monster := addTestEntity(world, 1, "monster", 500, 500, monsterBase)
	player := addTestEntity(world, 2, "player", 600, 500, playerBase) // 边缘距离 68
	inst := aiInstance(t, world, monster, map[int]map[string]any{
		1: {"node_id": 1, "type": "composite", "sub_type": "selector", "children": []int{2, 4}},
		2: {
			"node_id":    2,
			"type":       "task",
			"sub_type":   "chase_target",
			"decorators": []int{3},
			"properties": map[string]any{"StopRange": 40},
		},
		3: {"node_id": 3, "type": "decorator", "sub_type": "has_target"},
		4: {
			"node_id":    4,
			"type":       "task",
			"sub_type":   "find_target",
			"properties": map[string]any{"Range": 300},
		},
	})

	if status := tickAI(world, inst); status != bt.Success || monster.Target != player.ID {
		t.Fatalf(
			"first tick: status %v, target %d; want success, target %d",
			status,
			monster.Target,
			player.ID,
		)
	}
	prev := core.Dist(monster, player)
	for i := 0; ; i++ {
		if i > 200 {
			t.Fatalf(
				"chase did not reach stop range, edge distance %v",
				core.EdgeDist(monster, player),
			)
		}
		status := tickAI(world, inst)
		if status == bt.Success {
			break
		}
		if status != bt.Running {
			t.Fatalf("tick %d: status %v, want running while chasing", i, status)
		}
		if dist := core.Dist(monster, player); dist > prev+1e-9 {
			t.Fatalf("tick %d: monster moved away, distance %v -> %v", i, prev, dist)
		} else {
			prev = dist
		}
	}
	if core.EdgeDist(monster, player) > 40 {
		t.Errorf("edge distance %v after chase, want <= 40", core.EdgeDist(monster, player))
	}
	if core.Dist(monster, player) >= 100 {
		t.Errorf("distance %v, want closer than the start (100)", core.Dist(monster, player))
	}
}

func TestFindTargetIgnoresFarPlayer(t *testing.T) {
	world := testWorld()
	monster := addTestEntity(world, 1, "monster", 500, 500, monsterBase)
	addTestEntity(world, 2, "player", 900, 900, playerBase) // 距离 565，超出范围 300
	inst := aiInstance(t, world, monster, map[int]map[string]any{
		1: {"node_id": 1, "type": "composite", "sub_type": "selector", "children": []int{2}},
		2: {
			"node_id":    2,
			"type":       "task",
			"sub_type":   "find_target",
			"properties": map[string]any{"Range": 300},
		},
	})
	if status := tickAI(world, inst); status != bt.Failure || monster.Target != 0 {
		t.Errorf("status %v, target %d; want failure, target 0", status, monster.Target)
	}
}

func TestWaitRunsThenSucceeds(t *testing.T) {
	world := testWorld()
	monster := addTestEntity(world, 1, "monster", 500, 500, monsterBase)
	inst := aiInstance(t, world, monster, map[int]map[string]any{
		1: {"node_id": 1, "type": "composite", "sub_type": "selector", "children": []int{2}},
		2: {
			"node_id":    2,
			"type":       "task",
			"sub_type":   "wait",
			"properties": map[string]any{"Seconds": 1},
		},
	})
	running := 0
	for status := tickAI(world, inst); status != bt.Success; status = tickAI(world, inst) {
		if status != bt.Running {
			t.Fatalf("after %d running ticks: status %v, want running", running, status)
		}
		running++
		if running > 100 {
			t.Fatal("wait never succeeded")
		}
	}
	if running < 10 {
		t.Errorf("wait succeeded after %d running ticks, want about 20 (1s)", running)
	}
}

func TestHpBelowCondition(t *testing.T) {
	world := testWorld()
	monster := addTestEntity(world, 1, "monster", 500, 500, monsterBase)
	props := map[string]any{"Percent": 50}
	if condHolds(t, world, monster, "hp_below", props) {
		t.Error("full HP: hp_below 50 should not hold")
	}
	monster.HP = monster.Attr.MaxHP * 0.4
	if !condHolds(t, world, monster, "hp_below", props) {
		t.Error("40% HP: hp_below 50 should hold")
	}
}

func TestFarFromHomeCondition(t *testing.T) {
	world := testWorld()
	monster := addTestEntity(world, 1, "monster", 500, 500, monsterBase)
	props := map[string]any{"Distance": 400}
	if condHolds(t, world, monster, "far_from_home", props) {
		t.Error("at home: far_from_home should not hold")
	}
	monster.X = 950 // 距家 450
	if !condHolds(t, world, monster, "far_from_home", props) {
		t.Error("450 from home: far_from_home 400 should hold")
	}
}

func TestFleeMovesAwayFromAttacker(t *testing.T) {
	world := testWorld()
	monster := addTestEntity(world, 1, "monster", 500, 500, monsterBase)
	player := addTestEntity(world, 2, "player", 560, 500, playerBase)
	monster.LastAttacker, monster.LastHitAt = player.ID, world.State.Clock.Now
	inst := aiInstance(t, world, monster, map[int]map[string]any{
		1: {"node_id": 1, "type": "composite", "sub_type": "selector", "children": []int{2}},
		2: {
			"node_id":    2,
			"type":       "task",
			"sub_type":   "flee",
			"properties": map[string]any{"Distance": 160},
		},
	})
	before := core.Dist(monster, player)
	status := bt.Running
	for i := 0; i < 200 && status == bt.Running; i++ {
		status = tickAI(world, inst)
	}
	if status != bt.Success {
		t.Fatalf("flee ended with %v, want success", status)
	}
	if after := core.Dist(monster, player); after < before+100 {
		t.Errorf("distance from attacker %v -> %v, want it to grow by about 160", before, after)
	}
}

func TestReturnHomeRestoresHP(t *testing.T) {
	world := testWorld()
	monster := addTestEntity(world, 1, "monster", 500, 500, monsterBase)
	monster.X = 600 // 距家 100
	monster.HP = 5
	monster.Target = 99
	inst := aiInstance(t, world, monster, map[int]map[string]any{
		1: {"node_id": 1, "type": "composite", "sub_type": "selector", "children": []int{2}},
		2: {"node_id": 2, "type": "task", "sub_type": "return_home"},
	})
	status := bt.Running
	for i := 0; i < 200 && status == bt.Running; i++ {
		status = tickAI(world, inst)
	}
	if status != bt.Success {
		t.Fatalf("return_home ended with %v, want success", status)
	}
	if monster.HP != monster.Attr.MaxHP {
		t.Errorf("HP = %v, want MaxHP %v", monster.HP, monster.Attr.MaxHP)
	}
	if monster.Target != 0 {
		t.Errorf("target = %d, want 0", monster.Target)
	}
	if monster.X != 500 || monster.Y != 500 {
		t.Errorf("position (%v, %v), want home (500, 500)", monster.X, monster.Y)
	}
}

func TestCastSkillUsesSlotAndTarget(t *testing.T) {
	world := testWorld()
	monster := addTestEntity(world, 1, "monster", 500, 500, monsterBase)
	monster.Skills = append(monster.Skills, slashSkill())
	player := addTestEntity(world, 2, "player", 560, 500, playerBase) // 边缘距离 28，在范围 70 之内
	monster.Target = player.ID
	cast := func(slot int) bt.Status {
		return tickAI(world, aiInstance(t, world, monster, map[int]map[string]any{
			1: {"node_id": 1, "type": "composite", "sub_type": "selector", "children": []int{2}},
			2: {
				"node_id":    2,
				"type":       "task",
				"sub_type":   "cast_skill",
				"properties": map[string]any{"Slot": slot},
			},
		}))
	}
	if status := cast(2); status != bt.Failure {
		t.Errorf("slot 2 (none configured): status %v, want failure", status)
	}
	if status := cast(1); status != bt.Success {
		t.Fatalf("slot 1: status %v, want success", status)
	}
	if player.HP >= player.Attr.MaxHP {
		t.Errorf(
			"player HP %v, want less than MaxHP %v after the slash",
			player.HP,
			player.Attr.MaxHP,
		)
	}
}

func TestUpdateTargetPrefersRecentAttacker(t *testing.T) {
	world := testWorld()
	monster := addTestEntity(world, 1, "monster", 500, 500, monsterBase)
	near := addTestEntity(world, 2, "player", 540, 500, playerBase)
	far := addTestEntity(world, 3, "player", 650, 500, playerBase)
	inst := aiInstance(t, world, monster, map[int]map[string]any{
		1: {
			"node_id":  1,
			"type":     "composite",
			"sub_type": "selector",
			"children": []int{2},
			"services": []int{3},
		},
		2: {
			"node_id":    2,
			"type":       "task",
			"sub_type":   "wait",
			"properties": map[string]any{"Seconds": 0},
		},
		3: {
			"node_id":    3,
			"type":       "service",
			"sub_type":   "update_target",
			"properties": map[string]any{"Range": 250},
		},
	})

	monster.LastAttacker, monster.LastHitAt = far.ID, world.State.Clock.Now
	tickAI(world, inst)
	if monster.Target != far.ID {
		t.Errorf("after a recent hit: target %d, want attacker %d", monster.Target, far.ID)
	}

	monster.Target = 0
	monster.LastHitAt = -100 // 受击已久，因此最近的敌对目标获胜
	tickAI(world, inst)
	if monster.Target != near.ID {
		t.Errorf("after an old hit: target %d, want nearest %d", monster.Target, near.ID)
	}
}
