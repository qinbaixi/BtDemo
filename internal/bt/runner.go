package bt

import "math/rand"

// Status 是节点执行一次 tick 的结果。
type Status int

const (
	Failure Status = iota
	Success
	Running
)

func (s Status) String() string {
	switch s {
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

func (r *Registry) Task(subType string, f TaskFunc)           { r.tasks[subType] = f }
func (r *Registry) Condition(subType string, f ConditionFunc) { r.conditions[subType] = f }
func (r *Registry) Service(subType string, f ServiceFunc)     { r.services[subType] = f }

// Ctx 会传递给处理函数。
type Ctx struct {
	Agent any
	Now   float64
	Node  *Node
	Fresh bool
	Mem   map[string]any
	inst  *Instance
}

// Blackboard 返回该实例的黑板。
func (c *Ctx) Blackboard() map[string]any { return c.inst.Blackboard }

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
}

// NewInstance 为 agent 创建一份可运行的 t 副本。
func NewInstance(t *Tree, reg *Registry, agent any, rng *rand.Rand) *Instance {
	return &Instance{
		Tree:        t,
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
	// 结果装饰器改变结果时为 "<decorator>"，每个被触发的服务为 "service:<sub_type>"。
	Notes []string
}

// Tick 在时刻 now（秒）运行一次整棵树。
func (in *Instance) Tick(now float64) Status {
	in.tick++
	in.now = now
	in.Active = ""
	in.Trace = in.Trace[:0]
	in.depth = 0
	return in.run(in.Tree.Root)
}

// note 在追踪时为索引 i 处的追踪步骤添加一条备注。
func (in *Instance) note(i int, s string) {
	if i >= 0 {
		in.Trace[i].Notes = append(in.Trace[i].Notes, s)
	}
}

func (in *Instance) memOf(n *Node) (*nodeMem, bool) {
	m := in.mem[n.ID]
	if m == nil {
		m = &nodeMem{lastRunning: -1}
		in.mem[n.ID] = m
	}
	fresh := m.lastRunning != in.tick-1
	if fresh {
		m.child, m.order, m.results, m.data = 0, nil, nil, map[string]any{}
	}
	return m, fresh
}

func (in *Instance) ctx(n *Node, fresh bool, m *nodeMem) *Ctx {
	return &Ctx{Agent: in.Agent, Now: in.now, Node: n, Fresh: fresh, Mem: m.data, inst: in}
}

func (in *Instance) run(n *Node) Status {
	m, fresh := in.memOf(n)

	step := -1
	if in.Tracing {
		step = len(in.Trace)
		in.Trace = append(in.Trace, TraceStep{Node: n, Depth: in.depth})
		in.depth++
		defer func() { in.depth-- }()
	}
	done := func(st Status) Status {
		if step >= 0 {
			in.Trace[step].Status = st
		}
		return st
	}

	for _, d := range n.Decorators {
		if !fresh && !d.Periodic {
			continue
		}
		if !in.checkDecorator(d) {
			m.lastRunning = -1
			in.note(step, "blocked:"+d.SubType)
			return done(in.applyResultDecorators(n, Failure, step))
		}
	}

	for _, s := range n.Services {
		// 服务会在其节点重新进入时保留自己的调度，因此即使节点每次 tick 都结束，time_between_ticks 仍然有效。
		next, scheduled := in.serviceNext[s.ID]
		if !scheduled {
			next = in.now + s.FirstTick
		}
		if in.now >= next {
			next = in.now + s.Interval
			if in.serviceMem[s.ID] == nil {
				in.serviceMem[s.ID] = map[string]any{}
			}
			in.Reg.services[s.SubType](&Ctx{Agent: in.Agent, Now: in.now, Node: s, Mem: in.serviceMem[s.ID], inst: in})
			in.note(step, "service:"+s.SubType)
		}
		in.serviceNext[s.ID] = next
	}

	var st Status
	if n.Kind == KindComposite {
		st = composites[n.SubType](in, n, m)
	} else {
		st = in.Reg.tasks[n.SubType](in.ctx(n, fresh, m))
		in.Active = n.SubType
	}

	st = in.applyResultDecorators(n, st, step)

	if st == Running {
		m.lastRunning = in.tick
	} else {
		m.lastRunning = -1
	}
	return done(st)
}

// builtinDecorators 是直接改变结果而非检查条件的装饰器，无需游戏代码即可使用。
var builtinDecorators = map[string]bool{"cooldown": true, "invert": true, "force_success": true}

// applyResultDecorators 让 n 的结果装饰器改变 st。当条件装饰器阻止了节点时，这些结果装饰器同样生效，
// 因此 ForceSuccess 可以让一个可选步骤（例如冷却中的一句台词）永远不会导致其父节点失败。
func (in *Instance) applyResultDecorators(n *Node, st Status, step int) Status {
	for _, d := range n.Decorators {
		before := st
		st = applyDecorator(in, d, st)
		if st != before {
			in.note(step, d.SubType)
		}
	}
	return st
}

func (in *Instance) checkDecorator(d *Node) bool {
	switch d.SubType {
	case "cooldown":
		return in.now >= in.cooldowns[d.ID]
	case "invert", "force_success":
		return true
	}
	ok := in.Reg.conditions[d.SubType](&Ctx{Agent: in.Agent, Now: in.now, Node: d, inst: in})
	return ok != d.Inverse
}

func applyDecorator(in *Instance, d *Node, st Status) Status {
	switch d.SubType {
	case "cooldown":
		if st == Success {
			in.cooldowns[d.ID] = in.now + d.Num("Seconds", 0)
		}
	case "force_success":
		if st == Failure {
			return Success
		}
	case "invert":
		switch st {
		case Success:
			return Failure
		case Failure:
			return Success
		}
	}
	return st
}

type compositeFunc func(in *Instance, n *Node, m *nodeMem) Status

var composites map[string]compositeFunc

func init() {
	composites = map[string]compositeFunc{
		"selector":        selector,
		"sequence":        sequence,
		"parallel":        parallel,
		"random_selector": randomSelector,
	}
}

func selector(in *Instance, n *Node, _ *nodeMem) Status {
	for _, c := range n.Children {
		if st := in.run(c); st != Failure {
			return st
		}
	}
	return Failure
}

func sequence(in *Instance, n *Node, m *nodeMem) Status {
	for m.child < len(n.Children) {
		st := in.run(n.Children[m.child])
		if st != Success {
			return st
		}
		m.child++
	}
	return Success
}

func randomSelector(in *Instance, n *Node, m *nodeMem) Status {
	if m.order == nil {
		m.order = in.Rand.Perm(len(n.Children))
	}
	for m.child < len(m.order) {
		st := in.run(n.Children[m.order[m.child]])
		if st != Failure {
			return st
		}
		m.child++
	}
	return Failure
}

func parallel(in *Instance, n *Node, m *nodeMem) Status {
	if m.results == nil {
		m.results = make([]Status, len(n.Children))
		for i := range m.results {
			m.results[i] = Running
		}
	}
	requireOne := n.Str("Policy", "RequireAll") == "RequireOne"
	running := false
	for i, c := range n.Children {
		if m.results[i] == Running {
			m.results[i] = in.run(c)
		}
		switch m.results[i] {
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
