package config

import (
	"fmt"
	"slices"
)

// ItemSlots 是装备槽位，按面板上的顺序：武器、护甲、饰品。
var ItemSlots = []string{"weapon", "armor", "trinket"}

// Rarities 是物品稀有度，从低到高。
var Rarities = []string{"common", "rare", "epic"}

// StatNames 是物品 stats 可以写的属性名，也是发给客户端时的显示顺序。
var StatNames = []string{
	"str",
	"agi",
	"int",
	"vit",
	"max_hp",
	"atk",
	"matk",
	"def",
	"mdef",
	"crit",
	"crit_dmg",
	"speed",
	"cdr",
}

// MaxCDR 是冷却缩减的上限（万分比）：所有技能冷却最多缩短 40%。
const MaxCDR BasisPoints = 4000

// Item 对应 config/items.yaml 中的一件装备。
type Item struct {
	ID     string         `yaml:"id"`
	Name   string         `yaml:"name"`
	Slot   string         `yaml:"slot"`   // weapon | armor | trinket
	Class  string         `yaml:"class"`  // 能用的职业 id；空 = 所有职业都能用
	Rarity string         `yaml:"rarity"` // common | rare | epic
	Desc   string         `yaml:"desc"`   // 背包面板上的一句话说明
	Stats  map[string]int `yaml:"stats"`  // 属性加成，属性名见 StatNames（crit、crit_dmg、cdr 是万分比）
	Effect *ItemEffect    `yaml:"effect"` // 特效；没有就是 nil
	Look   string         `yaml:"look"`   // 装备武器时客户端画的武器外观；空 = 职业默认武器
	// Bonus 是 Stats 换算成的加成，由 validate 填写，attr 直接读它。
	Bonus StatBonus `yaml:"-"`
}

// UsableBy 报告职业 classID 能不能装备这件物品。
func (item *Item) UsableBy(classID string) bool {
	return item.Class == "" || item.Class == classID
}

// StatBonus 是装备提供的属性加成：Attrs 加在基础属性上（再算派生属性），
// 其余直接加在派生属性的结果上。Crit、CritDmg、CDR 是万分比（500 = 5%）。
type StatBonus struct {
	Attrs   Attrs
	MaxHP   int
	Atk     int
	MAtk    int
	Def     int
	MDef    int
	Crit    BasisPoints
	CritDmg BasisPoints
	Speed   int
	CDR     BasisPoints
}

// Add 把 other 累加到 bonus 上。
func (bonus *StatBonus) Add(other StatBonus) {
	bonus.Attrs.Str += other.Attrs.Str
	bonus.Attrs.Agi += other.Attrs.Agi
	bonus.Attrs.Int += other.Attrs.Int
	bonus.Attrs.Vit += other.Attrs.Vit
	bonus.MaxHP += other.MaxHP
	bonus.Atk += other.Atk
	bonus.MAtk += other.MAtk
	bonus.Def += other.Def
	bonus.MDef += other.MDef
	bonus.Crit += other.Crit
	bonus.CritDmg += other.CritDmg
	bonus.Speed += other.Speed
	bonus.CDR += other.CDR
}

// statField 返回属性名 name 在 StatBonus 里对应的字段，名字不认识时返回 nil。
func (bonus *StatBonus) statField(name string) *int {
	fields := map[string]*int{
		"str":      &bonus.Attrs.Str,
		"agi":      &bonus.Attrs.Agi,
		"int":      &bonus.Attrs.Int,
		"vit":      &bonus.Attrs.Vit,
		"max_hp":   &bonus.MaxHP,
		"atk":      &bonus.Atk,
		"matk":     &bonus.MAtk,
		"def":      &bonus.Def,
		"mdef":     &bonus.MDef,
		"crit":     &bonus.Crit,
		"crit_dmg": &bonus.CritDmg,
		"speed":    &bonus.Speed,
		"cdr":      &bonus.CDR,
	}
	return fields[name]
}

// 物品特效的种类。
const (
	EffectLifesteal = "lifesteal"  // 造成伤害后回复 伤害 × pct
	EffectThorns    = "thorns"     // 被 ThornsRange 内的敌人打中时反弹 实际受到的伤害 × pct
	EffectIgnite    = "ignite"     // 造成伤害时 chance 概率追加 atk × ratio 的魔法伤害
	EffectBlockHeal = "block_heal" // 格挡住一次攻击时回复 最大生命 × pct
	EffectMultishot = "multishot"  // 普攻命中后 chance 概率再射一箭
	EffectChill     = "chill"      // 命中时 chance 概率挂 dur 毫秒的减速（speed 为负）
	EffectAmbush    = "ambush"     // 位移技能后 dur 毫秒内的下一次伤害必定暴击
	EffectRegen     = "regen"      // 活着时每秒回复 最大生命 × pct
)

// ThornsRange 是反伤的距离上限（边缘距离）：远处射来的箭不反弹。
const ThornsRange = 120

// ChillBuffName 是 chill 挂的减速的名字，和冰霜箭的减速同名，所以互相刷新、不叠加。
const ChillBuffName = "冰冻"

// ItemEffect 是物品的特效。用到哪些参数由 Kind 决定（见上面的常量）。
// Pct、Chance、Ratio、Speed 是万分比，Dur 是毫秒。
type ItemEffect struct {
	Kind   string      `yaml:"kind"`
	Pct    BasisPoints `yaml:"pct"`
	Chance BasisPoints `yaml:"chance"`
	Ratio  BasisPoints `yaml:"ratio"`
	Dur    Millis      `yaml:"dur"`
	Speed  BasisPoints `yaml:"speed"`
	// Debuff 是 chill 挂在目标身上的减速，由 validate 生成。
	Debuff *Buff `yaml:"-"`
}

// Skin 是职业的一套外观：骨骼和动作一样，只换配色和部件画法。
type Skin struct {
	ID    string `yaml:"id"`
	Name  string `yaml:"name"`
	Desc  string `yaml:"desc"`
	Color string `yaml:"color"` // 选择面板上的色块
}

// DefaultSkin 是职业的默认皮肤 id（列表里的第一个）；没配皮肤时为空。
func (class *Class) DefaultSkin() string {
	if len(class.Skins) == 0 {
		return ""
	}
	return class.Skins[0].ID
}

// Skin 按 id 找职业的皮肤，找不到返回 nil。
func (class *Class) Skin(id string) *Skin {
	for _, skin := range class.Skins {
		if skin.ID == id {
			return skin
		}
	}
	return nil
}

// Loot 是 world.yaml 的掉落配置：怪物死亡时按概率给击杀者一件装备。
type Loot struct {
	Chance BasisPoints `yaml:"chance"` // 普通怪掉落的概率（万分比）
	// Bosses 是单独配置掉落概率的怪物：模板 id -> 概率（万分比，比如首领必掉 10000）。
	Bosses map[string]BasisPoints `yaml:"bosses"`
	// Rarity 是各稀有度的抽取权重（整数）。
	Rarity map[string]int `yaml:"rarity"`
	// ClassBias 是只从击杀者职业能用的物品（本职业或通用）里抽的概率（万分比），其余时候从所有物品里抽。
	ClassBias BasisPoints `yaml:"class_bias"`
}

// ChanceFor 是模板 templateID 的怪物死亡时掉落的概率（万分比）。
func (loot *Loot) ChanceFor(templateID string) BasisPoints {
	if chance, ok := loot.Bosses[templateID]; ok {
		return chance
	}
	return loot.Chance
}

// Item 按 id 找物品，找不到返回 nil。
func (cfg *Config) Item(id string) *Item {
	return cfg.itemsByID[id]
}

// DefaultBagSize 是 world.yaml 没写 player.bag 时的背包格数。
const DefaultBagSize = 24

// validateItems 检查 items.yaml 的每件物品，并建立按 id 的索引。
func (cfg *Config) validateItems() error {
	cfg.itemsByID = map[string]*Item{}
	for i, item := range cfg.Items {
		owner := fmt.Sprintf("items.yaml: items[%d]", i)
		if item.ID == "" || item.Name == "" {
			return fmt.Errorf("%s: item needs an id and a name", owner)
		}
		owner = "items.yaml: item " + item.ID
		if cfg.itemsByID[item.ID] != nil {
			return fmt.Errorf("%s: duplicate item id", owner)
		}
		cfg.itemsByID[item.ID] = item
		if !slices.Contains(ItemSlots, item.Slot) {
			return fmt.Errorf("%s has unknown slot %q", owner, item.Slot)
		}
		if item.Class != "" && cfg.World.Player.Class(item.Class) == nil {
			return fmt.Errorf("%s is for unknown class %q", owner, item.Class)
		}
		if !slices.Contains(Rarities, item.Rarity) {
			return fmt.Errorf("%s has unknown rarity %q", owner, item.Rarity)
		}
		item.Bonus = StatBonus{}
		for name, value := range item.Stats {
			field := item.Bonus.statField(name)
			if field == nil {
				return fmt.Errorf("%s has unknown stat %q", owner, name)
			}
			*field = value
		}
		if item.Effect != nil {
			if err := checkEffect(owner, item.Effect); err != nil {
				return err
			}
		}
	}
	return nil
}

// checkEffect 检查特效的种类和参数，并给 chill 生成减速 Buff。
func checkEffect(owner string, effect *ItemEffect) error {
	positive := func(name string, value int64) error {
		if value <= 0 {
			return fmt.Errorf("%s: effect %s needs a positive %s", owner, effect.Kind, name)
		}
		return nil
	}
	chance := func() error {
		if effect.Chance <= 0 || effect.Chance > OneHundredPercent {
			return fmt.Errorf("%s: effect %s needs a chance in (0, 10000]", owner, effect.Kind)
		}
		return nil
	}
	switch effect.Kind {
	case EffectLifesteal, EffectThorns, EffectBlockHeal, EffectRegen:
		return positive("pct", int64(effect.Pct))
	case EffectIgnite:
		if err := chance(); err != nil {
			return err
		}
		return positive("ratio", int64(effect.Ratio))
	case EffectMultishot:
		return chance()
	case EffectChill:
		if err := chance(); err != nil {
			return err
		}
		if err := positive("dur", effect.Dur); err != nil {
			return err
		}
		if effect.Speed >= 0 || effect.Speed <= -OneHundredPercent {
			return fmt.Errorf("%s: effect chill needs a speed between -10000 and 0", owner)
		}
		effect.Debuff = &Buff{
			Name:     ChillBuffName,
			Duration: effect.Dur,
			SpeedPct: effect.Speed,
			Look:     "frost",
		}
		return nil
	case EffectAmbush:
		return positive("dur", effect.Dur)
	default:
		return fmt.Errorf("%s has unknown effect %q", owner, effect.Kind)
	}
}

// validateSkins 检查职业 class 的皮肤：至少一个，id、名字、色块齐全，id 不重复。
func validateSkins(owner string, class *Class) error {
	if len(class.Skins) == 0 {
		return fmt.Errorf("%s: needs at least one skin", owner)
	}
	seen := map[string]bool{}
	for _, skin := range class.Skins {
		if skin.ID == "" || skin.Name == "" || skin.Color == "" {
			return fmt.Errorf("%s: skin needs an id, a name and a color", owner)
		}
		if seen[skin.ID] {
			return fmt.Errorf("%s: duplicate skin id %q", owner, skin.ID)
		}
		seen[skin.ID] = true
	}
	return nil
}

// validateGear 检查背包大小、新手装备和掉落配置（物品要先校验过）。
func (cfg *Config) validateGear() error {
	player := &cfg.World.Player
	if player.Bag == 0 {
		player.Bag = DefaultBagSize
	}
	if player.Bag < 0 {
		return fmt.Errorf("world.yaml: player.bag must be positive")
	}
	checkStarter := func(owner string, ids []string, classID string) error {
		for _, id := range ids {
			item := cfg.Item(id)
			if item == nil {
				return fmt.Errorf("%s: unknown item %q", owner, id)
			}
			if classID != "" && !item.UsableBy(classID) {
				return fmt.Errorf("%s: item %s is not usable by %s", owner, id, classID)
			}
		}
		return nil
	}
	if err := checkStarter("world.yaml player.starter", player.Starter, ""); err != nil {
		return err
	}
	for _, class := range player.Classes {
		owner := "world.yaml class " + class.ID + " starter"
		if err := checkStarter(owner, class.Starter, class.ID); err != nil {
			return err
		}
	}
	loot := &cfg.World.Loot
	if loot.Chance < 0 || loot.Chance > OneHundredPercent {
		return fmt.Errorf("world.yaml: loot.chance must be 0..10000")
	}
	for templateID, chance := range loot.Bosses {
		if cfg.Templates[templateID] == nil {
			return fmt.Errorf("world.yaml: loot.bosses has unknown template %q", templateID)
		}
		if chance < 0 || chance > OneHundredPercent {
			return fmt.Errorf("world.yaml: loot.bosses.%s must be 0..10000", templateID)
		}
	}
	totalWeight := 0
	for rarity, weight := range loot.Rarity {
		if !slices.Contains(Rarities, rarity) {
			return fmt.Errorf("world.yaml: loot.rarity has unknown rarity %q", rarity)
		}
		if weight < 0 {
			return fmt.Errorf("world.yaml: loot.rarity.%s must not be negative", rarity)
		}
		totalWeight += weight
	}
	if len(cfg.Items) > 0 && totalWeight <= 0 {
		return fmt.Errorf("world.yaml: loot.rarity needs at least one positive weight")
	}
	if loot.ClassBias < 0 || loot.ClassBias > OneHundredPercent {
		return fmt.Errorf("world.yaml: loot.class_bias must be 0..10000")
	}
	return nil
}
