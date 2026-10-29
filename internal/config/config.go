// Package config 加载 config/ 下的 YAML 文件。
package config

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"
)

// Attrs 是四项基础属性（整数点数）。用作成长（growth）时单位是万分之一点：15000 = 每级 +1.5 点。
type Attrs struct {
	Str int `yaml:"str" json:"str"`
	Agi int `yaml:"agi" json:"agi"`
	Int int `yaml:"int" json:"int"`
	Vit int `yaml:"vit" json:"vit"`
}

// Grown 返回 attrs 加上 levels 级成长之后的属性：每项加 ⌊growth × levels / 10000⌋。
// growth 的单位是万分之一点，所以 1.5 点 / 级的成长升两级正好加 3 点，不会每级都被截掉零头。
func (attrs Attrs) Grown(growth Attrs, levels int) Attrs {
	return Attrs{
		Str: attrs.Str + ScaleBasisPoints(growth.Str, levels),
		Agi: attrs.Agi + ScaleBasisPoints(growth.Agi, levels),
		Int: attrs.Int + ScaleBasisPoints(growth.Int, levels),
		Vit: attrs.Vit + ScaleBasisPoints(growth.Vit, levels),
	}
}

// Point 是带有随机分散半径的出生位置（像素）。
type Point struct {
	X      int `yaml:"x"`
	Y      int `yaml:"y"`
	Spread int `yaml:"spread"`
}

// Player 是每个新连接获得的模板：公共字段在这里，职业相关的字段在 Classes 里。
type Player struct {
	NamePrefix string `yaml:"name_prefix"`
	Spawn      Point  `yaml:"spawn"`
	Level      int    `yaml:"level"`
	Respawn    Millis `yaml:"respawn"` // 死亡后多少毫秒复活
	Block      Block  `yaml:"block"`
	Poise      int    `yaml:"poise"` // 玩家的韧性和重量，含义同 monsters.yaml 的 poise / mass
	Mass       int    `yaml:"mass"`  // 万分比，10000 = 1 倍
	// Bag 是背包格数（装备着的物品不占格子），默认 DefaultBagSize。
	Bag int `yaml:"bag"`
	// Starter 是每个新玩家背包里都有的物品（不分职业），职业相关的见 Class.Starter。
	Starter []string `yaml:"starter"`
	// Classes 是玩家可以选的职业，第一个是新玩家的默认职业。
	Classes []*Class `yaml:"classes"`
}

// Class 是一个玩家职业：外观、属性、成长、移速和技能。
type Class struct {
	ID       string `yaml:"id"`
	Name     string `yaml:"name"`
	Desc     string `yaml:"desc"`  // 选职业时的一句话说明
	Model    string `yaml:"model"` // 客户端外观；默认为职业 id
	Color    string `yaml:"color"`
	CanBlock bool   `yaml:"can_block"` // 能不能按住右键格挡
	Attrs    Attrs  `yaml:"attrs"`
	Growth   Attrs  `yaml:"growth"` // 每升一级增加的基础属性，万分之一点（15000 = 1.5 点）
	Speed    int    `yaml:"speed"`  // 移动速度，像素 / 秒
	Radius   int    `yaml:"radius"` // 碰撞半径，像素
	// Skills 是默认技能：第 1 个是固定的普攻，其余是没选技能时的默认选择
	Skills []string `yaml:"skills"`
	// SkillPool 是玩家可以挑选的技能（进游戏和死亡时挑），挑 Pick() 个放到第 2 格起。
	SkillPool []string `yaml:"skill_pool"`
	// Skins 是职业的外观，第一个是默认皮肤。
	Skins []*Skin `yaml:"skins"`
	// Starter 是第一次当这个职业时放进背包的物品（比如本职业的普通武器）。
	Starter []string `yaml:"starter"`
}

// Pick 是玩家要挑几个技能（第 1 格普攻固定，不用挑）。
func (class *Class) Pick() int { return max(0, len(class.Skills)-1) }

// DefaultClass 是新玩家的职业（列表里的第一个）。
func (player *Player) DefaultClass() *Class { return player.Classes[0] }

// Class 按 id 找职业，找不到返回 nil。
func (player *Player) Class(id string) *Class {
	for _, class := range player.Classes {
		if class.ID == id {
			return class
		}
	}
	return nil
}

// Block 是玩家按住右键格挡时的效果：只挡正面，挡一下扣架势，架势扣空就破防；
// 刚举盾的一小段时间里挡住近战是完美格挡。不写或写 0 的参数用默认值（见 block.go 的 defaultBlock）。
type Block struct {
	Reduce BasisPoints `yaml:"reduce"` // 格挡时受到的伤害减少的万分比，8000 = 减少 80%
	Speed  BasisPoints `yaml:"speed"`  // 格挡时的移动速度倍率，万分比
	Arc    int         `yaml:"arc"`    // 挡得住的正面角度（度），盾朝着的方向两边各一半
	// Guard 是架势上限（点数），挡一下按命中档位扣（world.yaml hit.weights 的 guard）
	Guard int `yaml:"guard"`
	// GuardDelay 毫秒没挡到东西后架势开始回复：放下盾每秒回 GuardRegen 点，举着盾每秒回 GuardRegenHeld 点
	GuardDelay     Millis `yaml:"guard_delay"`
	GuardRegen     int    `yaml:"guard_regen"`
	GuardRegenHeld int    `yaml:"guard_regen_held"`
	BreakStun      Millis `yaml:"break_stun"`  // 破防：硬直毫秒数
	BreakKnock     int    `yaml:"break_knock"` // 破防：被推开的距离（像素）
	// Parry 是完美格挡的窗口：举盾后这么多毫秒内挡住近战，不掉血、不扣架势，攻击者被弹开
	Parry Millis `yaml:"parry"`
	// ParryRearm：盾放下至少这么多毫秒再举起才有新的完美格挡窗口（防止狂点右键）
	ParryRearm Millis `yaml:"parry_rearm"`
	ParryStun  Millis `yaml:"parry_stun"`  // 完美格挡：攻击者的硬直毫秒数
	ParryKnock int    `yaml:"parry_knock"` // 完美格挡：攻击者被弹开的距离（像素）
}

// World 对应 config/world.yaml。
type World struct {
	Map struct {
		Width  int `yaml:"width"`
		Height int `yaml:"height"`
	} `yaml:"map"`
	AOI struct {
		Cell int `yaml:"cell"`
	} `yaml:"aoi"`
	TickRate int                 `yaml:"tick_rate"`
	SyncRate int                 `yaml:"sync_rate"`
	Addr     string              `yaml:"addr"` // HTTP 监听地址，例如 ":8090" 或 "127.0.0.1:8090"
	Hostile  map[string][]string `yaml:"hostile"`
	Player   Player              `yaml:"player"`
	// HealZones 是地图上常驻的回血区（比如出生点的泉水）。
	HealZones []*Zone `yaml:"heal_zones"`
	// Loot 是怪物死亡时的装备掉落。
	Loot Loot `yaml:"loot"`
	// Pet 是宠物的复活、换宠物冷却和传送距离。
	Pet PetRules `yaml:"pet"`
	// Session 是连接断开后的处理。
	Session SessionRules `yaml:"session"`
	// Hit 是命中的分量档位、击退和韧性规则。
	Hit HitRules `yaml:"hit"`
}

// SessionRules 是会话的断线规则。
type SessionRules struct {
	// Keep 是断线后角色保留多少毫秒：期间角色原地站着、照样会被打会死，
	// 客户端带着 Welcome.token 重连就能接着玩；超时才删除角色。默认 30000。
	Keep Millis `yaml:"keep"`
}

// ZoneAspect 是回血区纵向半径和横向半径之比（万分比）：地面上画成压扁的椭圆（和其他地面特效一样），
// 判断站没站在里面也按这个椭圆，和画面一致。客户端 web/src/game/config.ts 的 ZONE_ASPECT 要和它一样（0.6）。
const ZoneAspect BasisPoints = 6000

// Zone 是地上的一块回血区：站在里面的友方（和区域阵营互不敌对的）每隔 Interval 毫秒
// 回复 ⌊最大生命 × Heal / 10000⌋。world.yaml 的 heal_zones 是常驻的；技能放的（kind: zone）
// 以施法者为中心，持续 Duration 毫秒。
type Zone struct {
	Name     string      `yaml:"name"`
	X        int         `yaml:"x"` // 只有 heal_zones 用：位置（像素）
	Y        int         `yaml:"y"`
	Faction  string      `yaml:"faction"`  // 只有 heal_zones 用：给哪个阵营回血；技能放的用施法者的阵营
	Radius   int         `yaml:"radius"`   // 横向半径（像素）；纵向半径是 Radius × ZoneAspect
	Heal     BasisPoints `yaml:"heal"`     // 每次回复最大生命的万分比
	Interval Millis      `yaml:"interval"` // 隔多少毫秒回一次，默认 1000
	Duration Millis      `yaml:"duration"` // 技能放的持续多少毫秒；heal_zones 不填（常驻）
	Look     string      `yaml:"look"`     // 客户端画法：spring 泉水 | rune 法阵
	Color    string      `yaml:"color"`
}

// Buff 是技能授予的限时属性修正。
// 比例字段都是万分比（2000 = +20%，负数是减少）。
type Buff struct {
	Name     string      `yaml:"name"`
	Duration Millis      `yaml:"duration"` // 持续毫秒数
	AtkPct   BasisPoints `yaml:"atk_pct"`
	DefPct   BasisPoints `yaml:"def_pct"`
	SpeedPct BasisPoints `yaml:"speed_pct"`
	// ShieldPct 让 Buff 带一个护盾：吸收 ⌊最大生命 × ShieldPct / 10000⌋ 的伤害，吸收完或到时间就消失。
	ShieldPct BasisPoints `yaml:"shield_pct"`
	// Invulnerable 让 Buff 期间不受任何伤害。
	Invulnerable bool `yaml:"invulnerable"`
	// BonusMagic 让物理技能每次命中额外造成 法强 × BonusMagic / 10000 的法术伤害（武器附魔）。
	BonusMagic BasisPoints `yaml:"bonus_magic"`
	// Look 是客户端给带这个 Buff 的实体加的外观：haste 疾风、holy 金光、fire 火焰武器、frost 冰冻。
	Look string `yaml:"look"`
}

// Looks 是 Buff.Look 可以取的值，以及同步给客户端时对应的位（EntityState.looks）。
var Looks = map[string]int32{"haste": 1, "holy": 2, "fire": 4, "frost": 8}

// Skill 对应 config/skills.yaml 中的一个条目。
type Skill struct {
	ID       string      `yaml:"-"`
	Name     string      `yaml:"name"`
	Desc     string      `yaml:"desc"`     // 选技能面板上的一句话说明
	Kind     string      `yaml:"kind"`     // target | aoe | self | ally 友方 | dash 位移 | line 直线投掷 | zone 放回血区 | rain 范围落箭
	Range    int         `yaml:"range"`    // 射程（像素）
	Radius   int         `yaml:"radius"`   // 范围半径（像素）
	Cooldown Millis      `yaml:"cooldown"` // 冷却毫秒数
	Damage   string      `yaml:"damage"`   // physical | magic | ""
	Ratio    BasisPoints `yaml:"ratio"`    // 攻击系数，万分比（12000 = 攻击 × 1.2）
	Base     int         `yaml:"base"`     // 固定伤害
	Heal     BasisPoints `yaml:"heal"`     // self：回复自身最大生命的万分比；ally：回复目标最大生命的万分比
	Distance int         `yaml:"distance"` // dash：位移距离；rain：没有目标时落点在前方多远（像素）
	Pierce   bool        `yaml:"pierce"`   // line：穿透，命中直线上的每个敌人
	Buff     *Buff       `yaml:"buff"`
	Debuff   *Buff       `yaml:"debuff"` // 命中时加在目标身上的效果（比如减速）
	Zone     *Zone       `yaml:"zone"`   // zone：在脚下放的回血区
	FX       string      `yaml:"fx"`
	Color    string      `yaml:"color"`
	// Weight 是命中的分量：light | medium | heavy（默认 light），决定击退、硬直和打掉的韧性（见 world.yaml 的 hit）。
	Weight string `yaml:"weight"`
	// Windup 是前摇毫秒数：出招后过这么久才结算命中，期间可以被打断、可以被躲开。只有 target 和 aoe 技能能有前摇。
	Windup Millis `yaml:"windup"`
	// Knock、Stun、PoiseDmg 覆盖 weight 档位的击退距离（像素）、硬直毫秒数和打掉的韧性（0 = 用档位的）
	Knock    int    `yaml:"knock"`
	Stun     Millis `yaml:"stun"`
	PoiseDmg int    `yaml:"poise_dmg"`
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
	Speed   int      `yaml:"speed"`  // 像素 / 秒
	Radius  int      `yaml:"radius"` // 像素
	Color   string   `yaml:"color"`
	Model   string   `yaml:"model"` // 客户端外观；默认为模板 id
	Skills  []string `yaml:"skills"`
	Respawn Millis   `yaml:"respawn"` // 死后多少毫秒复活
	Exp     int      `yaml:"exp"`
	// Poise 是韧性：挨打时被打掉，打空了才会被击退和硬直（0 = 每下都会）。见 world.yaml 的 hit。
	Poise int `yaml:"poise"`
	// Mass 是重量（万分比，默认 10000 = 1 倍）：击退距离 × 10000 / Mass。
	Mass BasisPoints `yaml:"mass"`
}

// Spawn 在 (X, Y) 周围放置 Count 份模板副本。
type Spawn struct {
	Template string `yaml:"template"`
	X        int    `yaml:"x"`
	Y        int    `yaml:"y"`
	Count    int    `yaml:"count"`
	Spread   int    `yaml:"spread"`
}

// Config 是从配置目录加载的全部内容。
type Config struct {
	World     World
	Skills    map[string]*Skill
	Templates map[string]*Template
	Spawns    []Spawn
	Layout    Layout  // 对应 map.tmj
	Items     []*Item // 对应 items.yaml，按文件里的顺序
	Pets      []*Pet  // 对应 pets.yaml，按文件里的顺序；第一个是进游戏默认召唤的
	// Scenes 是场景模板（scenes.yaml）。没有 scenes.yaml 时只有一个场景，用 Layout、Spawns 等旧字段。
	// 有的时候 Layout、Spawns、World.HealZones、World.Player.Spawn、World.Map 是默认场景的。
	Scenes Scenes

	itemsByID map[string]*Item // 由 validate 建立
}

// Load 从 dir 读取 world.yaml、skills.yaml、monsters.yaml、items.yaml、pets.yaml 和 map.tmj，并检查每个引用都能解析。
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
	var items struct {
		Items []*Item `yaml:"items"`
	}
	if err := readYAML(filepath.Join(dir, "items.yaml"), &items); err != nil {
		return nil, err
	}
	cfg.Items = items.Items
	var pets struct {
		Pets []*Pet `yaml:"pets"`
	}
	if err := readYAML(filepath.Join(dir, "pets.yaml"), &pets); err != nil {
		return nil, err
	}
	cfg.Pets = pets.Pets
	hasScenes, err := loadScenes(dir, &cfg.Scenes)
	if err != nil {
		return nil, err
	}
	if !hasScenes {
		if cfg.Layout, err = loadLayout(dir); err != nil {
			return nil, err
		}
		if err := cfg.validate(knownTrees); err != nil {
			return nil, err
		}
		cfg.Scenes = Scenes{Default: "main", List: []*Scene{cfg.singleScene()}}
		return cfg, cfg.validateScenes()
	}
	if len(cfg.Spawns) > 0 || len(cfg.World.HealZones) > 0 {
		return nil, fmt.Errorf(
			"with %s, monsters.yaml spawns and world.yaml heal_zones belong to each scene in %s",
			ScenesFile,
			ScenesFile,
		)
	}
	cfg.useScene(cfg.Scenes.DefaultScene())
	if err := cfg.validate(knownTrees); err != nil {
		return nil, err
	}
	return cfg, cfg.validateScenes()
}

// Single 是只有一个场景的配置（没有 scenes.yaml 时 Load 的结果，或测试里手工搭的配置）
// 补上场景列表：唯一的场景用 cfg 自己的地图、刷怪、回血区和出生点。已经有场景列表时什么都不做。
func (cfg *Config) Single() *Config {
	if len(cfg.Scenes.List) == 0 {
		cfg.Scenes = Scenes{Default: "main", List: []*Scene{cfg.singleScene()}}
		cfg.Scenes.fillLineRules()
		cfg.Scenes.List[0].Cfg = cfg
	}
	return cfg
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
	if 1000%world.TickRate != 0 {
		return fmt.Errorf("world.yaml: tick_rate must divide 1000 (one tick is a whole number of ms)")
	}
	if world.Session.Keep <= 0 {
		world.Session.Keep = 30000
	}
	if world.Player.Level <= 0 {
		world.Player.Level = 1
	}
	if err := world.Player.Block.validate(); err != nil {
		return err
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
		case "target", "aoe", "self", "ally", "dash", "line", "zone", "rain":
		default:
			return fmt.Errorf("skills.yaml: skill %s has unknown kind %q", id, skill.Kind)
		}
		switch skill.Damage {
		case "", "physical", "magic":
		default:
			return fmt.Errorf("skills.yaml: skill %s has unknown damage %q", id, skill.Damage)
		}
		if skill.Kind == "dash" && skill.Distance <= 0 {
			return fmt.Errorf("skills.yaml: dash skill %s needs a distance", id)
		}
		if skill.Kind == "rain" && (skill.Range <= 0 || skill.Radius <= 0 || skill.Distance <= 0) {
			return fmt.Errorf("skills.yaml: rain skill %s needs a range, radius and distance", id)
		}
		if skill.Pierce && skill.Kind != "line" {
			return fmt.Errorf("skills.yaml: skill %s has pierce but is not a line skill", id)
		}
		if skill.Kind == "ally" && (skill.Range <= 0 || skill.Heal <= 0) {
			return fmt.Errorf("skills.yaml: ally skill %s needs a range and heal", id)
		}
		if skill.Kind == "line" && skill.Range <= 0 {
			return fmt.Errorf("skills.yaml: line skill %s needs a range", id)
		}
		if skill.Kind == "zone" {
			if skill.Zone == nil || skill.Zone.Duration <= 0 {
				return fmt.Errorf("skills.yaml: zone skill %s needs a zone with a duration", id)
			}
			if err := checkZone("skills.yaml: skill "+id, skill.Zone); err != nil {
				return err
			}
		}
		for _, buff := range []*Buff{skill.Buff, skill.Debuff} {
			if buff == nil || buff.Look == "" {
				continue
			}
			if _, ok := Looks[buff.Look]; !ok {
				return fmt.Errorf("skills.yaml: skill %s has unknown buff look %q", id, buff.Look)
			}
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
	if len(world.Player.Classes) == 0 {
		return fmt.Errorf("world.yaml: player needs at least one class")
	}
	seenClasses := map[string]bool{}
	for i, class := range world.Player.Classes {
		owner := fmt.Sprintf("world.yaml player.classes[%d]", i)
		if class.ID == "" {
			return fmt.Errorf("%s: class needs an id", owner)
		}
		if seenClasses[class.ID] {
			return fmt.Errorf("%s: duplicate class id %q", owner, class.ID)
		}
		seenClasses[class.ID] = true
		owner = "world.yaml class " + class.ID
		if class.Model == "" {
			class.Model = class.ID
		}
		if class.Speed <= 0 || class.Radius <= 0 {
			return fmt.Errorf("%s: speed and radius must be positive", owner)
		}
		if len(class.Skills) == 0 {
			return fmt.Errorf("%s: needs at least one skill", owner)
		}
		if err := checkSkills(owner+" skills", class.Skills); err != nil {
			return err
		}
		if err := checkSkills(owner+" skill_pool", class.SkillPool); err != nil {
			return err
		}
		for _, id := range class.Skills[1:] {
			if !slices.Contains(class.SkillPool, id) {
				return fmt.Errorf("%s: default skill %q is not in skill_pool", owner, id)
			}
		}
		if err := validateSkins(owner, class); err != nil {
			return err
		}
	}
	if err := cfg.validateItems(); err != nil {
		return err
	}
	if err := cfg.validatePets(knownTrees); err != nil {
		return err
	}
	if err := cfg.validateHits(); err != nil {
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
		// 行为树放技能时不给方向（combat.Cast），要瞄准的技能怪物用不了
		for _, skillID := range template.Skills {
			if kind := cfg.Skills[skillID].Kind; kind == "dash" || kind == "line" || kind == "rain" {
				return fmt.Errorf("monsters.yaml: template %s cannot use %s skill %s", id, kind, skillID)
			}
		}
	}
	if err := cfg.validatePlacement("world.yaml"); err != nil {
		return err
	}
	return cfg.validateGear()
}

// checkZone 检查回血区的半径和回血量，并补上默认的回血间隔和画法。
func checkZone(owner string, zone *Zone) error {
	if zone.Radius <= 0 || zone.Heal <= 0 {
		return fmt.Errorf("%s: zone needs a radius and heal", owner)
	}
	if zone.Interval <= 0 {
		zone.Interval = 1000
	}
	switch zone.Look {
	case "":
		zone.Look = "rune"
	case "spring", "rune":
	default:
		return fmt.Errorf("%s: zone has unknown look %q", owner, zone.Look)
	}
	return nil
}

// Contains 报告 (x, y) 是否在中心为 (centerX, centerY) 的这块回血区的椭圆里。
func (zone *Zone) Contains(centerX, centerY, x, y float64) bool {
	aspect := float64(ZoneAspect) / OneHundredPercent
	return math.Hypot(x-centerX, (y-centerY)/aspect) <= float64(zone.Radius)
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

// validatePlacement 检查和地图有关的配置：回血区、地图尺寸、物件在地图内、刷怪模板存在。
// 每个场景各查一遍；label 是报错时的来源。
func (cfg *Config) validatePlacement(label string) error {
	world := &cfg.World
	for i, zone := range world.HealZones {
		owner := fmt.Sprintf("%s: heal_zones[%d]", label, i)
		if _, ok := world.Hostile[zone.Faction]; !ok {
			return fmt.Errorf("%s has faction %q missing from hostile", owner, zone.Faction)
		}
		if zone.Duration != 0 {
			return fmt.Errorf("%s is permanent and must not have a duration", owner)
		}
		if err := checkZone(owner, zone); err != nil {
			return err
		}
	}
	if layout := cfg.Layout; layout.Source != nil &&
		(layout.Width != world.Map.Width || layout.Height != world.Map.Height) {
		return fmt.Errorf(
			"%s is %dx%d but world.yaml map is %dx%d; change one to match",
			MapFile,
			layout.Width,
			layout.Height,
			world.Map.Width,
			world.Map.Height,
		)
	}
	for _, prop := range cfg.Layout.Props {
		if prop.X < 0 || prop.Y < 0 || prop.X > float64(world.Map.Width) || prop.Y > float64(world.Map.Height) {
			return fmt.Errorf(
				"%s: prop %s at (%g, %g) is off the %dx%d map",
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
				"%s: spawn %d uses unknown template %q",
				label,
				i,
				spawnCfg.Template,
			)
		}
	}
	return nil
}
