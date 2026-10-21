// Package ai runs the behavior trees exported from BtTree: it loads and
// validates them, attaches one to each monster and NPC, ticks them, and
// records decision traces for the debug drawer.
package ai

import (
	"fmt"

	"github.com/qinbaixi/BtDemo/internal/ai/trees"
	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/combat"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/move"
)

// System owns the behavior trees and the node handlers.
type System struct {
	s      *core.State
	combat *combat.System
	move   *move.System
	reg    *bt.Registry
	trees  map[string]*bt.Tree
	labels map[*bt.Node]string // trace labels, built on first use
}

// New loads every exported tree and checks that each node type it uses has a
// handler and that every template's CastSkill slots exist.
func New(s *core.State, cb *combat.System, mv *move.System) (*System, error) {
	a := &System{
		s: s, combat: cb, move: mv,
		reg:    bt.NewRegistry(),
		trees:  map[string]*bt.Tree{},
		labels: map[*bt.Node]string{},
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
		a.trees[name] = t
	}
	for _, tmpl := range s.Cfg.Templates {
		if err := checkSlots(a.trees[tmpl.Tree], tmpl); err != nil {
			return nil, err
		}
	}
	return a, nil
}

// TreeNames lists the trees compiled into the binary.
func TreeNames() map[string]bool {
	out := map[string]bool{}
	for name := range trees.All {
		out[name] = true
	}
	return out
}

// checkSlots makes sure every CastSkill in the template's tree points at one of its skills.
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

// Registry is the node handlers, for validating extra trees (used by tests).
func (a *System) Registry() *bt.Registry { return a.reg }

// Attach gives e a fresh instance of the named tree.
func (a *System) Attach(e *core.Entity, tree string) {
	e.AI = a.Instance(e, a.trees[tree])
}

// Instance creates a behavior tree instance driving e.
func (a *System) Instance(e *core.Entity, t *bt.Tree) *bt.Instance {
	return bt.NewInstance(t, a.reg, &Agent{sys: a, E: e}, a.s.Rand)
}

// Reset restarts e's tree from scratch, e.g. after it respawns.
func (a *System) Reset(e *core.Entity) {
	if e.AI != nil {
		e.AI = a.Instance(e, e.AI.Tree)
	}
}

// Tick runs one tick of every living entity's tree. Entities in watched get
// their tick recorded for the debug drawer.
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
