package core

import (
	"math"
	"math/rand"
	"slices"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// State is the shared world state handed to every system: config, clock,
// randomness, the entity table and the event queue.
type State struct {
	Cfg    *config.Config
	Rand   *rand.Rand
	Clock  Clock
	Ents   Entities
	Events Events
}

// NewState creates an empty world state.
func NewState(cfg *config.Config, seed int64) *State {
	return &State{
		Cfg:   cfg,
		Rand:  rand.New(rand.NewSource(seed)),
		Clock: Clock{Dt: 1 / float64(cfg.World.TickRate)},
		Ents:  Entities{byID: map[int]*Entity{}},
	}
}

// Now is the current game time in seconds.
func (s *State) Now() float64 { return s.Clock.Now }

// Hostile reports whether a attacks b.
func (s *State) Hostile(a, b *Entity) bool { return a != b && s.Cfg.Hostile(a.Faction, b.Faction) }

// Scatter returns a random point within spread of (x, y).
func (s *State) Scatter(x, y, spread float64) (float64, float64) {
	a := s.Rand.Float64() * 2 * math.Pi
	r := math.Sqrt(s.Rand.Float64()) * spread
	return x + math.Cos(a)*r, y + math.Sin(a)*r
}

// Clock is game time, advanced one fixed tick at a time.
type Clock struct {
	Now  float64 // seconds since start
	Dt   float64 // seconds per tick
	Tick int     // ticks since start
}

// Advance moves the clock one tick forward.
func (c *Clock) Advance() {
	c.Tick++
	c.Now += c.Dt
}

// Entities is the table of every entity in the world.
type Entities struct {
	byID   map[int]*Entity
	ids    []int // sorted, for a deterministic Each
	nextID int
}

// New creates an entity with a fresh id. It is not in the table until Add.
func (t *Entities) New() *Entity {
	t.nextID++
	return &Entity{Identity: Identity{ID: t.nextID}, Combat: Combat{Cooldowns: map[string]float64{}}}
}

// Add puts e into the table.
func (t *Entities) Add(e *Entity) {
	if _, ok := t.byID[e.ID]; !ok {
		i, _ := slices.BinarySearch(t.ids, e.ID)
		t.ids = slices.Insert(t.ids, i, e.ID)
	}
	t.byID[e.ID] = e
	t.nextID = max(t.nextID, e.ID)
}

// Remove takes e out of the table.
func (t *Entities) Remove(e *Entity) {
	if _, ok := t.byID[e.ID]; !ok {
		return
	}
	delete(t.byID, e.ID)
	if i, found := slices.BinarySearch(t.ids, e.ID); found {
		t.ids = slices.Delete(t.ids, i, i+1)
	}
}

// Get returns the entity with the given id, or nil.
func (t *Entities) Get(id int) *Entity { return t.byID[id] }

// Each calls fn for every entity in id order, so a tick is deterministic for
// a given seed.
func (t *Entities) Each(fn func(*Entity)) {
	for _, id := range slices.Clone(t.ids) { // fn may add or remove entities
		if e := t.byID[id]; e != nil {
			fn(e)
		}
	}
}

// Event is something that happened, sent with the next sync to every player
// who can see where it happened.
type Event = pb.Event

// PendingEvent is a queued event and where it happened.
type PendingEvent struct {
	X, Y float64
	Ev   *Event
}

// Events is the queue of events since the last sync.
type Events struct {
	list []PendingEvent
}

// Emit queues ev at e's position.
func (q *Events) Emit(e *Entity, ev *Event) {
	q.list = append(q.list, PendingEvent{X: e.X, Y: e.Y, Ev: ev})
}

// List returns the queued events.
func (q *Events) List() []PendingEvent { return q.list }

// Clear empties the queue.
func (q *Events) Clear() { q.list = q.list[:0] }
