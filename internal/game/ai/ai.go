// Package ai 负责运行从 BtTree 导出的行为树：加载并校验这些树，为每个怪物和 NPC 挂载一棵树，
// 驱动其 tick，并为调试面板记录决策轨迹。
package ai

import (
	"fmt"

	"github.com/qinbaixi/BtDemo/internal/ai/trees"
	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/combat"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/move"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// System 持有行为树和节点处理器。
type System struct {
	state  *core.State
	combat *combat.System
	move   *move.System
	reg    *bt.Registry
	trees  map[string]*bt.Tree
	labels map[*bt.Node]string        // 追踪标签，首次使用时构建
	defs   map[*bt.Tree]*pb.AiTreeDef // 发给调试面板的树结构，首次使用时构建
}

// New 加载所有导出的行为树，检查每棵树用到的节点类型都有对应的处理器，
// 并检查每个模板的 CastSkill 槽位都存在。
func New(state *core.State, combatSys *combat.System, moveSys *move.System) (*System, error) {
	sys := &System{
		state: state, combat: combatSys, move: moveSys,
		reg:    bt.NewRegistry(),
		trees:  map[string]*bt.Tree{},
		labels: map[*bt.Node]string{},
		defs:   map[*bt.Tree]*pb.AiTreeDef{},
	}
	sys.register()
	for name, exp := range trees.All {
		tree, err := bt.Load(name, exp.RootID, exp.Nodes)
		if err != nil {
			return nil, err
		}
		if err := tree.Validate(sys.reg); err != nil {
			return nil, err
		}
		for id, label := range exp.Labels {
			if node := tree.Nodes[id]; node != nil {
				node.Label = label
			}
		}
		sys.trees[name] = tree
	}
	for _, tmpl := range state.Cfg.Templates {
		if err := checkSlots(sys.trees[tmpl.Tree], tmpl); err != nil {
			return nil, err
		}
	}
	return sys, nil
}

// TreeNames 列出编译进二进制文件中的行为树。
func TreeNames() map[string]bool {
	out := map[string]bool{}
	for name := range trees.All {
		out[name] = true
	}
	return out
}

// checkSlots 确保模板行为树中的每个 CastSkill 都指向该模板的某个技能。
func checkSlots(tree *bt.Tree, tmpl *config.Template) error {
	for _, node := range tree.Nodes {
		if node.Kind == bt.KindTask && node.SubType == "cast_skill" {
			if slot := int(node.Num("Slot", 1)); slot < 1 || slot > len(tmpl.Skills) {
				return fmt.Errorf(
					"monsters.yaml: template %s has %d skills but tree %s casts slot %d (node %d)",
					tmpl.ID,
					len(tmpl.Skills),
					tree.Name,
					slot,
					node.ID,
				)
			}
		}
	}
	return nil
}

// Registry 返回节点处理器，用于校验额外的行为树（供测试使用）。
func (sys *System) Registry() *bt.Registry { return sys.reg }

// Attach 为 e 分配一个指定行为树的新实例。
func (sys *System) Attach(entity *core.Entity, tree string) {
	entity.AI = sys.Instance(entity, sys.trees[tree])
}

// Instance 创建一个驱动 e 的行为树实例。
func (sys *System) Instance(entity *core.Entity, tree *bt.Tree) *bt.Instance {
	return bt.NewInstance(tree, sys.reg, &Agent{sys: sys, Entity: entity}, sys.state.Rand)
}

// Reset 让 e 的行为树从头重新开始，例如在其重生之后。
func (sys *System) Reset(entity *core.Entity) {
	if entity.AI != nil {
		entity.AI = sys.Instance(entity, entity.AI.Tree)
	}
}

// Tick 对每个存活实体的行为树执行一次 tick。watched 中的实体，其每次 tick 都会
// 记录下来供调试面板使用。
func (sys *System) Tick(watched map[int]bool) {
	now := sys.state.Now()
	sys.state.Ents.Each(func(entity *core.Entity) {
		if entity.AI == nil || entity.Dead {
			return
		}
		entity.AI.Tracing = watched[entity.ID]
		entity.AI.Tick(now)
		entity.Action = entity.AI.Active
		if entity.AI.Tracing {
			sys.recordTrace(entity)
		}
	})
}
