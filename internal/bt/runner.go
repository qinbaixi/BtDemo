package bt

import (
	"fmt"
	"math/rand"
)

// Status 是节点执行一次 tick 的结果。
type Status int

const (
	Failure Status = iota
	Success
	Running
)

func (status Status) String() string {
	switch status {
	case Success:
		return "success"
	case Running:
		return "running"
	}
	return "failure"
}

// TaskFunc 执行一个任务节点。ctx.Fresh 表示该节点是否刚刚进入（即上一次 tick 时并未运行），
// ctx.Mem 是临时内存，每次全新进入时都会被清空。
type TaskFunc func(ctx *Ctx) Status

// ConditionFunc 计算一个条件装饰器的结果。
type ConditionFunc func(ctx *Ctx) bool

// ServiceFunc 运行一个服务。
type ServiceFunc func(ctx *Ctx)

// Registry 将导出的 `sub_type` 名称绑定到游戏代码。
type Registry struct {
	tasks      map[string]TaskFunc
	conditions map[string]ConditionFunc
	services   map[string]ServiceFunc
}

// NewRegistry 返回一个空的注册表。
func NewRegistry() *Registry {
	return &Registry{
		tasks:      map[string]TaskFunc{},
		conditions: map[string]ConditionFunc{},
		services:   map[string]ServiceFunc{},
	}
}

func (registry *Registry) Task(subType string, fn TaskFunc) {
	registry.tasks[subType] = fn
}

func (registry *Registry) Condition(subType string, fn ConditionFunc) {
	registry.conditions[subType] = fn
}

func (registry *Registry) Service(subType string, fn ServiceFunc) {
	registry.services[subType] = fn
}

// Ctx 会传递给处理函数。
type Ctx struct {
	Agent any
	Now   float64
	Node  *Node
	Fresh bool
	Mem   map[string]any
	inst  *Instance
	step  int // 追踪时本节点对应的追踪步骤下标，不追踪时为 -1
	check int // 正在检查的条件装饰器在 Checks 里的下标，不是条件时为 -1
}

// Tracing 表示是否在记录调试追踪；为 false 时处理函数不必拼说明文字。
func (ctx *Ctx) Tracing() bool { return ctx.step >= 0 }

// Explain 为调试面板记下一句判断依据，例如“距离 85 > 60”。只在追踪时生效：
// 条件里调用时写到这次条件检查上，任务和服务里调用时写到节点的说明里。
func (ctx *Ctx) Explain(format string, args ...any) {
	if ctx.step < 0 {
		return
	}
	text := fmt.Sprintf(format, args...)
	step := &ctx.inst.Trace[ctx.step]
	switch {
	case ctx.check >= 0:
		check := &step.Checks[ctx.check]
		check.Why = joinWhy(check.Why, text)
	case ctx.Node.Kind == KindService:
		step.Notes = append(step.Notes, "service:"+ctx.Node.SubType+" "+text)
	default:
		step.Why = append(step.Why, text)
	}
}

func joinWhy(a, b string) string {
	if a == "" {
		return b
	}
	return a + "；" + b
}

// Blackboard 返回该实例的黑板。
func (ctx *Ctx) Blackboard() map[string]any { return ctx.inst.Blackboard }

type nodeMem struct {
	lastRunning int // 节点上一次返回 Running 时的 tick 编号
	child       int
	order       []int
	results     []Status
	data        map[string]any
}

// Instance 是某个智能体所持有的一份运行中的树副本。
//
// 每次 tick 都从根节点开始。选择器是响应式的：它们每次 tick 都按优先级顺序尝试子节点，
// 因此优先级更高的分支可以打断正在运行的低优先级分支。序列和随机选择器会从正在运行的
// 子节点处继续。上一次 tick 未在运行的节点视为全新进入：清空其内存并检查其装饰器；
// 在其持续运行期间，只会再次检查 `periodic` 装饰器。
type Instance struct {
	Tree       *Tree
	Reg        *Registry
	Agent      any
	Blackboard map[string]any
	Rand       *rand.Rand

	// Active 是上一次 tick 中执行的最深任务的 sub_type，便于调试和显示。
	Active string

	// Tracing 开启 Trace：记录上一次 Tick 访问过的每个节点，按进入顺序排列。
	Tracing bool
	Trace   []TraceStep
	depth   int

	tick        int
	now         float64
	mem         map[int]*nodeMem
	cooldowns   map[int]float64
	serviceNext map[int]float64
	serviceMem  map[int]map[string]any
	// ctxCache 是传给处理器的 Ctx 的复用缓冲：处理器的调用都是同步完成的
	// （处理器不得把 Ctx 保存下来），同一时刻只需要一份
	ctxCache Ctx
}

// NewInstance 为 agent 创建一份可运行的 tree 副本。
func NewInstance(tree *Tree, reg *Registry, agent any, rng *rand.Rand) *Instance {
	return &Instance{
		Tree:        tree,
		Reg:         reg,
		Agent:       agent,
		Blackboard:  map[string]any{},
		Rand:        rng,
		mem:         map[int]*nodeMem{},
		cooldowns:   map[int]float64{},
		serviceNext: map[int]float64{},
		serviceMem:  map[int]map[string]any{},
	}
}

// TraceStep 记录一次追踪 tick 中访问过的一个节点。
type TraceStep struct {
	Node   *Node
	Depth  int
	Status Status
	// Note 说明结果的原因：节点被条件或冷却时间阻止时为 "blocked:<decorator>"，
	// 结果装饰器改变结果时为 "<decorator>"，每个被触发的服务为 "service:<sub_type>"
	// （服务调用了 Explain 时后面跟一个空格和说明）。
	Notes []string
	// Fresh 表示节点本次是新进入的；为 false 时是接着上一帧继续运行，只复查 periodic 条件。
	Fresh bool
	// Checks 是本次检查过的条件装饰器（含冷却）及结果，按检查顺序。
	Checks []Check
	// Why 是任务通过 Explain 写下的说明。
	Why []string
}

// Check 是一次条件装饰器检查。
type Check struct {
	Node *Node
	Pass bool   // 已算上 inverse
	Why  string // 条件或冷却给出的判断依据
}

// Tick 在时刻 now（秒）运行一次整棵树。
func (instance *Instance) Tick(now float64) Status {
	instance.tick++
	instance.now = now
	instance.Active = ""
	instance.Trace = instance.Trace[:0]
	instance.depth = 0
	return instance.run(instance.Tree.Root)
}

// note 在追踪时为索引 i 处的追踪步骤添加一条备注。
func (instance *Instance) note(i int, text string) {
	if i >= 0 {
		instance.Trace[i].Notes = append(instance.Trace[i].Notes, text)
	}
}

func (instance *Instance) memOf(node *Node) (*nodeMem, bool) {
	mem := instance.mem[node.ID]
	if mem == nil {
		mem = &nodeMem{lastRunning: -1}
		instance.mem[node.ID] = mem
	}
	fresh := mem.lastRunning != instance.tick-1
	if fresh {
		mem.child, mem.order, mem.results, mem.data = 0, nil, nil, nil
	}
	return mem, fresh
}

// ctxFor 把复用的 Ctx（ctxCache）填成传给 node 的处理器用的样子。
// 所有处理器的调用都是同步完成的，所以一份缓冲就够；Fresh 按需由调用方覆盖。
func (instance *Instance) ctxFor(node *Node, mem map[string]any, step int) *Ctx {
	instance.ctxCache = Ctx{
		Agent: instance.Agent,
		Now:   instance.now,
		Node:  node,
		Mem:   mem,
		inst:  instance,
		step:  step,
		check: -1,
	}
	return &instance.ctxCache
}

func (instance *Instance) ctx(node *Node, fresh bool, mem *nodeMem, step int) *Ctx {
	if mem.data == nil {
		mem.data = map[string]any{} // 节点内存只在任务真的要用时才建
	}
	ctx := instance.ctxFor(node, mem.data, step)
	ctx.Fresh = fresh
	return ctx
}

func (instance *Instance) run(node *Node) Status {
	mem, fresh := instance.memOf(node)

	step := -1
	if instance.Tracing {
		step = len(instance.Trace)
		instance.Trace = append(
			instance.Trace,
			TraceStep{Node: node, Depth: instance.depth, Fresh: fresh},
		)
		instance.depth++
		defer func() { instance.depth-- }()
	}
	done := func(status Status) Status {
		if step >= 0 {
			instance.Trace[step].Status = status
		}
		return status
	}

	for _, decorator := range node.Decorators {
		if !fresh && !decorator.Periodic {
			continue
		}
		if !instance.checkDecorator(decorator, step) {
			mem.lastRunning = -1
			instance.note(step, "blocked:"+decorator.SubType)
			return done(instance.applyResultDecorators(node, Failure, step))
		}
	}

	for _, service := range node.Services {
		// 服务会在其节点重新进入时保留自己的调度，因此即使节点每次 tick 都结束，time_between_ticks 仍然有效。
		next, scheduled := instance.serviceNext[service.ID]
		if !scheduled {
			next = instance.now + service.FirstTick
		}
		if instance.now >= next {
			next = instance.now + service.Interval
			if instance.serviceMem[service.ID] == nil {
				instance.serviceMem[service.ID] = map[string]any{}
			}
			before := 0
			if step >= 0 {
				before = len(instance.Trace[step].Notes)
			}
			instance.Reg.services[service.SubType](
				instance.ctxFor(service, instance.serviceMem[service.ID], step),
			)
			// 服务没写说明时也记一笔“触发过”
			if step >= 0 && len(instance.Trace[step].Notes) == before {
				instance.note(step, "service:"+service.SubType)
			}
		}
		instance.serviceNext[service.ID] = next
	}

	var status Status
	if node.Kind == KindComposite {
		status = composites[node.SubType](instance, node, mem)
	} else {
		status = instance.Reg.tasks[node.SubType](instance.ctx(node, fresh, mem, step))
		instance.Active = node.SubType
	}

	status = instance.applyResultDecorators(node, status, step)

	if status == Running {
		mem.lastRunning = instance.tick
	} else {
		mem.lastRunning = -1
	}
	return done(status)
}

// builtinDecorators 是直接改变结果而非检查条件的装饰器，无需游戏代码即可使用。
var builtinDecorators = map[string]bool{"cooldown": true, "invert": true, "force_success": true}

// applyResultDecorators 让 node 的结果装饰器改变 status。当条件装饰器阻止了节点时，这些结果装饰器同样生效，
// 因此 ForceSuccess 可以让一个可选步骤（例如冷却中的一句台词）永远不会导致其父节点失败。
func (instance *Instance) applyResultDecorators(node *Node, status Status, step int) Status {
	for _, decorator := range node.Decorators {
		before := status
		status = applyDecorator(instance, decorator, status)
		if status != before {
			instance.note(step, decorator.SubType)
		}
	}
	return status
}

// checkDecorator 检查一个条件装饰器（或冷却）；追踪时把结果和依据记到 step 的 Checks 里。
func (instance *Instance) checkDecorator(decorator *Node, step int) bool {
	switch decorator.SubType {
	case "invert", "force_success":
		return true
	}
	checkIdx := -1
	if step >= 0 {
		checkIdx = len(instance.Trace[step].Checks)
		instance.Trace[step].Checks = append(instance.Trace[step].Checks, Check{Node: decorator})
	}
	var ok bool
	if decorator.SubType == "cooldown" {
		ready := instance.cooldowns[decorator.ID]
		ok = instance.now >= ready
		if checkIdx >= 0 {
			if ok {
				instance.Trace[step].Checks[checkIdx].Why = "冷却完毕"
			} else {
				left := ready - instance.now
				instance.Trace[step].Checks[checkIdx].Why = fmt.Sprintf("冷却中，还剩 %.1fs", left)
			}
		}
	} else {
		ctx := instance.ctxFor(decorator, nil, step)
		ctx.check = checkIdx
		ok = instance.Reg.conditions[decorator.SubType](ctx) != decorator.Inverse
	}
	if checkIdx >= 0 {
		instance.Trace[step].Checks[checkIdx].Pass = ok
	}
	return ok
}

func applyDecorator(instance *Instance, decorator *Node, status Status) Status {
	switch decorator.SubType {
	case "cooldown":
		if status == Success {
			instance.cooldowns[decorator.ID] = instance.now + decorator.Num("Seconds", 0)
		}
	case "force_success":
		if status == Failure {
			return Success
		}
	case "invert":
		switch status {
		case Success:
			return Failure
		case Failure:
			return Success
		}
	}
	return status
}

type compositeFunc func(instance *Instance, node *Node, mem *nodeMem) Status

var composites map[string]compositeFunc

func init() {
	composites = map[string]compositeFunc{
		"selector":        selector,
		"sequence":        sequence,
		"parallel":        parallel,
		"random_selector": randomSelector,
	}
}

func selector(instance *Instance, node *Node, _ *nodeMem) Status {
	for _, child := range node.Children {
		if status := instance.run(child); status != Failure {
			return status
		}
	}
	return Failure
}

func sequence(instance *Instance, node *Node, mem *nodeMem) Status {
	for mem.child < len(node.Children) {
		status := instance.run(node.Children[mem.child])
		if status != Success {
			return status
		}
		mem.child++
	}
	return Success
}

func randomSelector(instance *Instance, node *Node, mem *nodeMem) Status {
	if mem.order == nil {
		mem.order = instance.Rand.Perm(len(node.Children))
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

func parallel(instance *Instance, node *Node, mem *nodeMem) Status {
	if mem.results == nil {
		mem.results = make([]Status, len(node.Children))
		for i := range mem.results {
			mem.results[i] = Running
		}
	}
	requireOne := node.Str("Policy", "RequireAll") == "RequireOne"
	running := false
	for i, child := range node.Children {
		if mem.results[i] == Running {
			mem.results[i] = instance.run(child)
		}
		switch mem.results[i] {
		case Success:
			if requireOne {
				return Success
			}
		case Failure:
			if !requireOne {
				return Failure
			}
		case Running:
			running = true
		}
	}
	if running {
		return Running
	}
	if requireOne {
		return Failure
	}
	return Success
}
