package config

import (
	"strings"
	"testing"
)

// classesConfig 是只够通过 validate 的最小配置：两个职业，技能和皮肤齐全。
func classesConfig() *Config {
	cfg := &Config{
		Skills: map[string]*Skill{
			"slash":  {Kind: "target", Range: 70},
			"bolt":   {Kind: "target", Range: 200},
			"shot":   {Kind: "target", Range: 300},
			"pierce": {Kind: "line", Pierce: true, Range: 380},
			"rain":   {Kind: "rain", Range: 260, Radius: 90, Distance: 180},
		},
		Templates: map[string]*Template{},
	}
	cfg.World.Map.Width, cfg.World.Map.Height, cfg.World.AOI.Cell = 1000, 1000, 200
	cfg.World.Hostile = map[string][]string{"player": {}}
	cfg.World.Player.Classes = []*Class{
		{
			ID:        "knight",
			Speed:     170,
			Radius:    16,
			Skills:    []string{"slash", "bolt"},
			SkillPool: []string{"bolt"},
			Skins:     []*Skin{{ID: "paladin", Name: "圣骑士", Color: "#4da3ff"}},
		},
		{
			ID:        "ranger",
			Speed:     180,
			Radius:    15,
			Skills:    []string{"shot", "pierce", "rain"},
			SkillPool: []string{"pierce", "rain"},
			Skins:     []*Skin{{ID: "woodland", Name: "林地游侠", Color: "#8fd17a"}},
		},
	}
	return cfg
}

func TestClassesValid(t *testing.T) {
	cfg := classesConfig()
	if err := cfg.validate(nil); err != nil {
		t.Fatal(err)
	}
	player := &cfg.World.Player
	if player.DefaultClass().ID != "knight" || player.Class("ranger").Model != "ranger" {
		t.Fatal("default class or model default wrong")
	}
	if player.Class("ranger").Pick() != 2 || player.Class("none") != nil {
		t.Fatal("Pick or Class lookup wrong")
	}
}

func TestClassesInvalid(t *testing.T) {
	cases := map[string]struct {
		mutate func(cfg *Config)
		want   string
	}{
		"no classes": {
			func(cfg *Config) { cfg.World.Player.Classes = nil },
			"at least one class",
		},
		"duplicate id": {
			func(cfg *Config) { cfg.World.Player.Classes[1].ID = "knight" },
			"duplicate class id",
		},
		"no skills": {
			func(cfg *Config) { cfg.World.Player.Classes[0].Skills = nil },
			"at least one skill",
		},
		"default not in pool": {
			func(cfg *Config) { cfg.World.Player.Classes[1].SkillPool = []string{"pierce"} },
			"not in skill_pool",
		},
		"unknown skill": {
			func(cfg *Config) { cfg.World.Player.Classes[1].SkillPool = []string{"pierce", "rain", "nope"} },
			"unknown skill",
		},
		"bad speed": {
			func(cfg *Config) { cfg.World.Player.Classes[0].Speed = 0 },
			"speed and radius",
		},
		"pierce on a target skill": {
			func(cfg *Config) { cfg.Skills["shot"].Pierce = true },
			"not a line skill",
		},
		"rain without distance": {
			func(cfg *Config) { cfg.Skills["rain"].Distance = 0 },
			"needs a range, radius and distance",
		},
		"monster uses rain": {
			func(cfg *Config) {
				cfg.World.Hostile["monster"] = nil
				cfg.Templates["boss"] = &Template{Kind: "monster", Faction: "monster", Tree: "t", Skills: []string{"rain"}}
			},
			"cannot use rain",
		},
	}
	for name, test := range cases {
		cfg := classesConfig()
		test.mutate(cfg)
		err := cfg.validate(map[string]bool{"t": true})
		if err == nil || !strings.Contains(err.Error(), test.want) {
			t.Errorf("%s: error %v, want containing %q", name, err, test.want)
		}
	}
}
