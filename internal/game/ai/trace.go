package ai

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
	"google.golang.org/protobuf/proto"
)

// maxTraceTicks 限制每个被观察实体在两次同步之间缓存的 tick 数。
const maxTraceTicks = 8

// recordTrace 将被追踪实体最近一次的 tick 复制到其缓冲区中。
func (sys *System) recordTrace(e *core.Entity) {
	// 时间保留两位小数：一帧 0.05 秒，保留一位会让相邻两帧时间相同
	tick := &pb.AiTick{Time: core.F32(math.Round(sys.s.Now()*100) / 100)}
	for _, st := range e.AI.Trace {
		tick.Nodes = append(tick.Nodes, &pb.AiNode{
			Node:   core.I32(st.Node.ID),
			Depth:  core.I32(st.Depth),
			Kind:   proto.String(string(st.Node.Kind)),
			Name:   proto.String(sys.nodeLabel(st.Node)),
			Status: pb.AiStatus(st.Status).Enum(),
			Notes:  append([]string(nil), st.Notes...),
			Fresh:  proto.Bool(st.Fresh),
			Why:    append([]string(nil), st.Why...),
		})
		n := tick.Nodes[len(tick.Nodes)-1]
		for _, c := range st.Checks {
			ck := &pb.AiCheck{Node: core.I32(c.Node.ID), Pass: proto.Bool(c.Pass)}
			if c.Why != "" {
				ck.Why = proto.String(c.Why)
			}
			n.Checks = append(n.Checks, ck)
		}
	}
	// 至少保留一个同步间隔的 tick，同步较慢时也不会丢弃任何数据
	limit := max(maxTraceTicks, sys.s.Cfg.World.TickRate/max(1, sys.s.Cfg.World.SyncRate))
	if len(e.AITicks) >= limit {
		e.AITicks = e.AITicks[1:]
	}
	e.AITicks = append(e.AITicks, tick)
}

// nodeLabel 用节点的 sub_type 和属性为其命名，例如 "cast_skill Slot=1"。
func (sys *System) nodeLabel(n *bt.Node) string {
	if l, ok := sys.labels[n]; ok {
		return l
	}
	keys := make([]string, 0, len(n.Props))
	for k := range n.Props {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(n.SubType)
	for _, k := range keys {
		fmt.Fprintf(&b, " %s=%v", k, n.Props[k])
	}
	sys.labels[n] = b.String()
	return sys.labels[n]
}

// Trace 为被观察实体构建追踪消息，无法构建时返回 nil。每次同步时，会为每个正在
// 观察的会话调用一次。defSent 是这个会话已经拿到结构的树名，和实体的树不同时附上整棵树的结构。
func (sys *System) Trace(e *core.Entity, defSent string) *pb.AiTrace {
	if e == nil || e.AI == nil {
		return nil
	}
	tr := &pb.AiTrace{Id: core.I32(e.ID), Tree: proto.String(e.AI.Tree.Name), Ticks: e.AITicks}
	if defSent != e.AI.Tree.Name {
		tr.Def = sys.treeDef(e.AI.Tree)
	}
	if len(e.Path) > 0 {
		tr.Path = append(tr.Path, float32(e.X), float32(e.Y))
		for _, p := range e.Path {
			tr.Path = append(tr.Path, float32(p.X), float32(p.Y))
		}
	}
	kv := func(k, v string) {
		tr.Blackboard = append(tr.Blackboard, &pb.KeyValue{Key: proto.String(k), Value: proto.String(v)})
	}
	target := "-"
	if t := sys.s.Ents.Get(e.Target); t != nil {
		target = fmt.Sprintf("%s#%d (%.0f)", t.Name, t.ID, core.EdgeDist(e, t))
	}
	kv("目标", target)
	kv("生命", fmt.Sprintf("%.0f / %.0f", e.HP, e.Attr.MaxHP))
	kv("离家", fmt.Sprintf("%.0f", e.HomeDist()))
	keys := make([]string, 0, len(e.AI.Blackboard))
	for k := range e.AI.Blackboard {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		kv(k, fmt.Sprint(e.AI.Blackboard[k]))
	}
	return tr
}

// ClearTraces 丢弃自上次同步以来记录的 tick。
func (sys *System) ClearTraces() {
	sys.s.Ents.Each(func(e *core.Entity) { e.AITicks = nil })
}

// treeDef 把整棵树的结构转成协议消息，按树缓存（树加载后不会变）。
func (sys *System) treeDef(t *bt.Tree) *pb.AiTreeDef {
	if d, ok := sys.defs[t]; ok {
		return d
	}
	ids := func(ns []*bt.Node) []int32 {
		out := make([]int32, len(ns))
		for i, n := range ns {
			out[i] = int32(n.ID)
		}
		return out
	}
	d := &pb.AiTreeDef{Root: core.I32(t.Root.ID)}
	for _, id := range sortedNodeIDs(t) {
		n := t.Nodes[id]
		tn := &pb.AiTreeNode{
			Id:         core.I32(n.ID),
			Kind:       proto.String(string(n.Kind)),
			SubType:    proto.String(n.SubType),
			Children:   ids(n.Children),
			Decorators: ids(n.Decorators),
			Services:   ids(n.Services),
		}
		if n.Label != "" {
			tn.Label = proto.String(n.Label)
		}
		keys := make([]string, 0, len(n.Props))
		for k := range n.Props {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			tn.Props = append(tn.Props, &pb.KeyValue{Key: proto.String(k), Value: proto.String(fmt.Sprint(n.Props[k]))})
		}
		switch n.Kind {
		case bt.KindDecorator:
			tn.Inverse = proto.Bool(n.Inverse)
			tn.Periodic = proto.Bool(n.Periodic)
		case bt.KindService:
			tn.Interval = core.F32(n.Interval)
		}
		d.Nodes = append(d.Nodes, tn)
	}
	sys.defs[t] = d
	return d
}

func sortedNodeIDs(t *bt.Tree) []int {
	ids := make([]int, 0, len(t.Nodes))
	for id := range t.Nodes {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	return ids
}
