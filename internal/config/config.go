// Package config loads the YAML files under config/.
package config

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// Attrs are the four base attributes.
type Attrs struct {
	Str float64 `yaml:"str" json:"str"`
	Agi float64 `yaml:"agi" json:"agi"`
	Int float64 `yaml:"int" json:"int"`
	Vit float64 `yaml:"vit" json:"vit"`
}

// Point is a spawn position with a random spread radius.
type Point struct {
	X      float64 `yaml:"x"`
	Y      float64 `yaml:"y"`
	Spread float64 `yaml:"spread"`
}

// Player is the template every new connection gets.
type Player struct {
	NamePrefix string   `yaml:"name_prefix"`
	Spawn      Point    `yaml:"spawn"`
	Level      int      `yaml:"level"`
	Attrs      Attrs    `yaml:"attrs"`
	Growth     Attrs    `yaml:"growth"`
	Speed      float64  `yaml:"speed"`
	Radius     float64  `yaml:"radius"`
	Color      string   `yaml:"color"`
	Model      string   `yaml:"model"`
	Respawn    float64  `yaml:"respawn"`
	Skills     []string `yaml:"skills"`
}

// World is config/world.yaml.
type World struct {
	Map struct {
		Width  float64 `yaml:"width"`
		Height float64 `yaml:"height"`
	} `yaml:"map"`
	AOI struct {
		Cell float64 `yaml:"cell"`
	} `yaml:"aoi"`
	TickRate int                 `yaml:"tick_rate"`
	SyncRate int                 `yaml:"sync_rate"`
	Hostile  map[string][]string `yaml:"hostile"`
	Player   Player              `yaml:"player"`
}

// Buff is a timed attribute modifier granted by a skill.
type Buff struct {
	Name     string  `yaml:"name"`
	Duration float64 `yaml:"duration"`
	AtkPct   float64 `yaml:"atk_pct"`
	DefPct   float64 `yaml:"def_pct"`
	SpeedPct float64 `yaml:"speed_pct"`
}

// Skill is one entry of config/skills.yaml.
type Skill struct {
	ID       string  `yaml:"-"`
	Name     string  `yaml:"name"`
	Kind     string  `yaml:"kind"` // target | aoe | self
	Range    float64 `yaml:"range"`
	Radius   float64 `yaml:"radius"`
	Cooldown float64 `yaml:"cooldown"`
	Damage   string  `yaml:"damage"` // physical | magic | ""
	Ratio    float64 `yaml:"ratio"`
	Base     float64 `yaml:"base"`
	Heal     float64 `yaml:"heal"`
	Buff     *Buff   `yaml:"buff"`
	FX       string  `yaml:"fx"`
	Color    string  `yaml:"color"`
}

// Template is a monster or NPC template from config/monsters.yaml.
type Template struct {
	ID      string   `yaml:"-"`
	Name    string   `yaml:"name"`
	Kind    string   `yaml:"kind"` // monster | npc
	Faction string   `yaml:"faction"`
	Tree    string   `yaml:"tree"`
	Level   int      `yaml:"level"`
	Attrs   Attrs    `yaml:"attrs"`
	Speed   float64  `yaml:"speed"`
	Radius  float64  `yaml:"radius"`
	Color   string   `yaml:"color"`
	Model   string   `yaml:"model"` // client look; defaults to the template id
	Skills  []string `yaml:"skills"`
	Respawn float64  `yaml:"respawn"`
	Exp     int      `yaml:"exp"`
}

// Spawn places Count copies of a template around (X, Y).
type Spawn struct {
	Template string  `yaml:"template"`
	X        float64 `yaml:"x"`
	Y        float64 `yaml:"y"`
	Count    int     `yaml:"count"`
	Spread   float64 `yaml:"spread"`
}

// Config is everything loaded from the config folder.
type Config struct {
	World     World
	Skills    map[string]*Skill
	Templates map[string]*Template
	Spawns    []Spawn
}

// Load reads world.yaml, skills.yaml and monsters.yaml from dir and checks
// that every reference resolves. knownTrees lists the behavior trees compiled
// into the binary.
func Load(dir string, knownTrees map[string]bool) (*Config, error) {
	c := &Config{}
	if err := readYAML(filepath.Join(dir, "world.yaml"), &c.World); err != nil {
		return nil, err
	}
	var skills struct {
		Skills map[string]*Skill `yaml:"skills"`
	}
	if err := readYAML(filepath.Join(dir, "skills.yaml"), &skills); err != nil {
		return nil, err
	}
	c.Skills = skills.Skills
	var monsters struct {
		Templates map[string]*Template `yaml:"templates"`
		Spawns    []Spawn              `yaml:"spawns"`
	}
	if err := readYAML(filepath.Join(dir, "monsters.yaml"), &monsters); err != nil {
		return nil, err
	}
	c.Templates, c.Spawns = monsters.Templates, monsters.Spawns
	return c, c.validate(knownTrees)
}

func readYAML(path string, out any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := yaml.Unmarshal(data, out); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

func (c *Config) validate(knownTrees map[string]bool) error {
	w := &c.World
	if w.Map.Width <= 0 || w.Map.Height <= 0 || w.AOI.Cell <= 0 {
		return fmt.Errorf("world.yaml: map size and aoi.cell must be positive")
	}
	if w.TickRate <= 0 {
		w.TickRate = 20
	}
	if w.SyncRate <= 0 {
		w.SyncRate = 10
	}
	if w.Player.Level <= 0 {
		w.Player.Level = 1
	}
	if w.Player.Model == "" {
		w.Player.Model = "knight"
	}
	for f, targets := range w.Hostile {
		for _, t := range targets {
			if _, ok := w.Hostile[t]; !ok {
				return fmt.Errorf("world.yaml: hostile.%s lists unknown faction %q", f, t)
			}
		}
	}
	if _, ok := w.Hostile["player"]; !ok {
		return fmt.Errorf("world.yaml: hostile must have a player entry")
	}
	for id, s := range c.Skills {
		s.ID = id
		switch s.Kind {
		case "target", "aoe", "self":
		default:
			return fmt.Errorf("skills.yaml: skill %s has unknown kind %q", id, s.Kind)
		}
		switch s.Damage {
		case "", "physical", "magic":
		default:
			return fmt.Errorf("skills.yaml: skill %s has unknown damage %q", id, s.Damage)
		}
	}
	checkSkills := func(owner string, ids []string) error {
		for _, id := range ids {
			if c.Skills[id] == nil {
				return fmt.Errorf("%s: unknown skill %q", owner, id)
			}
		}
		return nil
	}
	if err := checkSkills("world.yaml player", w.Player.Skills); err != nil {
		return err
	}
	for id, t := range c.Templates {
		t.ID = id
		if t.Level <= 0 {
			t.Level = 1
		}
		if t.Model == "" {
			t.Model = id
		}
		if t.Kind != "monster" && t.Kind != "npc" {
			return fmt.Errorf("monsters.yaml: template %s has kind %q, want monster or npc", id, t.Kind)
		}
		if !knownTrees[t.Tree] {
			return fmt.Errorf("monsters.yaml: template %s uses unknown behavior tree %q", id, t.Tree)
		}
		if _, ok := w.Hostile[t.Faction]; !ok {
			return fmt.Errorf("monsters.yaml: template %s has faction %q missing from world.yaml hostile", id, t.Faction)
		}
		if err := checkSkills("monsters.yaml template "+id, t.Skills); err != nil {
			return err
		}
	}
	for i, s := range c.Spawns {
		if c.Templates[s.Template] == nil {
			return fmt.Errorf("monsters.yaml: spawn %d uses unknown template %q", i, s.Template)
		}
	}
	return nil
}

// Hostile reports whether faction a attacks faction b.
func (c *Config) Hostile(a, b string) bool {
	for _, f := range c.World.Hostile[a] {
		if f == b {
			return true
		}
	}
	return false
}
