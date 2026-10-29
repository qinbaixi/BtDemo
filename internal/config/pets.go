package config

import "fmt"

// Pet 是 config/pets.yaml 中的一个宠物模板：字段和怪物模板类似，另外有成长和选择面板上的说明。
type Pet struct {
	ID     string `yaml:"id"`
	Name   string `yaml:"name"`
	Model  string `yaml:"model"` // 客户端外观；默认为宠物 id
	Color  string `yaml:"color"`
	Desc   string `yaml:"desc"` // 选择面板上的一句话说明
	Tree   string `yaml:"tree"` // 行为树名，对应 bt/trees/<tree>.json
	Attrs  Attrs  `yaml:"attrs"`
	Growth Attrs  `yaml:"growth"` // 每比 1 级高一级增加的基础属性，万分之一点（12000 = 1.2 点）
	Speed  int    `yaml:"speed"`  // 像素 / 秒
	Radius int    `yaml:"radius"` // 像素
	// Skills 是技能槽，行为树里 CastSkill 的 Slot 从 1 开始对应这里的顺序
	Skills []string `yaml:"skills"`
	// Poise、Mass 是韧性和重量，含义同 monsters.yaml
	Poise int         `yaml:"poise"`
	Mass  BasisPoints `yaml:"mass"`
}

// PetRules 对应 world.yaml 的 pet 段：宠物的复活、换宠物冷却和传送距离。
type PetRules struct {
	Respawn      Millis `yaml:"respawn"`       // 宠物死后多少毫秒在主人身边复活
	SwapCooldown Millis `yaml:"swap_cooldown"` // 换宠物（含收回）之后多少毫秒内不能再换
	Teleport     int    `yaml:"teleport"`      // 离主人超过这个距离（像素）直接传送到主人身边
}

// 没配 pet 段时的默认值。
const (
	DefaultPetRespawn      Millis = 10000
	DefaultPetSwapCooldown Millis = 5000
	DefaultPetTeleport            = 600
)

// Pet 按 id 找宠物模板，找不到返回 nil。
func (cfg *Config) Pet(id string) *Pet {
	for _, pet := range cfg.Pets {
		if pet.ID == id {
			return pet
		}
	}
	return nil
}

// validatePets 检查 pets.yaml：id 不重复、行为树和技能都存在、技能不需要瞄准，并补上默认值。
func (cfg *Config) validatePets(knownTrees map[string]bool) error {
	rules := &cfg.World.Pet
	if rules.Respawn <= 0 {
		rules.Respawn = DefaultPetRespawn
	}
	if rules.SwapCooldown <= 0 {
		rules.SwapCooldown = DefaultPetSwapCooldown
	}
	if rules.Teleport <= 0 {
		rules.Teleport = DefaultPetTeleport
	}
	seen := map[string]bool{}
	for index, pet := range cfg.Pets {
		if pet.ID == "" {
			return fmt.Errorf("pets.yaml: pets[%d] needs an id", index)
		}
		if seen[pet.ID] {
			return fmt.Errorf("pets.yaml: duplicate pet id %q", pet.ID)
		}
		seen[pet.ID] = true
		if pet.Model == "" {
			pet.Model = pet.ID
		}
		if pet.Speed <= 0 || pet.Radius <= 0 {
			return fmt.Errorf("pets.yaml: pet %s needs a positive speed and radius", pet.ID)
		}
		if !knownTrees[pet.Tree] {
			return fmt.Errorf("pets.yaml: pet %s uses unknown behavior tree %q", pet.ID, pet.Tree)
		}
		for _, skillID := range pet.Skills {
			skill := cfg.Skills[skillID]
			if skill == nil {
				return fmt.Errorf("pets.yaml: pet %s has unknown skill %q", pet.ID, skillID)
			}
			// 行为树放技能时不给方向，要瞄准的技能宠物用不了
			if skill.Kind == "dash" || skill.Kind == "line" || skill.Kind == "rain" {
				return fmt.Errorf("pets.yaml: pet %s cannot use %s skill %s", pet.ID, skill.Kind, skillID)
			}
		}
	}
	return nil
}
