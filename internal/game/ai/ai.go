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
	s      *core.State
	combat *combat.System
	move   *move.System
	reg    *bt.Registry
	trees  map[string]*bt.Tree
	labels map[*bt.Node]string        // 追踪标签，首次使用时构建
	defs   map[*bt.Tree]*pb.AiTreeDef // 发给调试面板的树结构，首次使用时构建
}

// New 加载所有导出的行为树，检查每棵树用到的节点类型都有对应的处理器，
// 并检查每个模板的 CastSkill 槽位都存在。
func New(s *core.State, cb *combat.System, mv *move.System) (*System, error) {
	a := &System{
		s: s, combat: cb, move: mv,
		reg:    bt.NewRegistry(),
		trees:  map[string]*bt.Tree{},
		labels: map[*bt.Node]string{},
		defs:   map[*bt.Tree]*pb.AiTreeDef{},
	}
	a.register()
	for name, exp := range trees.All {
		t, err := bt.Load(name, exp.RootID, exp.Nodes)
		if err != nil {
			return nil, err
		}
		if err := t.Validate(a.reg); err != nil {
			return nil, err
		}
		for id, l := range exp.Labels {
			if n := t.Nodes[id]; n != nil {
				n.Label = l
			}
		}
		a.trees[name] = t
	}
	for _, tmpl := range s.Cfg.Templates {
		if err := checkSlots(a.trees[tmpl.Tree], tmpl); err != nil {
			return nil, err
		}
	}
	return a, nil
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
func checkSlots(t *bt.Tree, tmpl *config.Template) error {
	for _, n := range t.Nodes {
		if n.Kind == bt.KindTask && n.SubType == "cast_skill" {
			if slot := int(n.Num("Slot", 1)); slot < 1 || slot > len(tmpl.Skills) {
				return fmt.Errorf("monsters.yaml: template %s has %d skills but tree %s casts slot %d (node %d)",
					tmpl.ID, len(tmpl.Skills), t.Name, slot, n.ID)
			}
		}
	}
	return nil
}

// Registry 返回节点处理器，用于校验额外的行为树（供测试使用）。
func (a *System) Registry() *bt.Registry { return a.reg }

// Attach 为 e 分配一个指定行为树的新实例。
func (a *System) Attach(e *core.Entity, tree string) {
	e.AI = a.Instance(e, a.trees[tree])
}

// Instance 创建一个驱动 e 的行为树实例。
func (a *System) Instance(e *core.Entity, t *bt.Tree) *bt.Instance {
	return bt.NewInstance(t, a.reg, &Agent{sys: a, E: e}, a.s.Rand)
}

// Reset 让 e 的行为树从头重新开始，例如在其重生之后。
func (a *System) Reset(e *core.Entity) {
	if e.AI != nil {
		e.AI = a.Instance(e, e.AI.Tree)
	}
}

// Tick 对每个存活实体的行为树执行一次 tick。watched 中的实体，其每次 tick 都会
// 记录下来供调试面板使用。
func (a *System) Tick(watched map[int]bool) {
	now := a.s.Now()
	a.s.Ents.Each(func(e *core.Entity) {
		if e.AI == nil || e.Dead {
			return
		}
		e.AI.Tracing = watched[e.ID]
		e.AI.Tick(now)
		e.Action = e.AI.Active
		if e.AI.Tracing {
			a.recordTrace(e)
		}
	})
}
