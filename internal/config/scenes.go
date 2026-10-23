package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// ScenesFile 是场景列表文件。没有这个文件时整个服务器只有一个场景，
// 用 map.tmj、monsters.yaml 的 spawns、world.yaml 的 heal_zones 和 player.spawn（旧的单场景配置）。
const ScenesFile = "scenes.yaml"

// MapsDir 是各场景地图所在的目录（相对配置目录）。
const MapsDir = "maps"

// LineRules 是一个场景模板的分线规则。
type LineRules struct {
	// Soft 是一条线的“满员”人数：超过它，新玩家优先去别的线，都超过了就开新线
	Soft int `yaml:"soft"`
	// Hard 是一条线最多容纳多少人：到了就不能再进（指定线号切线时也不行）
	Hard int `yaml:"hard"`
	// Min 是常驻的线数：这几条线没人也不关
	Min int `yaml:"min"`
	// IdleClose 是多出来的线空了多少秒后关闭
	IdleClose float64 `yaml:"idle_close"`
}

// Scene 是一个场景模板（scenes.yaml 的一项）：一张地图和地图上的怪物、回血区、出生点。
// 同一个模板可以同时开好几条线，每条线是一个独立运行的场景。
type Scene struct {
	ID   string `yaml:"id"`
	Name string `yaml:"name"` // 显示给玩家的名字
	// Map 是地图文件名（在 maps 目录下），例如 village.tmj
	Map string `yaml:"map"`
	// Spawn 是在这个场景里出生和复活的位置
	Spawn Point `yaml:"spawn"`
	// Spawns 是这个场景里的怪物和 NPC
	Spawns []Spawn `yaml:"spawns"`
	// HealZones 是这个场景里常驻的回血区
	HealZones []*Zone `yaml:"heal_zones"`
	// Lines 是这个场景的分线规则；不填的项用 scenes.yaml 顶层的 lines
	Lines LineRules `yaml:"lines"`

	// Layout 是从 Map 读出的地图
	Layout Layout `yaml:"-"`
	// Cfg 是这个场景用的配置：和全局配置共用技能、怪物模板、物品等，
	// 地图、刷怪、回血区、出生点换成这个场景的。由 Load 建立，只读。
	Cfg *Config `yaml:"-"`
}

// Scenes 对应 config/scenes.yaml。
type Scenes struct {
	// Default 是新玩家进入的场景，默认是列表里的第一个
	Default string    `yaml:"default"`
	Lines   LineRules `yaml:"lines"`
	List    []*Scene  `yaml:"scenes"`
}

// Scene 按 id 找场景模板，找不到返回 nil。
func (scenes *Scenes) Scene(id string) *Scene {
	for _, scene := range scenes.List {
		if scene.ID == id {
			return scene
		}
	}
	return nil
}

// DefaultScene 是新玩家进入的场景模板。
func (scenes *Scenes) DefaultScene() *Scene { return scenes.Scene(scenes.Default) }

// loadScenes 读 scenes.yaml 和每个场景的地图。文件不存在时返回 false。
func loadScenes(dir string, scenes *Scenes) (bool, error) {
	path := filepath.Join(dir, ScenesFile)
	if _, err := os.Stat(path); errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err := readYAML(path, scenes); err != nil {
		return true, err
	}
	if len(scenes.List) == 0 {
		return true, fmt.Errorf("%s: no scenes", ScenesFile)
	}
	seen := map[string]bool{}
	for i, scene := range scenes.List {
		if scene.ID == "" || seen[scene.ID] {
			return true, fmt.Errorf("%s: scene %d has an empty or repeated id %q", ScenesFile, i, scene.ID)
		}
		seen[scene.ID] = true
		if scene.Name == "" {
			scene.Name = scene.ID
		}
		if scene.Map == "" {
			return true, fmt.Errorf("%s: scene %s has no map", ScenesFile, scene.ID)
		}
		data, err := os.ReadFile(filepath.Join(dir, MapsDir, scene.Map))
		if err != nil {
			return true, fmt.Errorf("%s: scene %s: %w", ScenesFile, scene.ID, err)
		}
		if scene.Layout, err = parseLayout(data); err != nil {
			return true, fmt.Errorf("%s/%s: %w", MapsDir, scene.Map, err)
		}
		scene.Layout.Source = data
	}
	if scenes.Default == "" {
		scenes.Default = scenes.List[0].ID
	}
	if scenes.DefaultScene() == nil {
		return true, fmt.Errorf("%s: default scene %q is not in the list", ScenesFile, scenes.Default)
	}
	return true, nil
}

// singleScene 是没有 scenes.yaml 时的唯一场景，用旧的单场景配置。
func (cfg *Config) singleScene() *Scene {
	return &Scene{
		ID:        "main",
		Name:      "世界",
		Map:       MapFile,
		Spawn:     cfg.World.Player.Spawn,
		Spawns:    cfg.Spawns,
		HealZones: cfg.World.HealZones,
		Layout:    cfg.Layout,
	}
}

// useScene 把 cfg 的地图、刷怪、回血区、出生点换成场景 scene 的。
func (cfg *Config) useScene(scene *Scene) {
	cfg.Layout = scene.Layout
	cfg.Spawns = scene.Spawns
	cfg.World.HealZones = scene.HealZones
	cfg.World.Player.Spawn = scene.Spawn
	if scene.Layout.Source != nil {
		cfg.World.Map.Width, cfg.World.Map.Height = scene.Layout.Width, scene.Layout.Height
	}
}

// forScene 返回场景 scene 用的配置：全局配置的浅拷贝，换上场景自己的部分。
// 共用的部分（技能、模板、物品……）是同一份，所有场景都只读不改。
func (cfg *Config) forScene(scene *Scene) *Config {
	sceneCfg := *cfg
	sceneCfg.useScene(scene)
	return &sceneCfg
}

// fillLineRules 给场景补上默认的分线规则并检查。
func (scenes *Scenes) fillLineRules() error {
	defaults := scenes.Lines
	if defaults.Soft <= 0 {
		defaults.Soft = 40
	}
	if defaults.Hard <= 0 {
		defaults.Hard = max(defaults.Soft, 60)
	}
	if defaults.Min <= 0 {
		defaults.Min = 1
	}
	if defaults.IdleClose <= 0 {
		defaults.IdleClose = 120
	}
	scenes.Lines = defaults
	for _, scene := range scenes.List {
		rules := &scene.Lines
		if rules.Soft <= 0 {
			rules.Soft = defaults.Soft
		}
		if rules.Hard <= 0 {
			rules.Hard = max(rules.Soft, defaults.Hard)
		}
		if rules.Min <= 0 {
			rules.Min = defaults.Min
		}
		if rules.IdleClose <= 0 {
			rules.IdleClose = defaults.IdleClose
		}
		if rules.Hard < rules.Soft {
			return fmt.Errorf("%s: scene %s: lines.hard must be >= lines.soft", ScenesFile, scene.ID)
		}
	}
	return nil
}

// validateScenes 检查每个场景：地图、刷怪、回血区、传送门，并建立每个场景的配置。
func (cfg *Config) validateScenes() error {
	if err := cfg.Scenes.fillLineRules(); err != nil {
		return err
	}
	for _, scene := range cfg.Scenes.List {
		scene.Cfg = cfg.forScene(scene)
		label := ScenesFile + ": scene " + scene.ID
		if err := scene.Cfg.validatePlacement(label); err != nil {
			return err
		}
		for _, portal := range scene.Layout.Portals {
			if portal.X < 0 || portal.Y < 0 || portal.X > scene.Layout.Width || portal.Y > scene.Layout.Height {
				return fmt.Errorf("%s: portal %s is off the map", label, portal.Name)
			}
			target := cfg.Scenes.Scene(portal.To)
			if target == nil || target == scene {
				return fmt.Errorf("%s: portal %s leads to unknown scene %q", label, portal.Name, portal.To)
			}
		}
	}
	return nil
}
