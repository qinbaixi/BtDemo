// Package core holds the data every game system shares: entities and their
// components, the entity table, the clock and the event queue. It has no
// game rules; those live in the system packages next to it.
package core

import (
	"math"

	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// Kind of an entity.
type Kind string

const (
	KindPlayer  Kind = "player"
	KindMonster Kind = "monster"
	KindNPC     Kind = "npc"
)

// Entity is a player, monster or NPC. Its fields are grouped into components,
// one per concern; they are embedded, so e.X or e.HP reads the same as before.
type Entity struct {
	Identity
	Transform
	Stats
	Combat
	Life
	Control
	Steering
	Brain
}

// Identity is what an entity is and how the client draws it.
type Identity struct {
	ID      int
	Kind    Kind
	Name    string
	Faction string
	Color   string
	Model   string           // client look, e.g. knight, slime
	Tmpl    *config.Template // nil for players
}

// Transform is where an entity is (owned by move and aoi).
type Transform struct {
	X, Y         float64
	HomeX, HomeY float64
	Radius       float64
}

// Stats are level, attributes and health (owned by attr).
type Stats struct {
	Level  int
	Exp    int
	Base   config.Attrs // base attributes including level growth
	Growth config.Attrs // added to Base on every level up
	Speed  float64      // base move speed before buffs
	Attr   Derived
	HP     float64
}

// Derived are the attributes computed from base attributes, level and buffs.
type Derived struct {
	MaxHP   float64
	Atk     float64 // physical attack
	MAtk    float64 // magic attack
	Def     float64 // physical defense
	MDef    float64 // magic defense
	Crit    float64 // crit chance 0..1
	CritDmg float64 // crit multiplier
	Speed   float64 // pixels per second
}

// Combat is an entity's skills, buffs and who it fights (owned by combat).
type Combat struct {
	Skills    []*config.Skill
	Cooldowns map[string]float64 // skill id -> time it is ready again
	Buffs     []*Buff

	Target       int     // entity id, 0 for none
	LastAttacker int     // entity id of the last attacker
	LastHitAt    float64 // time of the last hit taken
}

// Buff is an active timed modifier.
type Buff struct {
	Cfg   *config.Buff
	Until float64
}

// Life is whether an entity is dead and when it comes back (owned by spawn).
type Life struct {
	Dead      bool
	RespawnAt float64
}

// Control is a player's input (owned by session, read by move).
type Control struct {
	MoveX, MoveY float64 // input direction, normalized or zero
}

// Steering is the route a monster or NPC is walking (owned by move).
type Steering struct {
	Path     []nav.Vec // waypoints still ahead; the last one is the goal
	Goal     nav.Vec   // where the path was planned to
	Planned  bool
	RepathAt float64 // replan at this time even if the goal holds still
	StuckFor float64 // seconds spent barely moving while following the path
}

// Brain is a monster's or NPC's behavior tree (owned by ai).
type Brain struct {
	AI      *bt.Instance // nil for players
	Action  string       // what the entity is doing, for display
	AITicks []*pb.AiTick // traced ticks since the last sync, while watched
}

// MaxRadius bounds entity radii for range queries that test edge distance.
const MaxRadius = 64

// Alive reports whether e can act and be targeted.
func (e *Entity) Alive() bool { return e != nil && !e.Dead }

// Dist is the distance between the centers of a and b.
func Dist(a, b *Entity) float64 { return math.Hypot(a.X-b.X, a.Y-b.Y) }

// EdgeDist is the distance between the edges of a and b (never negative).
func EdgeDist(a, b *Entity) float64 { return math.Max(0, Dist(a, b)-a.Radius-b.Radius) }

// HomeDist is how far e is from its home point.
func (e *Entity) HomeDist() float64 { return math.Hypot(e.X-e.HomeX, e.Y-e.HomeY) }

// HPRatio is HP / MaxHP.
func (e *Entity) HPRatio() float64 {
	if e.Attr.MaxHP <= 0 {
		return 0
	}
	return e.HP / e.Attr.MaxHP
}
