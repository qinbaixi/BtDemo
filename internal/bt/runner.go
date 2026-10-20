package bt

import "math/rand"

// Status is the result of ticking a node.
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

// TaskFunc runs a task node. ctx.Fresh reports whether the node was just
// entered (it was not running on the previous tick) and ctx.Mem is scratch
// memory that is cleared on every fresh entry.
type TaskFunc func(ctx *Ctx) Status

// ConditionFunc evaluates a condition decorator.
type ConditionFunc func(ctx *Ctx) bool

// ServiceFunc runs a service.
type ServiceFunc func(ctx *Ctx)

// Registry binds exported `sub_type` names to game code.
type Registry struct {
	tasks      map[string]TaskFunc
	conditions map[string]ConditionFunc
	services   map[string]ServiceFunc
}

// NewRegistry returns an empty registry.
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

// Ctx is passed to handlers.
type Ctx struct {
	Agent any
	Now   float64
	Node  *Node
	Fresh bool
	Mem   map[string]any
	inst  *Instance
}

// Blackboard returns the instance's blackboard.
func (c *Ctx) Blackboard() map[string]any { return c.inst.Blackboard }

type nodeMem struct {
	lastRunning int // tick number on which the node last returned Running
	child       int
	order       []int
	results     []Status
	data        map[string]any
}

// Instance is one agent's running copy of a tree.
//
// Each tick starts at the root. Selectors are reactive: they try their
// children in priority order every tick, so a higher priority branch can
// interrupt a running lower one. Sequences and random selectors resume at the
// child that was running. A node that was not running on the previous tick is
// entered fresh: its memory is cleared and its decorators are checked; while
// it keeps running only `periodic` decorators are checked again.
type Instance struct {
	Tree       *Tree
	Reg        *Registry
	Agent      any
	Blackboard map[string]any
	Rand       *rand.Rand

	// Active is the sub_type of the deepest task that ran on the last tick,
	// handy for debugging and display.
	Active string

	// Tracing turns on Trace: every node visited by the last Tick, in the
	// order it was entered.
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

// NewInstance creates a runnable copy of t for agent.
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

// TraceStep records one node visited during a traced tick.
type TraceStep struct {
	Node   *Node
	Depth  int
	Status Status
	// Note says why the result is what it is: "blocked:<decorator>" when a
	// condition or cooldown stopped the node, "<decorator>" when a result
	// decorator changed it, and "service:<sub_type>" for each service that fired.
	Notes []string
}

// Tick runs the tree once at time now (seconds).
func (in *Instance) Tick(now float64) Status {
	in.tick++
	in.now = now
	in.Active = ""
	in.Trace = in.Trace[:0]
	in.depth = 0
	return in.run(in.Tree.Root)
}

// note adds a note to the trace step at index i, when tracing.
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
		// A service keeps its schedule across re-entries of its node, so
		// time_between_ticks holds even when the node finishes every tick.
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

// builtinDecorators are decorators that change a result instead of checking a
// condition. They need no game code.
var builtinDecorators = map[string]bool{"cooldown": true, "invert": true, "force_success": true}

// applyResultDecorators lets the result decorators of n change st. They also
// apply when a condition decorator blocked the node, so ForceSuccess can make
// an optional step (such as a line of speech on cooldown) never fail its parent.
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
