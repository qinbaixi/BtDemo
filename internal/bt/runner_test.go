package bt

import (
	"math/rand"
	"testing"
)

// raw 按 owl-bt 为 Go 写出的格式构建导出数据。
func entry(id int, typ, sub string, kv ...any) map[string]any {
	node := map[string]any{"node_id": id, "type": typ, "sub_type": sub}
	for i := 0; i < len(kv); i += 2 {
		node[kv[i].(string)] = kv[i+1]
	}
	return node
}

type agent struct {
	cond    bool
	calls   map[string]int
	runFor  int // "walk" 保持运行的 tick 数
	walked  int
	service int
}

func newReg() *Registry {
	registry := NewRegistry()
	registry.Condition("flag", func(ctx *Ctx) bool { return ctx.Agent.(*agent).cond })
	registry.Task("ok", func(ctx *Ctx) Status { ctx.Agent.(*agent).calls["ok"]++; return Success })
	registry.Task(
		"fail",
		func(ctx *Ctx) Status { ctx.Agent.(*agent).calls["fail"]++; return Failure },
	)
	registry.Task("walk", func(ctx *Ctx) Status {
		testAgent := ctx.Agent.(*agent)
		if ctx.Fresh {
			testAgent.calls["walk-start"]++
			ctx.Mem["left"] = testAgent.runFor
		}
		left := ctx.Mem["left"].(int) - 1
		ctx.Mem["left"] = left
		testAgent.walked++
		if left > 0 {
			return Running
		}
		return Success
	})
	registry.Service("ping", func(ctx *Ctx) { ctx.Agent.(*agent).service++ })
	return registry
}

func load(t *testing.T, raw map[int]map[string]any) *Tree {
	t.Helper()
	tree, err := Load("test", 1, raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := tree.Validate(newReg()); err != nil {
		t.Fatal(err)
	}
	return tree
}

func newAgent() *agent { return &agent{calls: map[string]int{}} }

func TestSequenceResumesRunningChild(t *testing.T) {
	tree := load(t, map[int]map[string]any{
		1: entry(1, "composite", "sequence", "children", []int{2, 3}),
		2: entry(2, "task", "walk", "properties", map[string]any{}),
		3: entry(3, "task", "ok", "properties", map[string]any{}),
	})
	testAgent := newAgent()
	testAgent.runFor = 3
	instance := NewInstance(tree, newReg(), testAgent, rand.New(rand.NewSource(1)))
	for i := 0; i < 2; i++ {
		if status := instance.Tick(float64(i)); status != Running {
			t.Fatalf("tick %d: %v", i, status)
		}
	}
	if status := instance.Tick(2); status != Success {
		t.Fatalf("want success, got %v", status)
	}
	if testAgent.calls["walk-start"] != 1 || testAgent.calls["ok"] != 1 {
		t.Fatalf("calls %v", testAgent.calls)
	}
}

func TestSelectorInterruptsLowerPriority(t *testing.T) {
	tree := load(t, map[int]map[string]any{
		1: entry(1, "composite", "selector", "children", []int{3, 4}),
		2: entry(2, "decorator", "flag", "inverse_check_condition", false),
		3: entry(3, "task", "ok", "decorators", []int{2}, "properties", map[string]any{}),
		4: entry(4, "task", "walk", "properties", map[string]any{}),
	})
	testAgent := newAgent()
	testAgent.runFor = 100
	instance := NewInstance(tree, newReg(), testAgent, rand.New(rand.NewSource(1)))
	instance.Tick(0)
	instance.Tick(1)
	if instance.Active != "walk" || testAgent.calls["walk-start"] != 1 {
		t.Fatalf("active %q calls %v", instance.Active, testAgent.calls)
	}
	testAgent.cond = true
	if status := instance.Tick(2); status != Success || testAgent.calls["ok"] != 1 {
		t.Fatalf("higher priority branch did not run: %v %v", status, testAgent.calls)
	}
	testAgent.cond = false
	instance.Tick(3)
	if testAgent.calls["walk-start"] != 2 {
		t.Fatalf("interrupted walk should restart fresh, calls %v", testAgent.calls)
	}
}

func TestInverseConditionAndCooldown(t *testing.T) {
	tree := load(t, map[int]map[string]any{
		1: entry(1, "composite", "selector", "children", []int{4}),
		2: entry(2, "decorator", "flag", "inverse_check_condition", true),
		3: entry(
			3,
			"decorator",
			"cooldown",
			"inverse_check_condition",
			false,
			"properties",
			map[string]any{"Seconds": 5},
		),
		4: entry(4, "task", "ok", "decorators", []int{2, 3}, "properties", map[string]any{}),
	})
	testAgent := newAgent()
	instance := NewInstance(tree, newReg(), testAgent, rand.New(rand.NewSource(1)))
	if status := instance.Tick(0); status != Success {
		t.Fatalf("inverse of false should pass, got %v", status)
	}
	if status := instance.Tick(1); status != Failure {
		t.Fatalf("cooldown should block, got %v", status)
	}
	if status := instance.Tick(5); status != Success {
		t.Fatalf("cooldown should be over, got %v", status)
	}
	testAgent.cond = true
	if status := instance.Tick(20); status != Failure {
		t.Fatalf("inverse of true should fail, got %v", status)
	}
}

func TestServiceInterval(t *testing.T) {
	tree := load(t, map[int]map[string]any{
		1: entry(1, "composite", "sequence", "children", []int{3}, "services", []int{2}),
		2: entry(2, "service", "ping", "time_between_ticks", 0.5),
		3: entry(3, "task", "walk", "properties", map[string]any{}),
	})
	testAgent := newAgent()
	testAgent.runFor = 1000
	instance := NewInstance(tree, newReg(), testAgent, rand.New(rand.NewSource(1)))
	for i := 0; i < 20; i++ {
		instance.Tick(float64(i) * 0.1)
	}
	if testAgent.service != 4 { // 时刻 t = 0、0.5、1.0、1.5
		t.Fatalf("service ran %d times", testAgent.service)
	}
}

func TestParallelAndRandomSelector(t *testing.T) {
	tree := load(t, map[int]map[string]any{
		1: entry(
			1,
			"composite",
			"parallel",
			"children",
			[]int{2, 3},
			"properties",
			map[string]any{"Policy": "RequireOne"},
		),
		2: entry(2, "task", "walk", "properties", map[string]any{}),
		3: entry(3, "composite", "random_selector", "children", []int{4, 5}),
		4: entry(4, "task", "fail", "properties", map[string]any{}),
		5: entry(5, "task", "fail", "properties", map[string]any{}),
	})
	testAgent := newAgent()
	testAgent.runFor = 2
	instance := NewInstance(tree, newReg(), testAgent, rand.New(rand.NewSource(1)))
	if status := instance.Tick(0); status != Running {
		t.Fatalf("want running, got %v", status)
	}
	if status := instance.Tick(1); status != Success {
		t.Fatalf("want success, got %v", status)
	}
	if testAgent.calls["fail"] != 2 {
		t.Fatalf("random selector should try both children once, calls %v", testAgent.calls)
	}
}

func TestValidateUnknownHandler(t *testing.T) {
	tree, err := Load("x", 1, map[int]map[string]any{1: entry(1, "task", "nope")})
	if err != nil {
		t.Fatal(err)
	}
	if tree.Validate(newReg()) == nil {
		t.Fatal("expected error for unknown task")
	}
	if _, err := Load("x", 1, map[int]map[string]any{1: entry(1, "composite", "sequence", "children", []int{9})}); err == nil {
		t.Fatal("expected error for missing child")
	}
}

func TestForceSuccessCoversBlockedCondition(t *testing.T) {
	tree := load(t, map[int]map[string]any{
		1: entry(1, "composite", "sequence", "children", []int{4, 5}),
		2: entry(
			2,
			"decorator",
			"cooldown",
			"inverse_check_condition",
			false,
			"properties",
			map[string]any{"Seconds": 10},
		),
		3: entry(3, "decorator", "force_success", "inverse_check_condition", false),
		4: entry(4, "task", "ok", "decorators", []int{2, 3}, "properties", map[string]any{}),
		5: entry(5, "task", "fail", "properties", map[string]any{}),
	})
	testAgent := newAgent()
	instance := NewInstance(tree, newReg(), testAgent, rand.New(rand.NewSource(1)))
	instance.Tick(0)
	instance.Tick(1) // "ok" 仍在冷却中，但序列必须仍能执行到 "fail"
	if testAgent.calls["ok"] != 1 || testAgent.calls["fail"] != 2 {
		t.Fatalf("calls %v", testAgent.calls)
	}
}

func TestTraceRecordsVisitedNodes(t *testing.T) {
	tree := load(t, map[int]map[string]any{
		1: entry(1, "composite", "selector", "children", []int{3, 4}),
		2: entry(2, "decorator", "flag", "inverse_check_condition", false),
		3: entry(3, "task", "ok", "decorators", []int{2}, "properties", map[string]any{}),
		4: entry(4, "task", "walk", "properties", map[string]any{}),
	})
	testAgent := newAgent()
	testAgent.runFor = 100
	instance := NewInstance(tree, newReg(), testAgent, rand.New(rand.NewSource(1)))
	instance.Tick(0)
	if len(instance.Trace) != 0 {
		t.Fatalf("trace recorded while off: %v", instance.Trace)
	}
	instance.Tracing = true
	instance.Tick(1)
	want := []struct {
		id, depth int
		status    Status
		note      string
	}{{1, 0, Running, ""}, {3, 1, Failure, "blocked:flag"}, {4, 1, Running, ""}}
	if len(instance.Trace) != len(want) {
		t.Fatalf("trace %+v", instance.Trace)
	}
	for i, expect := range want {
		step := instance.Trace[i]
		note := ""
		if len(step.Notes) > 0 {
			note = step.Notes[0]
		}
		if step.Node.ID != expect.id || step.Depth != expect.depth ||
			step.Status != expect.status ||
			note != expect.note {
			t.Fatalf(
				"step %d: got %d/%d/%v/%q want %+v",
				i,
				step.Node.ID,
				step.Depth,
				step.Status,
				note,
				expect,
			)
		}
	}
}

func TestTraceRecordsChecksAndExplanations(t *testing.T) {
	tree := load(t, map[int]map[string]any{
		1: entry(1, "composite", "selector", "children", []int{3, 4}),
		2: entry(2, "decorator", "flag", "inverse_check_condition", true),
		3: entry(3, "task", "ok", "decorators", []int{2}, "properties", map[string]any{}),
		4: entry(4, "task", "walk", "properties", map[string]any{}),
	})
	reg := newReg()
	reg.Condition(
		"flag",
		func(ctx *Ctx) bool {
			cond := ctx.Agent.(*agent).cond
			ctx.Explain("flag=%v", cond)
			return cond
		},
	)
	reg.Task("walk", func(ctx *Ctx) Status { ctx.Explain("walking"); return Running })
	testAgent := newAgent()
	testAgent.cond = true
	instance := NewInstance(tree, reg, testAgent, rand.New(rand.NewSource(1)))
	instance.Tracing = true
	instance.Tick(0)
	// 条件本身为真，取反后不通过；依据记在这次检查上
	checks := instance.Trace[1].Checks
	if len(checks) != 1 || checks[0].Node.ID != 2 || checks[0].Pass ||
		checks[0].Why != "flag=true" {
		t.Fatalf("checks %+v", checks)
	}
	if why := instance.Trace[2].Why; len(why) != 1 || why[0] != "walking" ||
		!instance.Trace[2].Fresh {
		t.Fatalf("task step %+v", instance.Trace[2])
	}
	instance.Tick(1)
	if instance.Trace[2].Fresh {
		t.Fatal("running task should not be fresh on the second tick")
	}
	// 不追踪时 Explain 什么都不做
	instance.Tracing = false
	instance.Tick(2)
}
