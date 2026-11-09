package bt

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// 效用 AI（Utility AI），规则与 BtTree 编辑器运行模式（packages/shared/src/runtime/engine.ts）一致：
//
//   - 组合节点 utility_selector 在“全新进入”时给每个子节点打一次分，按分数排出执行顺序，
//     选中的子节点一直执行到成功或失败，中途不重新打分、不切换。
//   - 子节点的分数 = 它所有打分装饰器的分数相乘；有多个打分装饰器时，0–1 之间的分数先做补偿
//     s + (1 - s) × (1 - 1/n) × s（n 为打分装饰器个数），0–1 以外的数（权重）原样相乘。
//     没有打分装饰器的子节点分数为 0。
//   - 分数 ≤ 0 或低于 MinScore 的子节点不执行；同分时保持子节点原来的顺序。
//   - 组合节点属性：OnChildFailure（TryNext 默认 / Fail）、Selection（Highest 默认 /
//     WeightedRandom）、RandomTop（加权随机时参与随机的名次数，0 = 全部）、MinScore（默认 0）。
//   - 打分装饰器只用来打分，不当条件：子节点运行时不会因为它们失败。
//
// 内置两个打分装饰器：utility（固定分数 Score）和 consideration（输入 Input 归一化到
// Min–Max 后经响应曲线 Curve 打分）。游戏代码可以用 Registry.Score 注册自己的打分装饰器，
// 用 Registry.Input 注册 consideration 能读的“计算型输入”（比如目标距离），不必先写进黑板。

// ScoreFunc 计算一个打分装饰器的分数。ctx.Node 是这个装饰器，ctx.Explain 写下的说明会显示在
// 调试面板这个装饰器的分数旁边。
type ScoreFunc func(ctx *Ctx) float64

// InputFunc 计算 consideration 的一个输入值，ctx.Node 是读取它的 consideration 装饰器。
type InputFunc func(ctx *Ctx) float64

// Score 注册一个游戏自定义的打分装饰器。
func (registry *Registry) Score(subType string, fn ScoreFunc) {
	registry.scores[subType] = fn
}

// Input 注册 consideration 可以读的计算型输入。consideration 的 Input 属性先找这里注册的名字，
// 找不到再读黑板里的同名数值。
func (registry *Registry) Input(name string, fn InputFunc) {
	registry.inputs[name] = fn
}

// builtinScores 是内置的打分装饰器。
var builtinScores = map[string]ScoreFunc{
	"utility":       utilityScore,
	"consideration": considerationScore,
}

// isScoreDecorator 判断 decorator 是不是打分装饰器（内置的或游戏注册的）。
func (registry *Registry) isScoreDecorator(decorator *Node) bool {
	if _, ok := builtinScores[decorator.SubType]; ok {
		return true
	}
	_, ok := registry.scores[decorator.SubType]
	return ok
}

func (registry *Registry) scoreFunc(subType string) ScoreFunc {
	if fn, ok := registry.scores[subType]; ok {
		return fn
	}
	return builtinScores[subType]
}

// utilityScore 是内置装饰器 utility：固定分数。
func utilityScore(ctx *Ctx) float64 {
	return ctx.Node.Num("Score", 0)
}

// considerationScore 是内置装饰器 consideration：输入归一化到 0–1 后经响应曲线打分。
func considerationScore(ctx *Ctx) float64 {
	input := ctx.Node.Str("Input", "")
	minimum := ctx.Node.Num("Min", 0)
	maximum := ctx.Node.Num("Max", 100)
	curveName := ctx.Node.Str("Curve", "Linear")
	value, found := ctx.inst.inputValue(input, ctx)
	if minimum == maximum {
		ctx.Explain("Min 和 Max 相同（%g），按 0 分", minimum)
		return 0
	}
	normalized := clamp01((value - minimum) / (maximum - minimum))
	score, err := CurveValue(curveName, normalized)
	if err != nil {
		ctx.Explain("%v，按 0 分", err)
		return 0
	}
	if !found {
		ctx.Explain("%s 未设置（按 0）→ %s %s", input, curveName, formatScore(score))
		return score
	}
	ctx.Explain(
		"%s=%s → 归一 %s → %s %s",
		input,
		formatNumber(value),
		formatScore(normalized),
		curveName,
		formatScore(score),
	)
	return score
}

// inputValue 读 consideration 的输入：先找注册的计算型输入，再找黑板里的数值。
// 第二个返回值表示是否找到了这个输入；黑板里的布尔值按 1 / 0 算。
func (instance *Instance) inputValue(name string, ctx *Ctx) (float64, bool) {
	if fn, ok := instance.Reg.inputs[name]; ok {
		return fn(ctx), true
	}
	switch value := instance.Blackboard[name].(type) {
	case int:
		return float64(value), true
	case int64:
		return float64(value), true
	case float64:
		return value, true
	case bool:
		if value {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// curves 是响应曲线，键为小写名字。输入和输出都在 0–1。
var curves = map[string]func(x float64) float64{
	"linear":           func(x float64) float64 { return x },
	"inverselinear":    func(x float64) float64 { return 1 - x },
	"quadratic":        func(x float64) float64 { return x * x },
	"inversequadratic": func(x float64) float64 { return 1 - x*x },
	"sqrt":             math.Sqrt,
	"inversesqrt":      func(x float64) float64 { return 1 - math.Sqrt(x) },
	"logistic":         logistic01,
	"inverselogistic":  func(x float64) float64 { return 1 - logistic01(x) },
	"step":             func(x float64) float64 { return stepCurve(x, 1, 0) },
	"inversestep":      func(x float64) float64 { return stepCurve(x, 0, 1) },
}

// CurveNames 是 consideration 支持的曲线名（不区分大小写）。
var CurveNames = []string{
	"Linear", "InverseLinear", "Quadratic", "InverseQuadratic", "Sqrt",
	"InverseSqrt", "Logistic", "InverseLogistic", "Step", "InverseStep",
}

func stepCurve(x, high, low float64) float64 {
	if x >= 0.5 {
		return high
	}
	return low
}

// logistic01 是 S 形曲线，缩放到 0 → 0、0.5 → 0.5、1 → 1。
func logistic01(x float64) float64 {
	const steepness = 10
	sigmoid := func(t float64) float64 { return 1 / (1 + math.Exp(-steepness*(t-0.5))) }
	low, high := sigmoid(0), sigmoid(1)
	return (sigmoid(x) - low) / (high - low)
}

// CurveValue 返回响应曲线 name（不区分大小写）在 x 处的值，x 和结果都截断到 0–1。
func CurveValue(name string, x float64) (float64, error) {
	curve, ok := curves[strings.ToLower(name)]
	if !ok {
		return 0, fmt.Errorf("未知曲线 %q（可用：%s）", name, strings.Join(CurveNames, "、"))
	}
	return clamp01(curve(clamp01(x))), nil
}

func clamp01(x float64) float64 {
	switch {
	case x < 0 || math.IsNaN(x):
		return 0
	case x > 1:
		return 1
	}
	return x
}

// CombineScores 合并一个子节点上所有打分装饰器的分数，规则见文件开头。
func CombineScores(scores []float64) float64 {
	if len(scores) == 0 {
		return 0
	}
	count := float64(len(scores))
	modification := 1 - 1/count
	total := 1.0
	for _, score := range scores {
		factor := score
		if len(scores) > 1 && score >= 0 && score <= 1 {
			factor = score + (1-score)*modification*score
		}
		total *= factor
	}
	return total
}

// Score 是调试追踪里的一条分数：子节点的总分，或子节点上一个打分装饰器的分数。
type Score struct {
	Node  *Node
	Value float64
	Why   string // 打分装饰器调用 Explain 写下的依据；子节点总分时为空
}

// scoredChild 是排序用的一个子节点。
type scoredChild struct {
	index int
	score float64
}

// utilitySelector 是 utility_selector 组合节点：全新进入时打分排序（结果存在 mem.order），
// 之后像选择节点一样按这个顺序尝试，中途不重新打分。
func utilitySelector(instance *Instance, node *Node, mem *nodeMem, step int) Status {
	if mem.order == nil {
		mem.order, mem.scores = instance.utilityOrder(node, step)
	} else if step >= 0 {
		// 接着上一帧运行：把进入时打的分再带上，调试面板照样能看到选择的依据
		instance.Trace[step].Scores = append(instance.Trace[step].Scores, mem.scores...)
	}
	for mem.child < len(mem.order) {
		status := instance.run(node.Children[mem.order[mem.child]])
		if status != Failure {
			return status
		}
		mem.child++
	}
	return Failure
}

// utilityOrder 给 node 的每个子节点打分，返回执行顺序（子节点下标）和追踪用的分数。
func (instance *Instance) utilityOrder(node *Node, step int) ([]int, []Score) {
	minScore := node.Num("MinScore", 0)
	weighted := strings.EqualFold(node.Str("Selection", "Highest"), "WeightedRandom")
	randomTop := int(node.Num("RandomTop", 0))
	failOnChildFailure := strings.EqualFold(node.Str("OnChildFailure", "TryNext"), "Fail")

	var scores []Score
	scored := make([]scoredChild, len(node.Children))
	for index, child := range node.Children {
		childScore, parts := instance.scoreChild(child, step)
		scored[index] = scoredChild{index: index, score: childScore}
		scores = append(scores, Score{Node: child, Value: childScore})
		scores = append(scores, parts...)
	}

	eligible := make([]scoredChild, 0, len(scored))
	for _, candidate := range scored {
		if candidate.score > 0 && candidate.score >= minScore {
			eligible = append(eligible, candidate)
		}
	}
	// 稳定排序：同分时保持子节点原来的顺序
	sort.SliceStable(eligible, func(left, right int) bool {
		return eligible[left].score > eligible[right].score
	})

	if weighted && len(eligible) > 1 {
		count := len(eligible)
		if randomTop > 0 && randomTop < count {
			count = randomTop
		}
		instance.weightedShuffle(eligible[:count])
	}
	order := make([]int, len(eligible))
	for position, candidate := range eligible {
		order[position] = candidate.index
	}
	if failOnChildFailure && len(order) > 1 {
		order = order[:1]
	}

	if step >= 0 {
		instance.Trace[step].Scores = append(instance.Trace[step].Scores, scores...)
		instance.Trace[step].Why = append(
			instance.Trace[step].Why,
			scoreSummary(node, scored, order),
		)
	}
	// order 为空切片而不是 nil：nil 表示“还没打分”
	return order, scores
}

// scoreChild 计算一个子节点的总分，同时返回每个打分装饰器的分数（依据只在追踪时有）。
func (instance *Instance) scoreChild(child *Node, step int) (float64, []Score) {
	var values []float64
	var parts []Score
	for _, decorator := range child.Decorators {
		if !instance.Reg.isScoreDecorator(decorator) {
			continue
		}
		ctx := instance.ctxFor(decorator, nil, step)
		var why []string
		ctx.explainTo = &why
		value := instance.Reg.scoreFunc(decorator.SubType)(ctx)
		if math.IsNaN(value) || math.IsInf(value, 0) {
			ctx.Explain("分数不是有限数，按 0 分")
			value = 0
		}
		values = append(values, value)
		parts = append(parts, Score{Node: decorator, Value: value, Why: strings.Join(why, "；")})
	}
	return CombineScores(values), parts
}

// weightedShuffle 按分数加权随机重排 pool（分数都 > 0）：分数越高越可能排在前面。
func (instance *Instance) weightedShuffle(pool []scoredChild) {
	for start := 0; start < len(pool)-1; start++ {
		total := 0.0
		for _, candidate := range pool[start:] {
			total += candidate.score
		}
		roll := instance.Rand.Float64() * total
		pick := len(pool) - 1
		for position := start; position < len(pool); position++ {
			roll -= pool[position].score
			if roll < 0 {
				pick = position
				break
			}
		}
		// 把选中的挪到 start，其余保持相对顺序
		chosen := pool[pick]
		copy(pool[start+1:pick+1], pool[start:pick])
		pool[start] = chosen
	}
}

// scoreSummary 是追踪里的一句话，例如“打分：射击 0.6、靠近 0.1 → 射击”。
func scoreSummary(node *Node, scored []scoredChild, order []int) string {
	parts := make([]string, len(scored))
	for position, candidate := range scored {
		parts[position] = nodeName(node.Children[candidate.index]) + " " + formatScore(candidate.score)
	}
	chosen := "无"
	if len(order) > 0 {
		chosen = nodeName(node.Children[order[0]])
	}
	if len(parts) == 0 {
		return "打分：没有子节点 → 无"
	}
	return "打分：" + strings.Join(parts, "、") + " → " + chosen
}

func nodeName(node *Node) string {
	if node.Label != "" {
		return node.Label
	}
	return node.SubType
}

// formatScore 把分数保留三位小数（和编辑器一致），去掉末尾的 0。
func formatScore(value float64) string {
	return formatNumber(math.Round(value*1000) / 1000)
}

func formatNumber(value float64) string {
	return fmt.Sprintf("%g", math.Round(value*1000)/1000)
}

// validateScoreDecorator 在加载时检查 consideration 的曲线名。
func validateScoreDecorator(tree *Tree, decorator *Node) error {
	if decorator.SubType != "consideration" {
		return nil
	}
	if _, err := CurveValue(decorator.Str("Curve", "Linear"), 0); err != nil {
		return fmt.Errorf("bt %s: consideration (node %d): %v", tree.Name, decorator.ID, err)
	}
	return nil
}
