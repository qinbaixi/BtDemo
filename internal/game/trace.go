package game

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/pb"
	"google.golang.org/protobuf/proto"
)

// maxTraceTicks bounds the ticks buffered per watched entity between syncs.
const maxTraceTicks = 8

// watchedIDs returns the entities some session is watching.
func (w *World) watchedIDs() map[int]bool {
	var ids map[int]bool
	for s := range w.sessions {
		if s.Watch != 0 {
			if ids == nil {
				ids = map[int]bool{}
			}
			ids[s.Watch] = true
		}
	}
	return ids
}

// recordTrace copies the last tick of a traced entity into its buffer.
func (w *World) recordTrace(e *Entity) {
	tick := &pb.AiTick{Time: f32(round1(w.Now))}
	for _, st := range e.AI.Trace {
		tick.Nodes = append(tick.Nodes, &pb.AiNode{
			Node:   i32(st.Node.ID),
			Depth:  i32(st.Depth),
			Kind:   proto.String(string(st.Node.Kind)),
			Name:   proto.String(w.nodeLabel(st.Node)),
			Status: pb.AiStatus(st.Status).Enum(),
			Notes:  append([]string(nil), st.Notes...),
		})
	}
	// keep at least one sync interval of ticks, so a slow sync rate drops none
	limit := max(maxTraceTicks, w.Cfg.World.TickRate/max(1, w.Cfg.World.SyncRate))
	if len(e.aiTicks) >= limit {
		e.aiTicks = e.aiTicks[1:]
	}
	e.aiTicks = append(e.aiTicks, tick)
}

// nodeLabel names a node by its sub_type and properties, e.g. "cast_skill Slot=1".
func (w *World) nodeLabel(n *bt.Node) string {
	if l, ok := w.labels[n]; ok {
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
	w.labels[n] = b.String()
	return w.labels[n]
}

// aiTrace builds the trace message for a watched entity, or nil.
func (w *World) aiTrace(e *Entity) *pb.AiTrace {
	if e == nil || e.AI == nil {
		return nil
	}
	tr := &pb.AiTrace{Id: i32(e.ID), Tree: proto.String(e.AI.Tree.Name), Ticks: e.aiTicks}
	kv := func(k, v string) {
		tr.Blackboard = append(tr.Blackboard, &pb.KeyValue{Key: proto.String(k), Value: proto.String(v)})
	}
	target := "-"
	if t := w.Get(e.Target); t != nil {
		target = fmt.Sprintf("%s#%d (%.0f)", t.Name, t.ID, EdgeDist(e, t))
	}
	kv("目标", target)
	kv("生命", fmt.Sprintf("%.0f / %.0f", e.HP, e.Attr.MaxHP))
	kv("离家", fmt.Sprintf("%.0f", math.Hypot(e.X-e.HomeX, e.Y-e.HomeY)))
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
