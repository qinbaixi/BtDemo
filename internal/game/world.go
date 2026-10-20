package game

import (
	"context"
	"fmt"
	"log"
	"math"
	"math/rand"
	"time"

	"github.com/qinbaixi/BtDemo/internal/ai/trees"
	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/pb"

	"google.golang.org/protobuf/proto"
)

// Event is a one-off message such as damage, a cast or a death. It is sent to
// every player who can see the entity it happened at.
type Event = pb.Event

type pendingEvent struct {
	cell int
	ev   *Event
}

// World owns all game state. Everything runs on the goroutine that calls Run;
// other goroutines talk to it through Do.
type World struct {
	Cfg  *config.Config
	Grid *Grid
	Rand *rand.Rand
	Now  float64 // seconds since start
	Dt   float64 // seconds per tick

	trees    map[string]*bt.Tree
	reg      *bt.Registry
	ents     map[int]*Entity
	nextID   int
	sessions map[*Session]bool
	events   []pendingEvent
	inbox    chan func()
	tickNo   int
}

// NewWorld loads the behavior trees, validates them against the AI handlers and
// spawns the configured monsters and NPCs.
func NewWorld(cfg *config.Config, seed int64) (*World, error) {
	w := &World{
		Cfg:      cfg,
		Grid:     NewGrid(cfg.World.Map.Width, cfg.World.Map.Height, cfg.World.AOI.Cell),
		Rand:     rand.New(rand.NewSource(seed)),
		Dt:       1 / float64(cfg.World.TickRate),
		trees:    map[string]*bt.Tree{},
		reg:      bt.NewRegistry(),
		ents:     map[int]*Entity{},
		sessions: map[*Session]bool{},
		inbox:    make(chan func(), 256),
	}
	w.RegisterAI(w.reg)
	for name, exp := range trees.All {
		t, err := bt.Load(name, exp.RootID, exp.Nodes)
		if err != nil {
			return nil, err
		}
		if err := t.Validate(w.reg); err != nil {
			return nil, err
		}
		w.trees[name] = t
	}
	for _, tmpl := range cfg.Templates {
		if err := checkSlots(w.trees[tmpl.Tree], tmpl); err != nil {
			return nil, err
		}
	}
	for _, sp := range cfg.Spawns {
		for i := 0; i < sp.Count; i++ {
			x, y := w.scatter(sp.X, sp.Y, sp.Spread)
			w.spawnTemplate(cfg.Templates[sp.Template], x, y)
		}
	}
	return w, nil
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

// TreeNames lists the trees compiled into the binary.
func TreeNames() map[string]bool {
	out := map[string]bool{}
	for name := range trees.All {
		out[name] = true
	}
	return out
}

// Do runs fn on the world goroutine.
func (w *World) Do(fn func()) { w.inbox <- fn }

// Run advances the world until ctx is done.
func (w *World) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(float64(time.Second) * w.Dt))
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case fn := <-w.inbox:
			fn()
		case <-ticker.C:
			w.Step()
		}
	}
}

// Step advances the world by one tick.
func (w *World) Step() {
	w.tickNo++
	w.Now += w.Dt
	for _, e := range w.ents {
		if e.Dead {
			if w.Now >= e.RespawnAt {
				w.respawn(e)
			}
			continue
		}
		w.UpdateBuffs(e)
		if e.Kind == KindPlayer {
			if e.MoveX != 0 || e.MoveY != 0 {
				w.moveBy(e, e.MoveX*e.Attr.Speed*w.Dt, e.MoveY*e.Attr.Speed*w.Dt)
				e.Action = "move"
			} else {
				e.Action = ""
			}
			continue
		}
		if e.AI != nil {
			e.AI.Tick(w.Now)
			e.Action = e.AI.Active
		}
	}
	syncEvery := max(1, w.Cfg.World.TickRate/w.Cfg.World.SyncRate)
	if w.tickNo%syncEvery == 0 {
		w.flush()
	}
}

// Get returns the entity with the given id, or nil.
func (w *World) Get(id int) *Entity { return w.ents[id] }

// Hostile reports whether a attacks b.
func (w *World) Hostile(a, b *Entity) bool { return a != b && w.Cfg.Hostile(a.Faction, b.Faction) }

// NearestHostile returns the closest living entity within r that e is hostile to.
func (w *World) NearestHostile(e *Entity, r float64) *Entity {
	var best *Entity
	bestD := math.Inf(1)
	w.Grid.InRange(e.X, e.Y, r, func(o *Entity) {
		if o.Alive() && w.Hostile(e, o) {
			if d := Dist(e, o); d < bestD {
				best, bestD = o, d
			}
		}
	})
	return best
}

func (w *World) nearestMonster(e *Entity, r float64) *Entity {
	var best *Entity
	w.Grid.InRange(e.X, e.Y, r, func(o *Entity) {
		if o.Kind == KindMonster && o.Alive() && w.Hostile(e, o) && (best == nil || Dist(e, o) < Dist(e, best)) {
			best = o
		}
	})
	return best
}

// MoveToward moves e toward (x, y) by at most step pixels and reports whether
// it arrived.
func (w *World) MoveToward(e *Entity, x, y, step float64) bool {
	dx, dy := x-e.X, y-e.Y
	d := math.Hypot(dx, dy)
	if d <= step || d < 0.5 {
		w.moveBy(e, dx, dy)
		return true
	}
	w.moveBy(e, dx/d*step, dy/d*step)
	return false
}

func (w *World) moveBy(e *Entity, dx, dy float64) {
	m := w.Cfg.World.Map
	e.X = math.Max(e.Radius, math.Min(m.Width-e.Radius, e.X+dx))
	e.Y = math.Max(e.Radius, math.Min(m.Height-e.Radius, e.Y+dy))
	w.Grid.Moved(e)
}

// Say shows a speech bubble over e.
func (w *World) Say(e *Entity, text string) {
	w.Emit(e, &Event{Kind: pb.EventKind_SAY.Enum(), Id: i32(e.ID), Text: proto.String(text)})
}

// Emit queues ev for every player who can see e.
func (w *World) Emit(e *Entity, ev *Event) {
	w.events = append(w.events, pendingEvent{cell: w.Grid.CellOf(e.X, e.Y), ev: ev})
}

// Kill marks e dead, schedules its respawn and rewards the killer.
func (w *World) Kill(e, killer *Entity) {
	if e.Dead {
		return
	}
	e.Dead = true
	e.HP = 0
	e.Target = 0
	e.Buffs = nil // MoveX/MoveY stay so a held key keeps working after respawn
	e.Action = ""
	w.Emit(e, &Event{Kind: pb.EventKind_DIE.Enum(), Id: i32(e.ID)})
	delay := w.Cfg.World.Player.Respawn
	if e.Tmpl != nil {
		delay = e.Tmpl.Respawn
		if killer != nil && killer.Kind == KindPlayer {
			w.GainExp(killer, e.Tmpl.Exp)
		}
	}
	e.RespawnAt = w.Now + delay
	// The body stays in the grid so observers see it until it respawns.
}

func (w *World) respawn(e *Entity) {
	e.Dead = false
	e.X, e.Y = e.HomeX, e.HomeY
	if e.Kind == KindPlayer {
		sp := w.Cfg.World.Player.Spawn
		e.X, e.Y = w.scatter(sp.X, sp.Y, sp.Spread)
	}
	e.Cooldowns = map[string]float64{}
	e.LastAttacker, e.LastHitAt = 0, 0
	w.Recalc(e)
	e.HP = e.Attr.MaxHP
	if e.AI != nil {
		e.AI = bt.NewInstance(e.AI.Tree, w.reg, e.AI.Agent, w.Rand)
	}
	w.Grid.Moved(e)
	w.Emit(e, &Event{Kind: pb.EventKind_RESPAWN.Enum(), Id: i32(e.ID)})
}

func (w *World) scatter(x, y, spread float64) (float64, float64) {
	a := w.Rand.Float64() * 2 * math.Pi
	r := math.Sqrt(w.Rand.Float64()) * spread
	return x + math.Cos(a)*r, y + math.Sin(a)*r
}

func (w *World) newEntity() *Entity {
	w.nextID++
	return &Entity{ID: w.nextID, Cooldowns: map[string]float64{}}
}

func (w *World) skillsOf(ids []string) []*config.Skill {
	out := make([]*config.Skill, 0, len(ids))
	for _, id := range ids {
		out = append(out, w.Cfg.Skills[id])
	}
	return out
}

func (w *World) spawnTemplate(t *config.Template, x, y float64) *Entity {
	e := w.newEntity()
	e.Kind = Kind(t.Kind)
	e.Name, e.Faction, e.Color, e.Radius, e.Tmpl = t.Name, t.Faction, t.Color, t.Radius, t
	e.Model = t.Model
	e.X, e.Y, e.HomeX, e.HomeY = x, y, x, y
	e.Level, e.Base, e.Speed = t.Level, t.Attrs, t.Speed
	e.Skills = w.skillsOf(t.Skills)
	w.Recalc(e)
	e.HP = e.Attr.MaxHP
	e.AI = bt.NewInstance(w.trees[t.Tree], w.reg, &Agent{W: w, E: e}, w.Rand)
	w.ents[e.ID] = e
	w.Grid.Add(e)
	return e
}

func (w *World) spawnPlayer() *Entity {
	p := w.Cfg.World.Player
	e := w.newEntity()
	e.Kind, e.Faction = KindPlayer, "player"
	e.Name = fmt.Sprintf("%s%d", p.NamePrefix, e.ID)
	e.Color, e.Radius, e.Model = p.Color, p.Radius, p.Model
	e.X, e.Y = w.scatter(p.Spawn.X, p.Spawn.Y, p.Spawn.Spread)
	e.HomeX, e.HomeY = e.X, e.Y
	e.Level, e.Base, e.Growth, e.Speed = 1, p.Attrs, p.Growth, p.Speed
	e.Skills = w.skillsOf(p.Skills)
	for i := 1; i < p.Level; i++ {
		e.Level++
		addAttrs(&e.Base, e.Growth)
	}
	w.Recalc(e)
	e.HP = e.Attr.MaxHP
	w.ents[e.ID] = e
	w.Grid.Add(e)
	return e
}

func addAttrs(a *config.Attrs, b config.Attrs) {
	a.Str += b.Str
	a.Agi += b.Agi
	a.Int += b.Int
	a.Vit += b.Vit
}

// Session is one connected player.
type Session struct {
	Player  *Entity
	Out     chan []byte // encoded pb.ServerMsg frames
	visible map[int]bool
}

// Join creates a new character for a connection. Call it on the world goroutine.
func (w *World) Join() *Session {
	s := &Session{Player: w.spawnPlayer(), Out: make(chan []byte, 64), visible: map[int]bool{}}
	w.sessions[s] = true
	welcome := &pb.Welcome{
		Id:      i32(s.Player.ID),
		MapW:    f32(w.Cfg.World.Map.Width),
		MapH:    f32(w.Cfg.World.Map.Height),
		AoiCell: f32(w.Grid.Cell),
	}
	for i, sk := range s.Player.Skills {
		welcome.Skills = append(welcome.Skills, &pb.SkillInfo{
			Slot: i32(i + 1), Id: proto.String(sk.ID), Name: proto.String(sk.Name), Kind: proto.String(sk.Kind),
			Range: f32(sk.Range), Radius: f32(sk.Radius), Cooldown: f32(sk.Cooldown),
			Color: proto.String(sk.Color), Fx: proto.String(sk.FX),
		})
	}
	w.send(s, &pb.ServerMsg{Msg: &pb.ServerMsg_Welcome{Welcome: welcome}})
	return s
}

// Leave removes a session's character. Call it on the world goroutine.
func (w *World) Leave(s *Session) {
	if !w.sessions[s] {
		return
	}
	delete(w.sessions, s)
	w.Grid.Remove(s.Player)
	delete(w.ents, s.Player.ID)
	close(s.Out)
}

// Input applies a client message. Call it on the world goroutine.
func (w *World) Input(s *Session, msg *pb.ClientMsg) {
	e := s.Player
	switch m := msg.Msg.(type) {
	case *pb.ClientMsg_Move:
		dx, dy := float64(m.Move.GetDx()), float64(m.Move.GetDy())
		if d := math.Hypot(dx, dy); d > 0 && !math.IsNaN(d) && !math.IsInf(d, 0) {
			e.MoveX, e.MoveY = dx/d, dy/d
		} else {
			e.MoveX, e.MoveY = 0, 0
		}
	case *pb.ClientMsg_Target:
		e.Target = int(m.Target.GetId())
	case *pb.ClientMsg_Cast:
		slot := int(m.Cast.GetSlot())
		if slot < 1 || slot > len(e.Skills) {
			return
		}
		sk := e.Skills[slot-1]
		target := int(m.Cast.GetTarget())
		if target == 0 {
			target = e.Target
		}
		if t := w.Get(target); sk.Kind == "target" && (!t.Alive() || !w.Hostile(e, t) || EdgeDist(e, t) > sk.Range) {
			// No usable target selected: pick the nearest monster in reach.
			if t = w.nearestMonster(e, sk.Range+e.Radius+40); t != nil {
				target, e.Target = t.ID, t.ID
			}
		}
		if err := w.Cast(e, sk, target); err != nil {
			w.send(s, &pb.ServerMsg{Msg: &pb.ServerMsg_Toast{Toast: &pb.Toast{Text: proto.String(err.Error())}}})
		}
	}
}

func (w *World) send(s *Session, msg *pb.ServerMsg) {
	if !w.sessions[s] {
		return
	}
	data, err := proto.Marshal(msg)
	if err != nil {
		log.Printf("marshal: %v", err)
		return
	}
	select {
	case s.Out <- data:
	default:
		// The client fell behind. Dropping a frame would desync its AOI
		// state, so disconnect it instead; it reconnects with a fresh view.
		log.Printf("player %d: send buffer full, disconnecting", s.Player.ID)
		w.Leave(s)
	}
}

// flush sends AOI enter / leave, the state of visible entities, queued events
// and the player's own attributes to every session.
func (w *World) flush() {
	for s := range w.sessions {
		p := s.Player
		now := map[int]*Entity{}
		w.Grid.Neighbors(p.cell, func(e *Entity) { now[e.ID] = e })
		enter := &pb.Enter{}
		leave := &pb.Leave{}
		for id, e := range now {
			if !s.visible[id] {
				enter.Ents = append(enter.Ents, entityInfo(e))
			}
		}
		for id := range s.visible {
			if now[id] == nil {
				leave.Ids = append(leave.Ids, int32(id))
			}
		}
		s.visible = map[int]bool{}
		for id := range now {
			s.visible[id] = true
		}
		if len(leave.Ids) > 0 {
			w.send(s, &pb.ServerMsg{Msg: &pb.ServerMsg_Leave{Leave: leave}})
		}
		if len(enter.Ents) > 0 {
			w.send(s, &pb.ServerMsg{Msg: &pb.ServerMsg_Enter{Enter: enter}})
		}

		sync := &pb.Sync{Time: f32(round1(w.Now)), Self: w.selfInfo(p)}
		for _, e := range now {
			sync.Ents = append(sync.Ents, &pb.EntityState{
				Id: i32(e.ID), X: f32(round1(e.X)), Y: f32(round1(e.Y)),
				Hp: f32(math.Ceil(e.HP)), MaxHp: f32(math.Ceil(e.Attr.MaxHP)), Lv: i32(e.Level),
				Act: proto.String(e.Action), Tg: i32(e.Target), Dead: proto.Bool(e.Dead),
			})
		}
		pc := w.Grid.CellOf(p.X, p.Y)
		for _, pe := range w.events {
			if w.Grid.Sees(pc, pe.cell) {
				sync.Ev = append(sync.Ev, pe.ev)
			}
		}
		w.send(s, &pb.ServerMsg{Msg: &pb.ServerMsg_Sync{Sync: sync}})
	}
	w.events = w.events[:0]
}
