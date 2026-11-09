package bt

import (
	"math"
	"math/rand"
	"strings"
	"testing"
)

// utilityTree 是一个 utility_selector（属性 props）下挂三个任务 a、b、c，
// 子节点的打分装饰器由 decorators 给出（节点 id 从 10 开始）。
func utilityTree(
	t *testing.T,
	props map[string]any,
	tasks [3]string,
	decorators [3][]map[string]any,
) *Tree {
	t.Helper()
	raw := map[int]map[string]any{
		1: entry(1, "composite", "utility_selector", "children", []int{2, 3, 4}, "properties", props),
	}
	nextID := 10
	for index, task := range tasks {
		var ids []int
		for _, decorator := range decorators[index] {
			decorator["node_id"] = nextID
			decorator["type"] = "decorator"
			raw[nextID] = decorator
			ids = append(ids, nextID)
			nextID++
		}
		raw[index+2] = entry(
			index+2,
			"task",
			task,
			"decorators",
			ids,
			"properties",
			map[string]any{},
		)
	}
	tree, err := Load("test", 1, raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := tree.Validate(scoreRegistry()); err != nil {
		t.Fatal(err)
	}
	return tree
}

func fixed(score float64) map[string]any {
	return map[string]any{"sub_type": "utility", "properties": map[string]any{"Score": score}}
}

func consider(input string, minimum, maximum float64, curve string) map[string]any {
	return map[string]any{
		"sub_type": "consideration",
		"properties": map[string]any{
			"Input": input,
			"Min":   minimum,
			"Max":   maximum,
			"Curve": curve,
		},
	}
}

func scoreRegistry() *Registry {
	registry := newReg()
	for _, name := range []string{"a", "b", "c"} {
		taskName := name
		registry.Task(taskName, func(ctx *Ctx) Status {
			ctx.Agent.(*agent).calls[taskName]++
			return Success
		})
	}
	return registry
}

func TestUtilityPicksHighestScore(t *testing.T) {
	tree := utilityTree(t, map[string]any{}, [3]string{"a", "b", "c"}, [3][]map[string]any{
		{fixed(0.2)},
		{fixed(0.7)},
		{fixed(0.7)}, // 和 b 同分，保持原来的顺序：b 在前
	})
	testAgent := newAgent()
	instance := NewInstance(tree, scoreRegistry(), testAgent, rand.New(rand.NewSource(1)))
	if status := instance.Tick(0); status != Success {
		t.Fatalf("want success, got %v", status)
	}
	if testAgent.calls["b"] != 1 || testAgent.calls["a"] != 0 || testAgent.calls["c"] != 0 {
		t.Fatalf("want only b, got %v", testAgent.calls)
	}
}

func TestUtilitySkipsZeroAndBelowMinScore(t *testing.T) {
	tree := utilityTree(
		t,
		map[string]any{"MinScore": 0.3},
		[3]string{"fail", "a", "b"},
		[3][]map[string]any{
			{fixed(0.9)}, // 最高分但失败，TryNext 时试下一个
			{fixed(0.2)}, // 低于 MinScore，不执行
			{},           // 没有打分装饰器，0 分
		},
	)
	testAgent := newAgent()
	instance := NewInstance(tree, scoreRegistry(), testAgent, rand.New(rand.NewSource(1)))
	if status := instance.Tick(0); status != Failure {
		t.Fatalf("want failure, got %v", status)
	}
	if testAgent.calls["fail"] != 1 || testAgent.calls["a"] != 0 || testAgent.calls["b"] != 0 {
		t.Fatalf("unexpected calls %v", testAgent.calls)
	}
}

func TestUtilityTryNextAndFail(t *testing.T) {
	decorators := [3][]map[string]any{{fixed(0.9)}, {fixed(0.5)}, {fixed(0.1)}}
	tasks := [3]string{"fail", "a", "b"}

	testAgent := newAgent()
	tryNext := utilityTree(t, map[string]any{}, tasks, decorators)
	instance := NewInstance(tryNext, scoreRegistry(), testAgent, rand.New(rand.NewSource(1)))
	if status := instance.Tick(0); status != Success || testAgent.calls["a"] != 1 {
		t.Fatalf("TryNext: want a to run after fail, got %v %v", status, testAgent.calls)
	}

	testAgent = newAgent()
	failFast := utilityTree(t, map[string]any{"OnChildFailure": "Fail"}, tasks, decorators)
	instance = NewInstance(failFast, scoreRegistry(), testAgent, rand.New(rand.NewSource(1)))
	if status := instance.Tick(0); status != Failure || testAgent.calls["a"] != 0 {
		t.Fatalf("Fail: want failure without trying a, got %v %v", status, testAgent.calls)
	}
}

func TestUtilityDoesNotRescoreWhileRunning(t *testing.T) {
	tree := utilityTree(t, map[string]any{}, [3]string{"walk", "a", "b"}, [3][]map[string]any{
		{consider("Danger", 0, 10, "InverseLinear")},
		{consider("Danger", 0, 10, "Linear")},
		{fixed(0.01)},
	})
	testAgent := newAgent()
	testAgent.runFor = 3
	instance := NewInstance(tree, scoreRegistry(), testAgent, rand.New(rand.NewSource(1)))
	instance.Blackboard["Danger"] = 0 // walk 1 分，a 0 分
	if status := instance.Tick(0); status != Running {
		t.Fatalf("want running, got %v", status)
	}
	instance.Blackboard["Danger"] = 10 // 现在 a 分数更高，但 walk 正在运行，不重新打分
	instance.Tick(1)
	if status := instance.Tick(2); status != Success {
		t.Fatalf("want walk to finish, got %v", status)
	}
	if testAgent.calls["a"] != 0 || testAgent.calls["walk-start"] != 1 {
		t.Fatalf("rescored while running: %v", testAgent.calls)
	}
	// walk 结束后再进入，重新打分选中 a
	instance.Tick(3)
	if testAgent.calls["a"] != 1 {
		t.Fatalf("want a after re-entry, got %v", testAgent.calls)
	}
}

func TestConsiderationReadsRegisteredInput(t *testing.T) {
	tree := utilityTree(t, map[string]any{}, [3]string{"a", "b", "c"}, [3][]map[string]any{
		{consider("Distance", 0, 100, "Linear")},
		{fixed(0.5)},
		{},
	})
	registry := scoreRegistry()
	distance := 80.0
	registry.Input("Distance", func(ctx *Ctx) float64 { return distance })
	testAgent := newAgent()
	instance := NewInstance(tree, registry, testAgent, rand.New(rand.NewSource(1)))
	instance.Tick(0)
	if testAgent.calls["a"] != 1 {
		t.Fatalf("distance 80 should pick a, got %v", testAgent.calls)
	}
	distance = 20
	instance.Tick(1)
	if testAgent.calls["b"] != 1 {
		t.Fatalf("distance 20 should pick b, got %v", testAgent.calls)
	}
}

func TestScoreDecoratorDoesNotBlock(t *testing.T) {
	tree := load(t, map[int]map[string]any{
		1: entry(1, "composite", "sequence", "children", []int{2}),
		2: entry(2, "task", "ok", "decorators", []int{3}, "properties", map[string]any{}),
		3: entry(3, "decorator", "utility", "properties", map[string]any{"Score": 0}),
	})
	testAgent := newAgent()
	instance := NewInstance(tree, newReg(), testAgent, rand.New(rand.NewSource(1)))
	if status := instance.Tick(0); status != Success || testAgent.calls["ok"] != 1 {
		t.Fatalf("score decorator outside utility_selector must not block: %v", status)
	}
}

func TestUtilityWeightedRandom(t *testing.T) {
	tree := utilityTree(
		t,
		map[string]any{"Selection": "WeightedRandom", "RandomTop": 2},
		[3]string{"a", "b", "c"},
		[3][]map[string]any{{fixed(0.75)}, {fixed(0.25)}, {fixed(0.9)}},
	)
	testAgent := newAgent()
	instance := NewInstance(tree, scoreRegistry(), testAgent, rand.New(rand.NewSource(7)))
	for tick := 0; tick < 2000; tick++ {
		instance.Tick(float64(tick))
	}
	// 前两名是 c（0.9）和 a（0.75），b 排第三，永远轮不到
	if testAgent.calls["b"] != 0 {
		t.Fatalf("b is outside RandomTop, got %v", testAgent.calls)
	}
	share := float64(testAgent.calls["c"]) / 2000
	want := 0.9 / (0.9 + 0.75)
	if math.Abs(share-want) > 0.05 {
		t.Fatalf("c share %.3f, want about %.3f", share, want)
	}
}

func TestCombineScoresAndCurves(t *testing.T) {
	near := func(got, want float64) bool { return math.Abs(got-want) < 1e-9 }
	if got := CombineScores([]float64{0.5}); !near(got, 0.5) {
		t.Fatalf("single score: %v", got)
	}
	// 两个 0.5：每个补偿成 0.5 + 0.5 × 0.5 × 0.5 = 0.625，相乘 0.390625
	if got := CombineScores([]float64{0.5, 0.5}); !near(got, 0.390625) {
		t.Fatalf("compensated: %v", got)
	}
	// 0–1 以外的权重原样相乘：0.5 补偿成 0.625，乘 2
	if got := CombineScores([]float64{0.5, 2}); !near(got, 1.25) {
		t.Fatalf("weight: %v", got)
	}
	if got := CombineScores(nil); got != 0 {
		t.Fatalf("no scores: %v", got)
	}
	cases := []struct {
		curve string
		x     float64
		want  float64
	}{
		{"Linear", 0.3, 0.3},
		{"inverseLinear", 0.3, 0.7},
		{"Quadratic", 0.5, 0.25},
		{"InverseQuadratic", 0.5, 0.75},
		{"Sqrt", 0.25, 0.5},
		{"Logistic", 0.5, 0.5},
		{"Logistic", 0, 0},
		{"Logistic", 1, 1},
		{"InverseLogistic", 1, 0},
		{"Step", 0.5, 1},
		{"InverseStep", 0.49, 1},
		{"Linear", 1.7, 1}, // 输入截断到 0–1
	}
	for _, testCase := range cases {
		got, err := CurveValue(testCase.curve, testCase.x)
		if err != nil || !near(got, testCase.want) {
			t.Errorf("%s(%v) = %v %v, want %v", testCase.curve, testCase.x, got, err, testCase.want)
		}
	}
	if _, err := CurveValue("Wobbly", 0.5); err == nil {
		t.Fatal("unknown curve should fail")
	}
}

func TestValidateRejectsUnknownCurve(t *testing.T) {
	tree, err := Load("test", 1, map[int]map[string]any{
		1: entry(1, "composite", "utility_selector", "children", []int{2}),
		2: entry(2, "task", "ok", "decorators", []int{3}, "properties", map[string]any{}),
		3: entry(3, "decorator", "consideration", "properties", map[string]any{"Curve": "Wobbly"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tree.Validate(newReg()); err == nil || !strings.Contains(err.Error(), "Wobbly") {
		t.Fatalf("want unknown curve error, got %v", err)
	}
}

func TestUtilityTraceHasScores(t *testing.T) {
	tree := utilityTree(t, map[string]any{}, [3]string{"walk", "a", "b"}, [3][]map[string]any{
		{consider("Danger", 0, 10, "Linear"), fixed(0.5)},
		{fixed(0.1)},
		{},
	})
	testAgent := newAgent()
	testAgent.runFor = 2
	instance := NewInstance(tree, scoreRegistry(), testAgent, rand.New(rand.NewSource(1)))
	instance.Tracing = true
	instance.Blackboard["Danger"] = 8
	instance.Tick(0)
	root := instance.Trace[0]
	// 三个子节点的总分 + walk 上两个、a 上一个打分装饰器
	if len(root.Scores) != 6 {
		t.Fatalf("want 6 scores, got %+v", root.Scores)
	}
	if !strings.Contains(strings.Join(root.Why, ""), "→ walk") {
		t.Fatalf("summary missing: %v", root.Why)
	}
	var considerationWhy string
	for _, score := range root.Scores {
		if score.Node.SubType == "consideration" {
			considerationWhy = score.Why
		}
	}
	if !strings.Contains(considerationWhy, "Danger=8") {
		t.Fatalf("consideration why: %q", considerationWhy)
	}
	// 接着运行的下一帧：不重新打分，但分数照样带上
	instance.Tick(1)
	if root = instance.Trace[0]; root.Fresh || len(root.Scores) != 6 {
		t.Fatalf("continued tick should carry scores: fresh=%v %d", root.Fresh, len(root.Scores))
	}
}
