// Package bt 运行 owl-bt（BtTree）导出为 Go 源码的行为树。
//
// 导出器为每棵树生成一个 `map[int]map[string]any`，以节点 id 为键。每个条目都有 `node_id`、
// `type`（composite / task / decorator / service 之一）和 `sub_type`；节点通过 id 列出其
// `children`、`decorators` 和 `services`，叶子条目带有 `properties` 映射。本包将这些数据
// 转换为 Tree 并对其进行 tick，而游戏则通过 Registry 将每个 `sub_type` 绑定到真实代码。
package bt

import (
	"fmt"
	"sort"
)

// Kind 是条目导出的 `type`。
type Kind string

const (
	KindComposite Kind = "composite"
	KindTask      Kind = "task"
	KindDecorator Kind = "decorator"
	KindService   Kind = "service"
)

// Node 是一个导出的条目：composite、task、decorator 或 service 之一。
type Node struct {
	ID         int
	Kind       Kind
	SubType    string
	Label      string // 编辑器里给节点起的名字，只用于调试显示，可以为空
	Props      map[string]any
	Children   []*Node
	Decorators []*Node
	Services   []*Node

	// 装饰器字段。
	Inverse  bool
	Periodic bool

	// 服务字段，单位为秒。
	Interval  float64
	FirstTick float64
}

// Num 返回数值属性；若该属性不存在，则返回 def。
func (node *Node) Num(name string, def float64) float64 {
	switch v := node.Props[name].(type) {
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case float64:
		return v
	}
	return def
}

// Str 返回字符串属性；若该属性不存在，则返回 def。
func (node *Node) Str(name, def string) string {
	if value, ok := node.Props[name].(string); ok {
		return value
	}
	return def
}

// Tree 是已加载的行为树。
type Tree struct {
	Name  string
	Root  *Node
	Nodes map[int]*Node
}

// Load 根据 owl-bt 为 Go 导出的数据（`<Prefix>RootID` 和 `<Prefix>Nodes`）构建 Tree。
func Load(name string, rootID int, raw map[int]map[string]any) (*Tree, error) {
	tree := &Tree{Name: name, Nodes: make(map[int]*Node, len(raw))}
	ids := make([]int, 0, len(raw))
	for id := range raw {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	for _, id := range ids {
		entry := raw[id]
		node := &Node{ID: id, Props: map[string]any{}}
		kind, _ := entry["type"].(string)
		node.Kind = Kind(kind)
		node.SubType = fmt.Sprint(entry["sub_type"])
		if props, ok := entry["properties"].(map[string]any); ok {
			node.Props = props
		}
		node.Inverse, _ = entry["inverse_check_condition"].(bool)
		node.Periodic, _ = entry["periodic"].(bool)
		node.Interval = toFloat(entry["time_between_ticks"])
		node.FirstTick = toFloat(entry["first_tick_time"])
		tree.Nodes[id] = node
	}
	for _, id := range ids {
		entry, node := raw[id], tree.Nodes[id]
		var err error
		if node.Children, err = tree.refs(entry, "children", id); err != nil {
			return nil, err
		}
		if node.Decorators, err = tree.refs(entry, "decorators", id); err != nil {
			return nil, err
		}
		if node.Services, err = tree.refs(entry, "services", id); err != nil {
			return nil, err
		}
	}
	tree.Root = tree.Nodes[rootID]
	if tree.Root == nil {
		return nil, fmt.Errorf("bt %s: root node %d missing", name, rootID)
	}
	return tree, nil
}

func (tree *Tree) refs(entry map[string]any, key string, owner int) ([]*Node, error) {
	ids, ok := entry[key].([]int)
	if !ok {
		return nil, nil
	}
	out := make([]*Node, 0, len(ids))
	for _, id := range ids {
		node := tree.Nodes[id]
		if node == nil {
			return nil, fmt.Errorf(
				"bt %s: node %d references missing %s %d",
				tree.Name,
				owner,
				key,
				id,
			)
		}
		out = append(out, node)
	}
	return out, nil
}

// Validate 检查树中的每个条目在 reg 中都有对应的处理函数。
func (tree *Tree) Validate(reg *Registry) error {
	for _, id := range sortedIDs(tree.Nodes) {
		node := tree.Nodes[id]
		var ok bool
		switch node.Kind {
		case KindComposite:
			_, ok = composites[node.SubType]
		case KindTask:
			_, ok = reg.tasks[node.SubType]
		case KindDecorator:
			_, ok = reg.conditions[node.SubType]
			if !ok {
				_, ok = builtinDecorators[node.SubType]
			}
		case KindService:
			_, ok = reg.services[node.SubType]
		}
		if !ok {
			return fmt.Errorf(
				"bt %s: no handler for %s %q (node %d)",
				tree.Name,
				node.Kind,
				node.SubType,
				node.ID,
			)
		}
	}
	return nil
}

func sortedIDs(nodes map[int]*Node) []int {
	ids := make([]int, 0, len(nodes))
	for id := range nodes {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	return ids
}

func toFloat(value any) float64 {
	switch x := value.(type) {
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case float64:
		return x
	}
	return 0
}
