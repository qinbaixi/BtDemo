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
func (sys *System) recordTrace(entity *core.Entity) {
	// 时间保留两位小数：一帧 0.05 秒，保留一位会让相邻两帧时间相同
	tick := &pb.AiTick{Time: core.F32(math.Round(sys.state.Now()*100) / 100)}
	for _, step := range entity.AI.Trace {
		tick.Nodes = append(tick.Nodes, &pb.AiNode{
			Node:   core.I32(step.Node.ID),
			Depth:  core.I32(step.Depth),
			Kind:   proto.String(string(step.Node.Kind)),
			Name:   proto.String(sys.nodeLabel(step.Node)),
			Status: pb.AiStatus(step.Status).Enum(),
			Notes:  append([]string(nil), step.Notes...),
			Fresh:  proto.Bool(step.Fresh),
			Why:    append([]string(nil), step.Why...),
		})
		aiNode := tick.Nodes[len(tick.Nodes)-1]
		for _, check := range step.Checks {
			pbCheck := &pb.AiCheck{Node: core.I32(check.Node.ID), Pass: proto.Bool(check.Pass)}
			if check.Why != "" {
				pbCheck.Why = proto.String(check.Why)
			}
			aiNode.Checks = append(aiNode.Checks, pbCheck)
		}
	}
	// 至少保留一个同步间隔的 tick，同步较慢时也不会丢弃任何数据
	limit := max(maxTraceTicks, sys.state.Cfg.World.TickRate/max(1, sys.state.Cfg.World.SyncRate))
	if len(entity.AITicks) >= limit {
		entity.AITicks = entity.AITicks[1:]
	}
	entity.AITicks = append(entity.AITicks, tick)
}

// nodeLabel 用节点的 sub_type 和属性为其命名，例如 "cast_skill Slot=1"。
func (sys *System) nodeLabel(node *bt.Node) string {
	if label, ok := sys.labels[node]; ok {
		return label
	}
	keys := make([]string, 0, len(node.Props))
	for k := range node.Props {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var text strings.Builder
	text.WriteString(node.SubType)
	for _, k := range keys {
		fmt.Fprintf(&text, " %s=%v", k, node.Props[k])
	}
	sys.labels[node] = text.String()
	return sys.labels[node]
}

// Trace 为被观察实体构建追踪消息，无法构建时返回 nil。每次同步时，会为每个正在
// 观察的会话调用一次。defSent 是这个会话已经拿到结构的树名，和实体的树不同时附上整棵树的结构。
func (sys *System) Trace(entity *core.Entity, defSent string) *pb.AiTrace {
	if entity == nil || entity.AI == nil {
		return nil
	}
	trace := &pb.AiTrace{
		Id:    core.I32(entity.ID),
		Tree:  proto.String(entity.AI.Tree.Name),
		Ticks: entity.AITicks,
	}
	if defSent != entity.AI.Tree.Name {
		trace.Def = sys.treeDef(entity.AI.Tree)
	}
	if len(entity.Path) > 0 {
		trace.Path = append(trace.Path, float32(entity.X), float32(entity.Y))
		for _, point := range entity.Path {
			trace.Path = append(trace.Path, float32(point.X), float32(point.Y))
		}
	}
	kv := func(k, v string) {
		trace.Blackboard = append(
			trace.Blackboard,
			&pb.KeyValue{Key: proto.String(k), Value: proto.String(v)},
		)
	}
	target := "-"
	if targetEnt := sys.state.Ents.Get(entity.Target); targetEnt != nil {
		target = fmt.Sprintf(
			"%s#%d (%.0f)",
			targetEnt.Name,
			targetEnt.ID,
			core.EdgeDist(entity, targetEnt),
		)
	}
	kv("目标", target)
	kv("生命", fmt.Sprintf("%.0f / %.0f", entity.HP, entity.Attr.MaxHP))
	kv("离家", fmt.Sprintf("%.0f", entity.HomeDist()))
	keys := make([]string, 0, len(entity.AI.Blackboard))
	for k := range entity.AI.Blackboard {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		kv(k, fmt.Sprint(entity.AI.Blackboard[k]))
	}
	return trace
}

// ClearTraces 丢弃自上次同步以来记录的 tick。
func (sys *System) ClearTraces() {
	sys.state.Ents.Each(func(entity *core.Entity) { entity.AITicks = nil })
}

// treeDef 把整棵树的结构转成协议消息，按树缓存（树加载后不会变）。
func (sys *System) treeDef(tree *bt.Tree) *pb.AiTreeDef {
	if def, ok := sys.defs[tree]; ok {
		return def
	}
	ids := func(nodes []*bt.Node) []int32 {
		out := make([]int32, len(nodes))
		for i, node := range nodes {
			out[i] = int32(node.ID)
		}
		return out
	}
	def := &pb.AiTreeDef{Root: core.I32(tree.Root.ID)}
	for _, id := range sortedNodeIDs(tree) {
		node := tree.Nodes[id]
		treeNode := &pb.AiTreeNode{
			Id:         core.I32(node.ID),
			Kind:       proto.String(string(node.Kind)),
			SubType:    proto.String(node.SubType),
			Children:   ids(node.Children),
			Decorators: ids(node.Decorators),
			Services:   ids(node.Services),
		}
		if node.Label != "" {
			treeNode.Label = proto.String(node.Label)
		}
		keys := make([]string, 0, len(node.Props))
		for k := range node.Props {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			treeNode.Props = append(
				treeNode.Props,
				&pb.KeyValue{Key: proto.String(k), Value: proto.String(fmt.Sprint(node.Props[k]))},
			)
		}
		switch node.Kind {
		case bt.KindDecorator:
			treeNode.Inverse = proto.Bool(node.Inverse)
			treeNode.Periodic = proto.Bool(node.Periodic)
		case bt.KindService:
			treeNode.Interval = core.F32(node.Interval)
		}
		def.Nodes = append(def.Nodes, treeNode)
	}
	sys.defs[tree] = def
	return def
}

func sortedNodeIDs(tree *bt.Tree) []int {
	ids := make([]int, 0, len(tree.Nodes))
	for id := range tree.Nodes {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	return ids
}
