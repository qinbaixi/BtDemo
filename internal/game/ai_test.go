package game

import (
	"testing"

	"github.com/qinbaixi/BtDemo/internal/bt"
)

// aiInstance loads raw as a tree for e, checks that every node has a handler, and returns a runnable instance.
func aiInstance(t *testing.T, w *World, e *Entity, raw map[int]map[string]any) *bt.Instance {
	t.Helper()
	tr, err := bt.Load("test", 1, raw)
	if err != nil {
		t.Fatal(err)
	}
	reg := bt.NewRegistry()
	w.RegisterAI(reg)
	if err := tr.Validate(reg); err != nil {
		t.Fatal(err)
	}
	return bt.NewInstance(tr, reg, &Agent{W: w, E: e}, w.Rand)
}

// tickAI advances the world clock by one tick and ticks inst.
func tickAI(w *World, inst *bt.Instance) bt.Status {
	w.Now += w.Dt
	return inst.Tick(w.Now)
}

// condHolds reports whether the condition sub (with props) passes for e. It hangs the
// condition on a Wait(0) under a selector, so Success means the condition held.
func condHolds(t *testing.T, w *World, e *Entity, sub string, props map[string]any) bool {
	t.Helper()
	inst := aiInstance(t, w, e, map[int]map[string]any{
		1: {"node_id": 1, "type": "composite", "sub_type": "selector", "children": []int{2}},
		2: {"node_id": 2, "type": "task", "sub_type": "wait", "decorators": []int{3}, "properties": map[string]any{"Seconds": 0}},
		3: {"node_id": 3, "type": "decorator", "sub_type": sub, "properties": props},
	})
	return tickAI(w, inst) == bt.Success
}

func TestFindTargetAndChase(t *testing.T) {
	w := testWorld()
	m := addTestEntity(w, 1, "monster", 500, 500, monsterBase)
	p := addTestEntity(w, 2, "player", 600, 500, playerBase) // edge distance 68
	inst := aiInstance(t, w, m, map[int]map[string]any{
		1: {"node_id": 1, "type": "composite", "sub_type": "selector", "children": []int{2, 4}},
		2: {"node_id": 2, "type": "task", "sub_type": "chase_target", "decorators": []int{3}, "properties": map[string]any{"StopRange": 40}},
		3: {"node_id": 3, "type": "decorator", "sub_type": "has_target"},
		4: {"node_id": 4, "type": "task", "sub_type": "find_target", "properties": map[string]any{"Range": 300}},
	})

	if st := tickAI(w, inst); st != bt.Success || m.Target != p.ID {
		t.Fatalf("first tick: status %v, target %d; want success, target %d", st, m.Target, p.ID)
	}
	prev := Dist(m, p)
	for i := 0; ; i++ {
		if i > 200 {
			t.Fatalf("chase did not reach stop range, edge distance %v", EdgeDist(m, p))
		}
		st := tickAI(w, inst)
		if st == bt.Success {
			break
		}
		if st != bt.Running {
			t.Fatalf("tick %d: status %v, want running while chasing", i, st)
		}
		if d := Dist(m, p); d > prev+1e-9 {
			t.Fatalf("tick %d: monster moved away, distance %v -> %v", i, prev, d)
		} else {
			prev = d
		}
	}
	if EdgeDist(m, p) > 40 {
		t.Errorf("edge distance %v after chase, want <= 40", EdgeDist(m, p))
	}
	if Dist(m, p) >= 100 {
		t.Errorf("distance %v, want closer than the start (100)", Dist(m, p))
	}
}

func TestFindTargetIgnoresFarPlayer(t *testing.T) {
	w := testWorld()
	m := addTestEntity(w, 1, "monster", 500, 500, monsterBase)
	addTestEntity(w, 2, "player", 900, 900, playerBase) // distance 565, out of range 300
	inst := aiInstance(t, w, m, map[int]map[string]any{
		1: {"node_id": 1, "type": "composite", "sub_type": "selector", "children": []int{2}},
		2: {"node_id": 2, "type": "task", "sub_type": "find_target", "properties": map[string]any{"Range": 300}},
	})
	if st := tickAI(w, inst); st != bt.Failure || m.Target != 0 {
		t.Errorf("status %v, target %d; want failure, target 0", st, m.Target)
	}
}

func TestWaitRunsThenSucceeds(t *testing.T) {
	w := testWorld()
	m := addTestEntity(w, 1, "monster", 500, 500, monsterBase)
	inst := aiInstance(t, w, m, map[int]map[string]any{
		1: {"node_id": 1, "type": "composite", "sub_type": "selector", "children": []int{2}},
		2: {"node_id": 2, "type": "task", "sub_type": "wait", "properties": map[string]any{"Seconds": 1}},
	})
	running := 0
	for st := tickAI(w, inst); st != bt.Success; st = tickAI(w, inst) {
		if st != bt.Running {
			t.Fatalf("after %d running ticks: status %v, want running", running, st)
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
	w := testWorld()
	m := addTestEntity(w, 1, "monster", 500, 500, monsterBase)
	props := map[string]any{"Percent": 50}
	if condHolds(t, w, m, "hp_below", props) {
		t.Error("full HP: hp_below 50 should not hold")
	}
	m.HP = m.Attr.MaxHP * 0.4
	if !condHolds(t, w, m, "hp_below", props) {
		t.Error("40% HP: hp_below 50 should hold")
	}
}

func TestFarFromHomeCondition(t *testing.T) {
	w := testWorld()
	m := addTestEntity(w, 1, "monster", 500, 500, monsterBase)
	props := map[string]any{"Distance": 400}
	if condHolds(t, w, m, "far_from_home", props) {
		t.Error("at home: far_from_home should not hold")
	}
	m.X = 950 // 450 from home
	if !condHolds(t, w, m, "far_from_home", props) {
		t.Error("450 from home: far_from_home 400 should hold")
	}
}

func TestFleeMovesAwayFromAttacker(t *testing.T) {
	w := testWorld()
	m := addTestEntity(w, 1, "monster", 500, 500, monsterBase)
	p := addTestEntity(w, 2, "player", 560, 500, playerBase)
	m.LastAttacker, m.LastHitAt = p.ID, w.Now
	inst := aiInstance(t, w, m, map[int]map[string]any{
		1: {"node_id": 1, "type": "composite", "sub_type": "selector", "children": []int{2}},
		2: {"node_id": 2, "type": "task", "sub_type": "flee", "properties": map[string]any{"Distance": 160}},
	})
	before := Dist(m, p)
	st := bt.Running
	for i := 0; i < 200 && st == bt.Running; i++ {
		st = tickAI(w, inst)
	}
	if st != bt.Success {
		t.Fatalf("flee ended with %v, want success", st)
	}
	if after := Dist(m, p); after < before+100 {
		t.Errorf("distance from attacker %v -> %v, want it to grow by about 160", before, after)
	}
}

func TestReturnHomeRestoresHP(t *testing.T) {
	w := testWorld()
	m := addTestEntity(w, 1, "monster", 500, 500, monsterBase)
	m.X = 600 // 100 from home
	m.HP = 5
	m.Target = 99
	inst := aiInstance(t, w, m, map[int]map[string]any{
		1: {"node_id": 1, "type": "composite", "sub_type": "selector", "children": []int{2}},
		2: {"node_id": 2, "type": "task", "sub_type": "return_home"},
	})
	st := bt.Running
	for i := 0; i < 200 && st == bt.Running; i++ {
		st = tickAI(w, inst)
	}
	if st != bt.Success {
		t.Fatalf("return_home ended with %v, want success", st)
	}
	if m.HP != m.Attr.MaxHP {
		t.Errorf("HP = %v, want MaxHP %v", m.HP, m.Attr.MaxHP)
	}
	if m.Target != 0 {
		t.Errorf("target = %d, want 0", m.Target)
	}
	if m.X != 500 || m.Y != 500 {
		t.Errorf("position (%v, %v), want home (500, 500)", m.X, m.Y)
	}
}

func TestCastSkillUsesSlotAndTarget(t *testing.T) {
	w := testWorld()
	m := addTestEntity(w, 1, "monster", 500, 500, monsterBase)
	m.Skills = append(m.Skills, slashSkill())
	p := addTestEntity(w, 2, "player", 560, 500, playerBase) // edge distance 28, within range 70
	m.Target = p.ID
	cast := func(slot int) bt.Status {
		return tickAI(w, aiInstance(t, w, m, map[int]map[string]any{
			1: {"node_id": 1, "type": "composite", "sub_type": "selector", "children": []int{2}},
			2: {"node_id": 2, "type": "task", "sub_type": "cast_skill", "properties": map[string]any{"Slot": slot}},
		}))
	}
	if st := cast(2); st != bt.Failure {
		t.Errorf("slot 2 (none configured): status %v, want failure", st)
	}
	if st := cast(1); st != bt.Success {
		t.Fatalf("slot 1: status %v, want success", st)
	}
	if p.HP >= p.Attr.MaxHP {
		t.Errorf("player HP %v, want less than MaxHP %v after the slash", p.HP, p.Attr.MaxHP)
	}
}

func TestUpdateTargetPrefersRecentAttacker(t *testing.T) {
	w := testWorld()
	m := addTestEntity(w, 1, "monster", 500, 500, monsterBase)
	near := addTestEntity(w, 2, "player", 540, 500, playerBase)
	far := addTestEntity(w, 3, "player", 650, 500, playerBase)
	inst := aiInstance(t, w, m, map[int]map[string]any{
		1: {"node_id": 1, "type": "composite", "sub_type": "selector", "children": []int{2}, "services": []int{3}},
		2: {"node_id": 2, "type": "task", "sub_type": "wait", "properties": map[string]any{"Seconds": 0}},
		3: {"node_id": 3, "type": "service", "sub_type": "update_target", "properties": map[string]any{"Range": 250}},
	})

	m.LastAttacker, m.LastHitAt = far.ID, w.Now
	tickAI(w, inst)
	if m.Target != far.ID {
		t.Errorf("after a recent hit: target %d, want attacker %d", m.Target, far.ID)
	}

	m.Target = 0
	m.LastHitAt = -100 // hit long ago, so the nearest hostile wins
	tickAI(w, inst)
	if m.Target != near.ID {
		t.Errorf("after an old hit: target %d, want nearest %d", m.Target, near.ID)
	}
}
