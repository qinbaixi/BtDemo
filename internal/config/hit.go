package config

import "fmt"

// 命中的分量档位（skills.yaml 的 weight）。客户端 web/src/feel/profiles.ts 按同样的名字查表。
const (
	WeightLight  = "light"
	WeightMedium = "medium"
	WeightHeavy  = "heavy"
)

// HitWeight 是一档命中的效果：把目标推多远、硬直多久、打掉多少韧性。
type HitWeight struct {
	Knock int    `yaml:"knock"` // 击退距离（像素），再除以目标的 mass
	Stun  Millis `yaml:"stun"`  // 硬直毫秒数：期间不能移动、不能出招，行为树暂停
	Poise int    `yaml:"poise"` // 打掉的韧性；韧性打空才会被击退和硬直
	Guard int    `yaml:"guard"` // 被举盾挡住时扣掉的架势（点数）；架势扣空就破防
}

// HitRules 对应 world.yaml 的 hit 段：命中档位和击退、韧性的公共规则。
type HitRules struct {
	Weights    map[string]HitWeight `yaml:"weights"`
	KnockTime  Millis               `yaml:"knock_time"`  // 击退位移用多少毫秒走完
	WallStun   Millis               `yaml:"wall_stun"`   // 被打到撞墙时额外的硬直毫秒数
	PoiseReset Millis               `yaml:"poise_reset"` // 多少毫秒没挨打韧性回满
	Reach      int                  `yaml:"reach"`       // 前摇结束结算时，目标可以比技能射程多跑出去这么远（像素）仍算命中
}

// 没配 world.yaml 的 hit 段时用的默认值
var defaultHitWeights = map[string]HitWeight{
	WeightLight:  {Knock: 10, Stun: 150, Poise: 10, Guard: 12},
	WeightMedium: {Knock: 26, Stun: 250, Poise: 25, Guard: 22},
	WeightHeavy:  {Knock: 50, Stun: 450, Poise: 45, Guard: 40},
}

// Ranged 报告技能是不是远程的（投射物、直线投掷、箭雨）：远程能被格挡，但不能完美格挡弹开。
func (skill *Skill) Ranged() bool {
	switch skill.Kind {
	case "line", "rain":
		return true
	}
	switch skill.FX {
	case "projectile", "arrow", "frostarrow", "pierce":
		return true
	}
	return false
}

// NeedsSight 报告技能是不是要看得见目标才能放：单体的远程技能（射箭、火球）。
// 出手时看不见放不出来；飞行中目标躲到墓碑、墙后面，打在挡住的东西上。
// 直线投掷和箭雨不用：它们本来就沿直线飞、碰到墙就停。
func (skill *Skill) NeedsSight() bool {
	return skill.Kind == "target" && skill.Ranged()
}

// Smashes 报告技能砸不砸得碎骨堆（模板 heavy_only 的怪）：重击，或者范围技能（旋风斩、箭雨）。
func (skill *Skill) Smashes() bool {
	return skill.Weight == WeightHeavy || skill.Kind == "aoe" || skill.Kind == "rain"
}

// Hit 返回技能命中的效果：weight 档位的默认值，被技能自己的 knock / stun / poise 覆盖。
func (rules *HitRules) Hit(skill *Skill) HitWeight {
	hit := rules.Weights[skill.Weight]
	if skill.Knock > 0 {
		hit.Knock = skill.Knock
	}
	if skill.Stun > 0 {
		hit.Stun = skill.Stun
	}
	if skill.PoiseDmg > 0 {
		hit.Poise = skill.PoiseDmg
	}
	return hit
}

// validateHits 填上命中规则的默认值，检查技能的 weight 和 windup，以及各处的 poise / mass。
func (cfg *Config) validateHits() error {
	rules := &cfg.World.Hit
	if rules.Weights == nil {
		rules.Weights = map[string]HitWeight{}
	}
	for name, weight := range defaultHitWeights {
		configured, ok := rules.Weights[name]
		if !ok {
			rules.Weights[name] = weight
			continue
		}
		// 只写了击退、硬直、韧性的老配置：架势消耗用默认值，不然这一档挡住不扣架势
		if configured.Guard == 0 {
			configured.Guard = weight.Guard
			rules.Weights[name] = configured
		}
	}
	if rules.KnockTime <= 0 {
		rules.KnockTime = 180
	}
	if rules.WallStun < 0 {
		return fmt.Errorf("world.yaml: hit.wall_stun must be >= 0")
	}
	if rules.PoiseReset <= 0 {
		rules.PoiseReset = 2000
	}
	if rules.Reach < 0 {
		return fmt.Errorf("world.yaml: hit.reach must be >= 0")
	}
	for id, skill := range cfg.Skills {
		if skill.Weight == "" {
			skill.Weight = WeightLight
		}
		if _, ok := rules.Weights[skill.Weight]; !ok {
			return fmt.Errorf("skills.yaml: skill %s has unknown weight %q", id, skill.Weight)
		}
		if skill.Windup < 0 || skill.Knock < 0 || skill.Stun < 0 || skill.PoiseDmg < 0 {
			return fmt.Errorf("skills.yaml: skill %s: windup, knock, stun and poise_dmg must be >= 0", id)
		}
		// 前摇只给单体、自身范围技能和冲锋：投掷、位移、箭雨的轨迹在出手时就要算好
		if skill.Windup > 0 && skill.Kind != "target" && skill.Kind != "aoe" && skill.Kind != "charge" {
			return fmt.Errorf(
				"skills.yaml: skill %s has a windup but kind %q (only target, aoe and charge)",
				id,
				skill.Kind,
			)
		}
	}
	player := &cfg.World.Player
	if player.Poise < 0 || player.Mass < 0 {
		return fmt.Errorf("world.yaml: player.poise and player.mass must be >= 0")
	}
	if player.Mass == 0 {
		player.Mass = OneHundredPercent
	}
	for id, template := range cfg.Templates {
		if template.Poise < 0 || template.Mass < 0 {
			return fmt.Errorf("monsters.yaml: template %s: poise and mass must be >= 0", id)
		}
		if template.Mass == 0 {
			template.Mass = OneHundredPercent
		}
	}
	for _, pet := range cfg.Pets {
		if pet.Poise < 0 || pet.Mass < 0 {
			return fmt.Errorf("pets.yaml: pet %s: poise and mass must be >= 0", pet.ID)
		}
		if pet.Mass == 0 {
			pet.Mass = OneHundredPercent
		}
	}
	return nil
}
