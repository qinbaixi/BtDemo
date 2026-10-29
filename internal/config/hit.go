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
	Knock float64 `yaml:"knock"` // 击退距离（像素），再除以目标的 mass
	Stun  float64 `yaml:"stun"`  // 硬直秒数：期间不能移动、不能出招，行为树暂停
	Poise float64 `yaml:"poise"` // 打掉的韧性；韧性打空才会被击退和硬直
	Guard float64 `yaml:"guard"` // 被举盾挡住时扣掉的架势；架势扣空就破防
}

// HitRules 对应 world.yaml 的 hit 段：命中档位和击退、韧性的公共规则。
type HitRules struct {
	Weights    map[string]HitWeight `yaml:"weights"`
	KnockTime  float64              `yaml:"knock_time"`  // 击退位移用多少秒走完
	WallStun   float64              `yaml:"wall_stun"`   // 被打到撞墙时额外的硬直秒数
	PoiseReset float64              `yaml:"poise_reset"` // 多少秒没挨打韧性回满
	Reach      float64              `yaml:"reach"`       // 前摇结束结算时，目标可以比技能射程多跑出去这么远仍算命中
}

// 没配 world.yaml 的 hit 段时用的默认值
var defaultHitWeights = map[string]HitWeight{
	WeightLight:  {Knock: 10, Stun: 0.15, Poise: 10, Guard: 12},
	WeightMedium: {Knock: 26, Stun: 0.25, Poise: 25, Guard: 22},
	WeightHeavy:  {Knock: 50, Stun: 0.45, Poise: 45, Guard: 40},
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
		rules.KnockTime = 0.18
	}
	if rules.WallStun < 0 {
		return fmt.Errorf("world.yaml: hit.wall_stun must be >= 0")
	}
	if rules.PoiseReset <= 0 {
		rules.PoiseReset = 2
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
		// 前摇只给单体和自身范围技能：投掷、位移、箭雨的轨迹在出手时就要算好
		if skill.Windup > 0 && skill.Kind != "target" && skill.Kind != "aoe" {
			return fmt.Errorf("skills.yaml: skill %s has a windup but kind %q (only target and aoe)", id, skill.Kind)
		}
	}
	player := &cfg.World.Player
	if player.Poise < 0 || player.Mass < 0 {
		return fmt.Errorf("world.yaml: player.poise and player.mass must be >= 0")
	}
	if player.Mass == 0 {
		player.Mass = 1
	}
	for id, template := range cfg.Templates {
		if template.Poise < 0 || template.Mass < 0 {
			return fmt.Errorf("monsters.yaml: template %s: poise and mass must be >= 0", id)
		}
		if template.Mass == 0 {
			template.Mass = 1
		}
	}
	for _, pet := range cfg.Pets {
		if pet.Poise < 0 || pet.Mass < 0 {
			return fmt.Errorf("pets.yaml: pet %s: poise and mass must be >= 0", pet.ID)
		}
		if pet.Mass == 0 {
			pet.Mass = 1
		}
	}
	return nil
}
