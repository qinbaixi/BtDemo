package bt

import (
	"math/rand"
	"testing"
)

// raw 按 owl-bt 为 Go 写出的格式构建导出数据。
func entry(id int, typ, sub string, kv ...any) map[string]any {
	e := map[string]any{"node_id": id, "type": typ, "sub_type": sub}
	for i := 0; i < len(kv); i += 2 {
		e[kv[i].(string)] = kv[i+1]
	}
	return e
}

type agent struct {
	cond    bool
	calls   map[string]int
	runFor  int // "walk" 保持运行的 tick 数
	walked  int
	service int
}

func newReg() *Registry {
	r := NewRegistry()
	r.Condition("flag", func(c *Ctx) bool { return c.Agent.(*agent).cond })
	r.Task("ok", func(c *Ctx) Status { c.Agent.(*agent).calls["ok"]++; return Success })
	r.Task("fail", func(c *Ctx) Status { c.Agent.(*agent).calls["fail"]++; return Failure })
	r.Task("walk", func(c *Ctx) Status {
		a := c.Agent.(*agent)
		if c.Fresh {
			a.calls["walk-start"]++
			c.Mem["left"] = a.runFor
		}
		left := c.Mem["left"].(int) - 1
		c.Mem["left"] = left
		a.walked++
		if left > 0 {
			return Running
		}
		return Success
	})
	r.Service("ping", func(c *Ctx) { c.Agent.(*agent).service++ })
	return r
}

func load(t *testing.T, raw map[int]map[string]any) *Tree {
	t.Helper()
	tr, err := Load("test", 1, raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := tr.Validate(newReg()); err != nil {
		t.Fatal(err)
	}
	return tr
}

func newAgent() *agent { return &agent{calls: map[string]int{}} }

func TestSequenceResumesRunningChild(t *testing.T) {
	tr := load(t, map[int]map[string]any{
		1: entry(1, "composite", "sequence", "children", []int{2, 3}),
		2: entry(2, "task", "walk", "properties", map[string]any{}),
		3: entry(3, "task", "ok", "properties", map[string]any{}),
	})
	a := newAgent()
	a.runFor = 3
	in := NewInstance(tr, newReg(), a, rand.New(rand.NewSource(1)))
	for i := 0; i < 2; i++ {
		if st := in.Tick(float64(i)); st != Running {
			t.Fatalf("tick %d: %v", i, st)
		}
	}
	if st := in.Tick(2); st != Success {
		t.Fatalf("want success, got %v", st)
	}
	if a.calls["walk-start"] != 1 || a.calls["ok"] != 1 {
		t.Fatalf("calls %v", a.calls)
	}
}

func TestSelectorInterruptsLowerPriority(t *testing.T) {
	tr := load(t, map[int]map[string]any{
		1: entry(1, "composite", "selector", "children", []int{3, 4}),
		2: entry(2, "decorator", "flag", "inverse_check_condition", false),
		3: entry(3, "task", "ok", "decorators", []int{2}, "properties", map[string]any{}),
		4: entry(4, "task", "walk", "properties", map[string]any{}),
	})
	a := newAgent()
	a.runFor = 100
	in := NewInstance(tr, newReg(), a, rand.New(rand.NewSource(1)))
	in.Tick(0)
	in.Tick(1)
	if in.Active != "walk" || a.calls["walk-start"] != 1 {
		t.Fatalf("active %q calls %v", in.Active, a.calls)
	}
	a.cond = true
	if st := in.Tick(2); st != Success || a.calls["ok"] != 1 {
		t.Fatalf("higher priority branch did not run: %v %v", st, a.calls)
	}
	a.cond = false
	in.Tick(3)
	if a.calls["walk-start"] != 2 {
		t.Fatalf("interrupted walk should restart fresh, calls %v", a.calls)
	}
}

func TestInverseConditionAndCooldown(t *testing.T) {
	tr := load(t, map[int]map[string]any{
		1: entry(1, "composite", "selector", "children", []int{4}),
		2: entry(2, "decorator", "flag", "inverse_check_condition", true),
		3: entry(3, "decorator", "cooldown", "inverse_check_condition", false, "properties", map[string]any{"Seconds": 5}),
		4: entry(4, "task", "ok", "decorators", []int{2, 3}, "properties", map[string]any{}),
	})
	a := newAgent()
	in := NewInstance(tr, newReg(), a, rand.New(rand.NewSource(1)))
	if st := in.Tick(0); st != Success {
		t.Fatalf("inverse of false should pass, got %v", st)
	}
	if st := in.Tick(1); st != Failure {
		t.Fatalf("cooldown should block, got %v", st)
	}
	if st := in.Tick(5); st != Success {
		t.Fatalf("cooldown should be over, got %v", st)
	}
	a.cond = true
	if st := in.Tick(20); st != Failure {
		t.Fatalf("inverse of true should fail, got %v", st)
	}
}

func TestServiceInterval(t *testing.T) {
	tr := load(t, map[int]map[string]any{
		1: entry(1, "composite", "sequence", "children", []int{3}, "services", []int{2}),
		2: entry(2, "service", "ping", "time_between_ticks", 0.5),
		3: entry(3, "task", "walk", "properties", map[string]any{}),
	})
	a := newAgent()
	a.runFor = 1000
	in := NewInstance(tr, newReg(), a, rand.New(rand.NewSource(1)))
	for i := 0; i < 20; i++ {
		in.Tick(float64(i) * 0.1)
	}
	if a.service != 4 { // 时刻 t = 0、0.5、1.0、1.5
		t.Fatalf("service ran %d times", a.service)
	}
}

func TestParallelAndRandomSelector(t *testing.T) {
	tr := load(t, map[int]map[string]any{
		1: entry(1, "composite", "parallel", "children", []int{2, 3}, "properties", map[string]any{"Policy": "RequireOne"}),
		2: entry(2, "task", "walk", "properties", map[string]any{}),
		3: entry(3, "composite", "random_selector", "children", []int{4, 5}),
		4: entry(4, "task", "fail", "properties", map[string]any{}),
		5: entry(5, "task", "fail", "properties", map[string]any{}),
	})
	a := newAgent()
	a.runFor = 2
	in := NewInstance(tr, newReg(), a, rand.New(rand.NewSource(1)))
	if st := in.Tick(0); st != Running {
		t.Fatalf("want running, got %v", st)
	}
	if st := in.Tick(1); st != Success {
		t.Fatalf("want success, got %v", st)
	}
	if a.calls["fail"] != 2 {
		t.Fatalf("random selector should try both children once, calls %v", a.calls)
	}
}

func TestValidateUnknownHandler(t *testing.T) {
	tr, err := Load("x", 1, map[int]map[string]any{1: entry(1, "task", "nope")})
	if err != nil {
		t.Fatal(err)
	}
	if tr.Validate(newReg()) == nil {
		t.Fatal("expected error for unknown task")
	}
	if _, err := Load("x", 1, map[int]map[string]any{1: entry(1, "composite", "sequence", "children", []int{9})}); err == nil {
		t.Fatal("expected error for missing child")
	}
}

func TestForceSuccessCoversBlockedCondition(t *testing.T) {
	tr := load(t, map[int]map[string]any{
		1: entry(1, "composite", "sequence", "children", []int{4, 5}),
		2: entry(2, "decorator", "cooldown", "inverse_check_condition", false, "properties", map[string]any{"Seconds": 10}),
		3: entry(3, "decorator", "force_success", "inverse_check_condition", false),
		4: entry(4, "task", "ok", "decorators", []int{2, 3}, "properties", map[string]any{}),
		5: entry(5, "task", "fail", "properties", map[string]any{}),
	})
	a := newAgent()
	in := NewInstance(tr, newReg(), a, rand.New(rand.NewSource(1)))
	in.Tick(0)
	in.Tick(1) // "ok" 仍在冷却中，但序列必须仍能执行到 "fail"
	if a.calls["ok"] != 1 || a.calls["fail"] != 2 {
		t.Fatalf("calls %v", a.calls)
	}
}

func TestTraceRecordsVisitedNodes(t *testing.T) {
	tr := load(t, map[int]map[string]any{
		1: entry(1, "composite", "selector", "children", []int{3, 4}),
		2: entry(2, "decorator", "flag", "inverse_check_condition", false),
		3: entry(3, "task", "ok", "decorators", []int{2}, "properties", map[string]any{}),
		4: entry(4, "task", "walk", "properties", map[string]any{}),
	})
	a := newAgent()
	a.runFor = 100
	in := NewInstance(tr, newReg(), a, rand.New(rand.NewSource(1)))
	in.Tick(0)
	if len(in.Trace) != 0 {
		t.Fatalf("trace recorded while off: %v", in.Trace)
	}
	in.Tracing = true
	in.Tick(1)
	want := []struct {
		id, depth int
		st        Status
		note      string
	}{{1, 0, Running, ""}, {3, 1, Failure, "blocked:flag"}, {4, 1, Running, ""}}
	if len(in.Trace) != len(want) {
		t.Fatalf("trace %+v", in.Trace)
	}
	for i, w := range want {
		s := in.Trace[i]
		note := ""
		if len(s.Notes) > 0 {
			note = s.Notes[0]
		}
		if s.Node.ID != w.id || s.Depth != w.depth || s.Status != w.st || note != w.note {
			t.Fatalf("step %d: got %d/%d/%v/%q want %+v", i, s.Node.ID, s.Depth, s.Status, note, w)
		}
	}
}

func TestTraceRecordsChecksAndExplanations(t *testing.T) {
	tr := load(t, map[int]map[string]any{
		1: entry(1, "composite", "selector", "children", []int{3, 4}),
		2: entry(2, "decorator", "flag", "inverse_check_condition", true),
		3: entry(3, "task", "ok", "decorators", []int{2}, "properties", map[string]any{}),
		4: entry(4, "task", "walk", "properties", map[string]any{}),
	})
	reg := newReg()
	reg.Condition("flag", func(c *Ctx) bool { c.Explain("flag=%v", c.Agent.(*agent).cond); return c.Agent.(*agent).cond })
	reg.Task("walk", func(c *Ctx) Status { c.Explain("walking"); return Running })
	a := newAgent()
	a.cond = true
	in := NewInstance(tr, reg, a, rand.New(rand.NewSource(1)))
	in.Tracing = true
	in.Tick(0)
	// 条件本身为真，取反后不通过；依据记在这次检查上
	ck := in.Trace[1].Checks
	if len(ck) != 1 || ck[0].Node.ID != 2 || ck[0].Pass || ck[0].Why != "flag=true" {
		t.Fatalf("checks %+v", ck)
	}
	if w := in.Trace[2].Why; len(w) != 1 || w[0] != "walking" || !in.Trace[2].Fresh {
		t.Fatalf("task step %+v", in.Trace[2])
	}
	in.Tick(1)
	if in.Trace[2].Fresh {
		t.Fatal("running task should not be fresh on the second tick")
	}
	// 不追踪时 Explain 什么都不做
	in.Tracing = false
	in.Tick(2)
}
