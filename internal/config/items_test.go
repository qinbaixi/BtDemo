package config

import (
	"strings"
	"testing"
)

// itemsConfig 是在 classesConfig 上加了几件物品和掉落配置的最小配置。
func itemsConfig() *Config {
	cfg := classesConfig()
	cfg.Templates["ogre_chief"] = &Template{Kind: "monster", Faction: "player", Tree: "t"}
	cfg.Items = []*Item{
		{
			ID:     "recruit_sword",
			Name:   "新兵长剑",
			Slot:   "weapon",
			Class:  "knight",
			Rarity: "common",
			Stats:  map[string]int{"atk": 4, "str": 2, "cdr": 1000},
		},
		{
			ID:     "frost_bow",
			Name:   "霜心长弓",
			Slot:   "weapon",
			Class:  "ranger",
			Rarity: "epic",
			Effect: &ItemEffect{Kind: EffectChill, Chance: 3500, Dur: 2000, Speed: -3000},
		},
		{
			ID:     "life_charm",
			Name:   "生命护符",
			Slot:   "trinket",
			Rarity: "common",
			Effect: &ItemEffect{Kind: EffectRegen, Pct: 100},
		},
	}
	cfg.World.Player.Starter = []string{"life_charm"}
	cfg.World.Player.Classes[0].Starter = []string{"recruit_sword"}
	cfg.World.Loot = Loot{
		Chance:    3000,
		Bosses:    map[string]BasisPoints{"ogre_chief": 10000},
		Rarity:    map[string]int{"common": 6, "rare": 3, "epic": 1},
		ClassBias: 7000,
	}
	return cfg
}

func TestItemsValid(t *testing.T) {
	cfg := itemsConfig()
	if err := cfg.validate(map[string]bool{"t": true}); err != nil {
		t.Fatal(err)
	}
	sword := cfg.Item("recruit_sword")
	if sword == nil || sword.Bonus.Atk != 4 || sword.Bonus.Attrs.Str != 2 || sword.Bonus.CDR != 1000 {
		t.Fatalf("sword bonus = %+v", sword)
	}
	if !sword.UsableBy("knight") || sword.UsableBy("ranger") || !cfg.Item("life_charm").UsableBy("ranger") {
		t.Fatal("UsableBy wrong")
	}
	chill := cfg.Item("frost_bow").Effect.Debuff
	if chill == nil || chill.Name != ChillBuffName || chill.SpeedPct != -3000 || chill.Look != "frost" {
		t.Fatalf("chill debuff = %+v", chill)
	}
	if cfg.World.Player.Bag != DefaultBagSize {
		t.Fatalf("bag = %d, want default %d", cfg.World.Player.Bag, DefaultBagSize)
	}
	if cfg.World.Loot.ChanceFor("ogre_chief") != 10000 || cfg.World.Loot.ChanceFor("slime") != 3000 {
		t.Fatal("loot chance wrong")
	}
	knight := cfg.World.Player.Classes[0]
	if knight.DefaultSkin() != "paladin" || knight.Skin("paladin") == nil || knight.Skin("woodland") != nil {
		t.Fatal("skin lookup wrong")
	}
}

func TestItemsInvalid(t *testing.T) {
	cases := map[string]struct {
		mutate func(cfg *Config)
		want   string
	}{
		"bad slot": {
			func(cfg *Config) { cfg.Items[0].Slot = "boots" },
			"unknown slot",
		},
		"unknown class": {
			func(cfg *Config) { cfg.Items[0].Class = "mage" },
			"unknown class",
		},
		"bad rarity": {
			func(cfg *Config) { cfg.Items[0].Rarity = "legendary" },
			"unknown rarity",
		},
		"bad stat": {
			func(cfg *Config) { cfg.Items[0].Stats["luck"] = 1 },
			"unknown stat",
		},
		"duplicate id": {
			func(cfg *Config) { cfg.Items[1].ID = "recruit_sword" },
			"duplicate item id",
		},
		"unknown effect": {
			func(cfg *Config) { cfg.Items[2].Effect.Kind = "vampire" },
			"unknown effect",
		},
		"regen without pct": {
			func(cfg *Config) { cfg.Items[2].Effect.Pct = 0 },
			"positive pct",
		},
		"chill without chance": {
			func(cfg *Config) { cfg.Items[1].Effect.Chance = 0 },
			"chance in (0, 10000]",
		},
		"chill speeds up": {
			func(cfg *Config) { cfg.Items[1].Effect.Speed = 3000 },
			"speed between -10000 and 0",
		},
		"ignite without ratio": {
			func(cfg *Config) { cfg.Items[1].Effect = &ItemEffect{Kind: EffectIgnite, Chance: 2000} },
			"positive ratio",
		},
		"ambush without dur": {
			func(cfg *Config) { cfg.Items[1].Effect = &ItemEffect{Kind: EffectAmbush} },
			"positive dur",
		},
		"unknown starter": {
			func(cfg *Config) { cfg.World.Player.Starter = []string{"nope"} },
			"unknown item",
		},
		"starter for another class": {
			func(cfg *Config) { cfg.World.Player.Classes[1].Starter = []string{"recruit_sword"} },
			"not usable by ranger",
		},
		"loot unknown boss": {
			func(cfg *Config) { cfg.World.Loot.Bosses["dragon"] = 1 },
			"unknown template",
		},
		"loot bad rarity": {
			func(cfg *Config) { cfg.World.Loot.Rarity["mythic"] = 1 },
			"unknown rarity",
		},
		"loot no weights": {
			func(cfg *Config) { cfg.World.Loot.Rarity = nil },
			"positive weight",
		},
		"loot bad chance": {
			func(cfg *Config) { cfg.World.Loot.Chance = 15000 },
			"loot.chance",
		},
		"no skins": {
			func(cfg *Config) { cfg.World.Player.Classes[1].Skins = nil },
			"at least one skin",
		},
		"skin without color": {
			func(cfg *Config) { cfg.World.Player.Classes[0].Skins[0].Color = "" },
			"needs an id, a name and a color",
		},
		"duplicate skin": {
			func(cfg *Config) {
				skins := &cfg.World.Player.Classes[0].Skins
				*skins = append(*skins, &Skin{ID: "paladin", Name: "又一个", Color: "#fff"})
			},
			"duplicate skin id",
		},
	}
	for name, test := range cases {
		cfg := itemsConfig()
		test.mutate(cfg)
		err := cfg.validate(map[string]bool{"t": true})
		if err == nil || !strings.Contains(err.Error(), test.want) {
			t.Errorf("%s: error %v, want containing %q", name, err, test.want)
		}
	}
}

// 随附的 items.yaml 和 world.yaml 能通过校验，内容和设计一致。
func TestShippedItems(t *testing.T) {
	cfg, err := Load("../../config", map[string]bool{
		"monster_melee":  true,
		"monster_ranged": true,
		"monster_boss":   true,
		"npc_guard":      true,
		"npc_villager":   true,
		"pet_melee":      true,
		"pet_caster":     true,
		"pet_healer":     true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Items) != 13 {
		t.Fatalf("%d items, want 13", len(cfg.Items))
	}
	if cfg.World.Player.Bag != 24 || cfg.World.Loot.ChanceFor("ogre_chief") != 10000 {
		t.Fatal("bag or boss loot wrong")
	}
	for _, class := range cfg.World.Player.Classes {
		if len(class.Skins) != 3 || len(class.Starter) != 1 {
			t.Fatalf("class %s: %d skins, starter %v", class.ID, len(class.Skins), class.Starter)
		}
	}
}
