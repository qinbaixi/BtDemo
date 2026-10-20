// Package bt runs behavior trees exported by owl-bt (BtTree) as Go source.
//
// The exporter produces one map per tree, `map[int]map[string]any`, keyed by
// node id. Every entry has `node_id`, `type` (composite / task / decorator /
// service) and `sub_type`; nodes list their `children`, `decorators` and
// `services` by id, and leaf items carry a `properties` map. This package turns
// that data into a Tree and ticks it, while the game binds each `sub_type` to
// real code through a Registry.
package bt

import (
	"fmt"
	"sort"
)

// Kind is the exported `type` of an item.
type Kind string

const (
	KindComposite Kind = "composite"
	KindTask      Kind = "task"
	KindDecorator Kind = "decorator"
	KindService   Kind = "service"
)

// Node is one exported item: a composite, a task, a decorator or a service.
type Node struct {
	ID         int
	Kind       Kind
	SubType    string
	Props      map[string]any
	Children   []*Node
	Decorators []*Node
	Services   []*Node

	// Decorator fields.
	Inverse  bool
	Periodic bool

	// Service fields, in seconds.
	Interval  float64
	FirstTick float64
}

// Num returns a numeric property, or def when it is missing.
func (n *Node) Num(name string, def float64) float64 {
	switch v := n.Props[name].(type) {
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case float64:
		return v
	}
	return def
}

// Str returns a string property, or def when it is missing.
func (n *Node) Str(name, def string) string {
	if v, ok := n.Props[name].(string); ok {
		return v
	}
	return def
}

// Tree is a loaded behavior tree.
type Tree struct {
	Name  string
	Root  *Node
	Nodes map[int]*Node
}

// Load builds a Tree from the data owl-bt exports for Go
// (`<Prefix>RootID` and `<Prefix>Nodes`).
func Load(name string, rootID int, raw map[int]map[string]any) (*Tree, error) {
	t := &Tree{Name: name, Nodes: make(map[int]*Node, len(raw))}
	ids := make([]int, 0, len(raw))
	for id := range raw {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	for _, id := range ids {
		entry := raw[id]
		n := &Node{ID: id, Props: map[string]any{}}
		kind, _ := entry["type"].(string)
		n.Kind = Kind(kind)
		n.SubType = fmt.Sprint(entry["sub_type"])
		if p, ok := entry["properties"].(map[string]any); ok {
			n.Props = p
		}
		n.Inverse, _ = entry["inverse_check_condition"].(bool)
		n.Periodic, _ = entry["periodic"].(bool)
		n.Interval = toFloat(entry["time_between_ticks"])
		n.FirstTick = toFloat(entry["first_tick_time"])
		t.Nodes[id] = n
	}
	for _, id := range ids {
		entry, n := raw[id], t.Nodes[id]
		var err error
		if n.Children, err = t.refs(entry, "children", id); err != nil {
			return nil, err
		}
		if n.Decorators, err = t.refs(entry, "decorators", id); err != nil {
			return nil, err
		}
		if n.Services, err = t.refs(entry, "services", id); err != nil {
			return nil, err
		}
	}
	t.Root = t.Nodes[rootID]
	if t.Root == nil {
		return nil, fmt.Errorf("bt %s: root node %d missing", name, rootID)
	}
	return t, nil
}

func (t *Tree) refs(entry map[string]any, key string, owner int) ([]*Node, error) {
	ids, ok := entry[key].([]int)
	if !ok {
		return nil, nil
	}
	out := make([]*Node, 0, len(ids))
	for _, id := range ids {
		n := t.Nodes[id]
		if n == nil {
			return nil, fmt.Errorf("bt %s: node %d references missing %s %d", t.Name, owner, key, id)
		}
		out = append(out, n)
	}
	return out, nil
}

// Validate checks that every item of the tree has a handler in reg.
func (t *Tree) Validate(reg *Registry) error {
	for _, id := range sortedIDs(t.Nodes) {
		n := t.Nodes[id]
		var ok bool
		switch n.Kind {
		case KindComposite:
			_, ok = composites[n.SubType]
		case KindTask:
			_, ok = reg.tasks[n.SubType]
		case KindDecorator:
			_, ok = reg.conditions[n.SubType]
			if !ok {
				_, ok = builtinDecorators[n.SubType]
			}
		case KindService:
			_, ok = reg.services[n.SubType]
		}
		if !ok {
			return fmt.Errorf("bt %s: no handler for %s %q (node %d)", t.Name, n.Kind, n.SubType, n.ID)
		}
	}
	return nil
}

func sortedIDs(m map[int]*Node) []int {
	ids := make([]int, 0, len(m))
	for id := range m {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	return ids
}

func toFloat(v any) float64 {
	switch x := v.(type) {
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case float64:
		return x
	}
	return 0
}
