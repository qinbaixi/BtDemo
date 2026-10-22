// Package config 加载 config/ 下的 YAML 文件。
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// Attrs 是四项基础属性。
type Attrs struct {
	Str float64 `yaml:"str" json:"str"`
	Agi float64 `yaml:"agi" json:"agi"`
	Int float64 `yaml:"int" json:"int"`
	Vit float64 `yaml:"vit" json:"vit"`
}

// Point 是带有随机分散半径的出生位置。
type Point struct {
	X      float64 `yaml:"x"`
	Y      float64 `yaml:"y"`
	Spread float64 `yaml:"spread"`
}

// Player 是每个新连接获得的模板。
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
	Block      Block    `yaml:"block"`
}

// Block 是玩家按住右键格挡时的效果。
type Block struct {
	Reduce float64 `yaml:"reduce"` // 格挡时受到的伤害减少的比例，0.8 = 减少 80%
	Speed  float64 `yaml:"speed"`  // 格挡时的移动速度倍率
}

// World 对应 config/world.yaml。
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
	Addr     string              `yaml:"addr"` // HTTP 监听地址，例如 ":8090" 或 "127.0.0.1:8090"
	Hostile  map[string][]string `yaml:"hostile"`
	Player   Player              `yaml:"player"`
}

// Buff 是技能授予的限时属性修正。
type Buff struct {
	Name     string  `yaml:"name"`
	Duration float64 `yaml:"duration"`
	AtkPct   float64 `yaml:"atk_pct"`
	DefPct   float64 `yaml:"def_pct"`
	SpeedPct float64 `yaml:"speed_pct"`
	// ShieldPct 让 Buff 带一个护盾：吸收最大生命 × ShieldPct 的伤害，吸收完或到时间就消失。
	ShieldPct float64 `yaml:"shield_pct"`
}

// Skill 对应 config/skills.yaml 中的一个条目。
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

// Template 是 config/monsters.yaml 中的怪物或 NPC 模板。
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
	Model   string   `yaml:"model"` // 客户端外观；默认为模板 id
	Skills  []string `yaml:"skills"`
	Respawn float64  `yaml:"respawn"`
	Exp     int      `yaml:"exp"`
}

// Spawn 在 (X, Y) 周围放置 Count 份模板副本。
type Spawn struct {
	Template string  `yaml:"template"`
	X        float64 `yaml:"x"`
	Y        float64 `yaml:"y"`
	Count    int     `yaml:"count"`
	Spread   float64 `yaml:"spread"`
}

// Config 是从配置目录加载的全部内容。
type Config struct {
	World     World
	Skills    map[string]*Skill
	Templates map[string]*Template
	Spawns    []Spawn
	Layout    Layout // 对应 map.tmj
}

// Load 从 dir 读取 world.yaml、skills.yaml、monsters.yaml 和 map.tmj，并检查每个引用都能解析。
// knownTrees 列出编译进二进制文件的行为树。
func Load(dir string, knownTrees map[string]bool) (*Config, error) {
	cfg := &Config{}
	if err := readYAML(filepath.Join(dir, "world.yaml"), &cfg.World); err != nil {
		return nil, err
	}
	var skills struct {
		Skills map[string]*Skill `yaml:"skills"`
	}
	if err := readYAML(filepath.Join(dir, "skills.yaml"), &skills); err != nil {
		return nil, err
	}
	cfg.Skills = skills.Skills
	var monsters struct {
		Templates map[string]*Template `yaml:"templates"`
		Spawns    []Spawn              `yaml:"spawns"`
	}
	if err := readYAML(filepath.Join(dir, "monsters.yaml"), &monsters); err != nil {
		return nil, err
	}
	cfg.Templates, cfg.Spawns = monsters.Templates, monsters.Spawns
	var err error
	if cfg.Layout, err = loadLayout(dir); err != nil {
		return nil, err
	}
	return cfg, cfg.validate(knownTrees)
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

func (cfg *Config) validate(knownTrees map[string]bool) error {
	world := &cfg.World
	if world.Map.Width <= 0 || world.Map.Height <= 0 || world.AOI.Cell <= 0 {
		return fmt.Errorf("world.yaml: map size and aoi.cell must be positive")
	}
	if world.TickRate <= 0 {
		world.TickRate = 20
	}
	world.Addr = NormalizeAddr(world.Addr)
	if world.SyncRate <= 0 {
		world.SyncRate = 10
	}
	if world.Player.Level <= 0 {
		world.Player.Level = 1
	}
	if world.Player.Model == "" {
		world.Player.Model = "knight"
	}
	// 没配格挡时：减伤 80%、速度减半
	if world.Player.Block.Reduce == 0 && world.Player.Block.Speed == 0 {
		world.Player.Block = Block{Reduce: 0.8, Speed: 0.5}
	}
	if block := world.Player.Block; block.Reduce < 0 || block.Reduce > 1 || block.Speed < 0 {
		return fmt.Errorf("world.yaml: player.block.reduce must be 0..1 and speed >= 0")
	}
	for faction, targets := range world.Hostile {
		for _, target := range targets {
			if _, ok := world.Hostile[target]; !ok {
				return fmt.Errorf(
					"world.yaml: hostile.%s lists unknown faction %q",
					faction,
					target,
				)
			}
		}
	}
	if _, ok := world.Hostile["player"]; !ok {
		return fmt.Errorf("world.yaml: hostile must have a player entry")
	}
	for id, skill := range cfg.Skills {
		skill.ID = id
		switch skill.Kind {
		case "target", "aoe", "self":
		default:
			return fmt.Errorf("skills.yaml: skill %s has unknown kind %q", id, skill.Kind)
		}
		switch skill.Damage {
		case "", "physical", "magic":
		default:
			return fmt.Errorf("skills.yaml: skill %s has unknown damage %q", id, skill.Damage)
		}
	}
	checkSkills := func(owner string, ids []string) error {
		for _, id := range ids {
			if cfg.Skills[id] == nil {
				return fmt.Errorf("%s: unknown skill %q", owner, id)
			}
		}
		return nil
	}
	if err := checkSkills("world.yaml player", world.Player.Skills); err != nil {
		return err
	}
	for id, template := range cfg.Templates {
		template.ID = id
		if template.Level <= 0 {
			template.Level = 1
		}
		if template.Model == "" {
			template.Model = id
		}
		if template.Kind != "monster" && template.Kind != "npc" {
			return fmt.Errorf(
				"monsters.yaml: template %s has kind %q, want monster or npc",
				id,
				template.Kind,
			)
		}
		if !knownTrees[template.Tree] {
			return fmt.Errorf(
				"monsters.yaml: template %s uses unknown behavior tree %q",
				id,
				template.Tree,
			)
		}
		if _, ok := world.Hostile[template.Faction]; !ok {
			return fmt.Errorf(
				"monsters.yaml: template %s has faction %q missing from world.yaml hostile",
				id,
				template.Faction,
			)
		}
		if err := checkSkills("monsters.yaml template "+id, template.Skills); err != nil {
			return err
		}
	}
	if layout := cfg.Layout; layout.Source != nil &&
		(layout.Width != world.Map.Width || layout.Height != world.Map.Height) {
		return fmt.Errorf(
			"%s is %gx%g but world.yaml map is %gx%g; change one to match",
			MapFile,
			layout.Width,
			layout.Height,
			world.Map.Width,
			world.Map.Height,
		)
	}
	for _, prop := range cfg.Layout.Props {
		if prop.X < 0 || prop.Y < 0 || prop.X > world.Map.Width || prop.Y > world.Map.Height {
			return fmt.Errorf(
				"%s: prop %s at (%g, %g) is off the %gx%g map",
				MapFile,
				prop.Kind,
				prop.X,
				prop.Y,
				world.Map.Width,
				world.Map.Height,
			)
		}
	}
	for i, spawnCfg := range cfg.Spawns {
		if cfg.Templates[spawnCfg.Template] == nil {
			return fmt.Errorf(
				"monsters.yaml: spawn %d uses unknown template %q",
				i,
				spawnCfg.Template,
			)
		}
	}
	return nil
}

// Hostile 报告阵营 attacker 是否会攻击阵营 target。
func (cfg *Config) Hostile(attacker, target string) bool {
	for _, faction := range cfg.World.Hostile[attacker] {
		if faction == target {
			return true
		}
	}
	return false
}

// NormalizeAddr 将 "8090" 这类裸端口转换为 ":8090"，并将空地址默认为 ":8080"。
func NormalizeAddr(addr string) string {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return ":8080"
	}
	if !strings.Contains(addr, ":") {
		return ":" + addr
	}
	return addr
}
