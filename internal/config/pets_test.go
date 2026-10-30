package config

import (
	"strings"
	"testing"
)

// 随附的 pets.yaml 和 world.yaml 的 pet 段能通过校验，内容和设计一致。
func TestShippedPets(t *testing.T) {
	cfg, err := Load("../../config", map[string]bool{
		"monster_melee":    true,
		"monster_ranged":   true,
		"monster_boss":     true,
		"monster_pack":     true,
		"alpha_wolf":       true,
		"wolf_king":        true,
		"skeleton_soldier": true,
		"skeleton_knight":  true,
		"bone_pile":        true,
		"bone_statue":      true,
		"blood_hammer":     true,
		"npc_guard":        true,
		"npc_villager":     true,
		"pet_melee":        true,
		"pet_caster":       true,
		"pet_healer":       true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Pets) != 3 || cfg.Pets[0].ID != "wolf_pup" || cfg.Pet("sprout") == nil {
		t.Fatalf("pets = %v", cfg.Pets)
	}
	rules := cfg.World.Pet
	if rules.Respawn != 10000 || rules.SwapCooldown != 5000 || rules.Teleport != 600 {
		t.Fatalf("pet rules = %+v", rules)
	}
	if mend := cfg.Skills["pet_mend"]; mend.Kind != "ally" || mend.Heal <= 0 {
		t.Fatalf("pet_mend = %+v", mend)
	}
}

// 宠物配置里的错误会在启动时报出来。
func TestPetValidation(t *testing.T) {
	cases := map[string]struct {
		mutate func(*Config)
		want   string
	}{
		"unknown tree":  {func(cfg *Config) { cfg.Pets[0].Tree = "nope" }, "unknown behavior tree"},
		"unknown skill": {func(cfg *Config) { cfg.Pets[0].Skills = []string{"nope"} }, "unknown skill"},
		"duplicate id":  {func(cfg *Config) { cfg.Pets[1].ID = cfg.Pets[0].ID }, "duplicate pet id"},
		"aimed skill": {
			func(cfg *Config) { cfg.Pets[0].Skills = []string{"blink"} },
			"cannot use dash skill",
		},
	}
	for name, test := range cases {
		cfg, err := Load("../../config", map[string]bool{
			"monster_melee":    true,
			"monster_ranged":   true,
			"monster_boss":     true,
			"monster_pack":     true,
			"alpha_wolf":       true,
			"wolf_king":        true,
			"skeleton_soldier": true,
			"skeleton_knight":  true,
			"bone_pile":        true,
			"bone_statue":      true,
			"blood_hammer":     true,
			"npc_guard":        true,
			"npc_villager":     true,
			"pet_melee":        true,
			"pet_caster":       true,
			"pet_healer":       true,
		})
		if err != nil {
			t.Fatal(err)
		}
		test.mutate(cfg)
		err = cfg.validatePets(map[string]bool{"pet_melee": true})
		if err == nil || !strings.Contains(err.Error(), test.want) {
			t.Errorf("%s: error %v, want containing %q", name, err, test.want)
		}
	}
}
