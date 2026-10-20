package game

import (
	"math"

	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// Kind of an entity.
type Kind string

const (
	KindPlayer  Kind = "player"
	KindMonster Kind = "monster"
	KindNPC     Kind = "npc"
)

// Derived are the attributes computed from base attributes, level and buffs.
type Derived struct {
	MaxHP   float64 `json:"maxHp"`
	Atk     float64 `json:"atk"`     // physical attack
	MAtk    float64 `json:"matk"`    // magic attack
	Def     float64 `json:"def"`     // physical defense
	MDef    float64 `json:"mdef"`    // magic defense
	Crit    float64 `json:"crit"`    // crit chance 0..1
	CritDmg float64 `json:"critDmg"` // crit multiplier
	Speed   float64 `json:"speed"`   // pixels per second
}

// Buff is an active timed modifier.
type Buff struct {
	Cfg   *config.Buff
	Until float64
}

// Entity is a player, monster or NPC.
type Entity struct {
	ID      int
	Kind    Kind
	Name    string
	Faction string
	Color   string
	Radius  float64
	Model   string           // client look, e.g. knight, slime
	Tmpl    *config.Template // nil for players

	X, Y         float64
	HomeX, HomeY float64

	Level  int
	Exp    int
	Base   config.Attrs // base attributes including level growth
	Growth config.Attrs // added to Base on every level up
	Speed  float64      // base move speed before buffs
	Attr   Derived
	HP     float64

	Skills    []*config.Skill
	Cooldowns map[string]float64 // skill id -> time it is ready again
	Buffs     []*Buff

	Target       int     // entity id, 0 for none
	LastAttacker int     // entity id of the last attacker
	LastHitAt    float64 // time of the last hit taken

	MoveX, MoveY float64 // player input direction (normalized or zero)

	Dead      bool
	RespawnAt float64

	AI     *bt.Instance // nil for players
	Action string       // what the entity is doing, for display

	cell    int
	inGrid  bool
	aiTicks []*pb.AiTick // traced ticks since the last sync, while watched
}

// maxEntityRadius bounds entity radii for range queries that test edge distance.
const maxEntityRadius = 64

// Alive reports whether e can act and be targeted.
func (e *Entity) Alive() bool { return e != nil && !e.Dead }

// Dist is the distance between the centers of a and b.
func Dist(a, b *Entity) float64 { return math.Hypot(a.X-b.X, a.Y-b.Y) }

// EdgeDist is the distance between the edges of a and b (never negative).
func EdgeDist(a, b *Entity) float64 { return math.Max(0, Dist(a, b)-a.Radius-b.Radius) }

// HPRatio is HP / MaxHP.
func (e *Entity) HPRatio() float64 {
	if e.Attr.MaxHP <= 0 {
		return 0
	}
	return e.HP / e.Attr.MaxHP
}
