package session

import (
	"math"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/attr"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

var kindToPB = map[core.Kind]pb.EntityKind{
	core.KindPlayer:  pb.EntityKind_PLAYER,
	core.KindMonster: pb.EntityKind_MONSTER,
	core.KindNPC:     pb.EntityKind_NPC,
	core.KindPet:     pb.EntityKind_PET,
}

// entityInfo 是实体进入视野时客户端获知的信息。
func entityInfo(entity *core.Entity) *pb.EntityInfo {
	return &pb.EntityInfo{
		Id:    core.I32(entity.ID),
		Kind:  kindToPB[entity.Kind].Enum(),
		Name:  proto.String(entity.Name),
		Color: proto.String(entity.Color),
		R:     core.F32(entity.Radius),
		Lv:    core.I32(entity.Level),
		X:     core.F32(core.Round1(entity.X)),
		Y:     core.F32(core.Round1(entity.Y)),
		Hp:    core.F32(math.Ceil(entity.HP)),
		MaxHp: core.F32(math.Ceil(entity.Attr.MaxHP)),
		Model: proto.String(entity.Model),
		Skin:  proto.String(entity.Skin),
		Gear:  proto.String(entity.GearLook()),
		Owner: core.I32(entity.Owner),
	}
}

// entityState 是可见实体在每次同步时的状态。
func entityState(entity *core.Entity) *pb.EntityState {
	return &pb.EntityState{
		Id:       core.I32(entity.ID),
		X:        core.F32(core.Round1(entity.X)),
		Y:        core.F32(core.Round1(entity.Y)),
		Hp:       core.F32(math.Ceil(entity.HP)),
		MaxHp:    core.F32(math.Ceil(entity.Attr.MaxHP)),
		Lv:       core.I32(entity.Level),
		Act:      proto.String(entity.Action),
		Tg:       core.I32(entity.Target),
		Dead:     proto.Bool(entity.Dead),
		Shield:   core.F32(math.Ceil(entity.Shield())),
		Blocking: proto.Bool(entity.Blocking),
		Looks:    core.I32(int(entity.Looks())),
	}
}

// skillInfo 是一个技能在技能栏（slot 从 1 起）或技能池（slot 为 0）里的样子。
func skillInfo(slot int, skill *config.Skill) *pb.SkillInfo {
	radius := skill.Radius
	if skill.Zone != nil {
		radius = skill.Zone.Radius // 放回血区的技能：悬停时显示区域多大
	}
	info := &pb.SkillInfo{
		Slot:     core.I32(slot),
		Id:       proto.String(skill.ID),
		Name:     proto.String(skill.Name),
		Kind:     proto.String(skill.Kind),
		Range:    core.F32(skill.Range),
		Radius:   core.F32(radius),
		Cooldown: core.F32(skill.Cooldown),
		Color:    proto.String(skill.Color),
		Fx:       proto.String(skill.FX),
		Desc:     proto.String(skill.Desc),
	}
	if skill.Kind == "dash" || skill.Kind == "rain" {
		info.Distance = core.F32(skill.Distance) // 位移距离 / 箭雨没有目标时的落点距离
	}
	return info
}

// skillPool 是职业 class 可以挑的技能（slot 为 0）。
func skillPool(cfg *config.Config, class *config.Class) []*pb.SkillInfo {
	pool := make([]*pb.SkillInfo, 0, len(class.SkillPool))
	for _, id := range class.SkillPool {
		pool = append(pool, skillInfo(0, cfg.Skills[id]))
	}
	return pool
}

// classInfo 是选职业时客户端看到的职业：默认技能栏、技能池、要挑几个、能不能格挡。
func classInfo(cfg *config.Config, class *config.Class) *pb.ClassInfo {
	defaults := make([]*config.Skill, 0, len(class.Skills))
	for _, id := range class.Skills {
		defaults = append(defaults, cfg.Skills[id])
	}
	return &pb.ClassInfo{
		Id:       proto.String(class.ID),
		Name:     proto.String(class.Name),
		Desc:     proto.String(class.Desc),
		Model:    proto.String(class.Model),
		Color:    proto.String(class.Color),
		Skills:   skillBar(defaults),
		Pool:     skillPool(cfg, class),
		Pick:     core.I32(class.Pick()),
		CanBlock: proto.Bool(class.CanBlock),
		Skins:    skinInfos(class.Skins),
	}
}

// skinInfos 是职业的皮肤列表（第一个是默认）。
func skinInfos(skins []*config.Skin) []*pb.SkinInfo {
	infos := make([]*pb.SkinInfo, 0, len(skins))
	for _, skin := range skins {
		infos = append(infos, &pb.SkinInfo{
			Id:    proto.String(skin.ID),
			Name:  proto.String(skin.Name),
			Desc:  proto.String(skin.Desc),
			Color: proto.String(skin.Color),
		})
	}
	return infos
}

// itemInfos 是装备图鉴：每件物品的定义，属性按 config.StatNames 的顺序，只列不为 0 的。
func itemInfos(items []*config.Item) []*pb.ItemInfo {
	infos := make([]*pb.ItemInfo, 0, len(items))
	for _, item := range items {
		info := &pb.ItemInfo{
			Id:     proto.String(item.ID),
			Name:   proto.String(item.Name),
			Slot:   proto.String(item.Slot),
			Class:  proto.String(item.Class),
			Rarity: proto.String(item.Rarity),
			Desc:   proto.String(item.Desc),
			Look:   proto.String(item.Look),
		}
		for _, stat := range config.StatNames {
			if value := item.Stats[stat]; value != 0 {
				info.Stats = append(info.Stats, &pb.ItemStat{
					Stat:  proto.String(stat),
					Value: proto.Float32(float32(value)),
				})
			}
		}
		if item.Effect != nil {
			info.Effect = proto.String(item.Effect.Kind)
		}
		infos = append(infos, info)
	}
	return infos
}

// inventoryInfo 是玩家完整的背包和装备，按 UID 排好；capacity 是背包格数。
func inventoryInfo(entity *core.Entity, capacity int) *pb.Inventory {
	inventory := &pb.Inventory{Capacity: core.I32(capacity)}
	for _, owned := range entity.Items {
		inventory.Items = append(inventory.Items, &pb.ItemSlotted{
			Uid:  core.I32(owned.UID),
			Id:   proto.String(owned.Cfg.ID),
			Slot: proto.String(owned.Slot),
		})
	}
	return inventory
}

// skillBar 是按格子排好的技能栏。
func skillBar(skills []*config.Skill) []*pb.SkillInfo {
	bar := make([]*pb.SkillInfo, 0, len(skills))
	for i, skill := range skills {
		bar = append(bar, skillInfo(i+1, skill))
	}
	return bar
}

// selfInfo 是玩家自身的属性、冷却和增益效果。
func selfInfo(entity *core.Entity, now float64) *pb.SelfInfo {
	self := &pb.SelfInfo{
		Lv:   core.I32(entity.Level),
		Exp:  core.I32(entity.Exp),
		Next: core.I32(attr.ExpToNext(entity.Level)),
		Hp:   core.F32(math.Ceil(entity.HP)),
		Base: &pb.Attrs{
			Str: core.F32(entity.Base.Str),
			Agi: core.F32(entity.Base.Agi),
			Int: core.F32(entity.Base.Int),
			Vit: core.F32(entity.Base.Vit),
		},
		Attr: &pb.Derived{
			MaxHp:   core.F32(entity.Attr.MaxHP),
			Atk:     core.F32(entity.Attr.Atk),
			Matk:    core.F32(entity.Attr.MAtk),
			Def:     core.F32(entity.Attr.Def),
			Mdef:    core.F32(entity.Attr.MDef),
			Crit:    core.F32(entity.Attr.Crit),
			CritDmg: core.F32(entity.Attr.CritDmg),
			Speed:   core.F32(entity.Attr.Speed),
		},
		Dead:      proto.Bool(entity.Dead),
		RespawnIn: core.F32(math.Max(0, core.Round1(entity.RespawnAt-now))),
	}
	for _, skill := range entity.Skills {
		if left := entity.Cooldowns[skill.ID] - now; left > 0 {
			self.Cds = append(
				self.Cds,
				&pb.SkillCooldown{Skill: proto.String(skill.ID), Left: core.F32(core.Round1(left))},
			)
		}
	}
	for _, buff := range entity.Buffs {
		self.Buffs = append(
			self.Buffs,
			&pb.BuffInfo{
				Name: proto.String(buff.Cfg.Name),
				Left: core.F32(core.Round1(buff.Until - now)),
			},
		)
	}
	return self
}

// obstacles 是欢迎消息中包含的障碍物形状（调试显示用；物件本身前端从 /map.tmj 读）。
func obstacles(navMap *nav.Map) []*pb.Obstacle {
	shapes := navMap.Shapes()
	obs := make([]*pb.Obstacle, 0, len(shapes))
	for _, shape := range shapes {
		obstacle := &pb.Obstacle{
			Shape: pb.ObstacleShape(shape.Kind).Enum(),
			Ax:    core.F32(shape.A.X),
			Ay:    core.F32(shape.A.Y),
		}
		switch shape.Kind {
		case nav.Rect:
			obstacle.Bx, obstacle.By = core.F32(shape.B.X), core.F32(shape.B.Y)
		case nav.Capsule:
			obstacle.Bx, obstacle.By = core.F32(shape.B.X), core.F32(shape.B.Y)
			obstacle.R = core.F32(shape.Radius)
		default:
			obstacle.R = core.F32(shape.Radius)
		}
		obs = append(obs, obstacle)
	}
	return obs
}

// zoneInfos 是发给客户端的回血区列表。
func zoneInfos(zones []*core.Zone) []*pb.Zone {
	infos := make([]*pb.Zone, 0, len(zones))
	for _, zone := range zones {
		infos = append(infos, &pb.Zone{
			Id:       core.I32(zone.ID),
			X:        core.F32(core.Round1(zone.X)),
			Y:        core.F32(core.Round1(zone.Y)),
			Radius:   core.F32(zone.Cfg.Radius),
			Name:     proto.String(zone.Cfg.Name),
			Color:    proto.String(zone.Cfg.Color),
			Look:     proto.String(zone.Cfg.Look),
			Owner:    core.I32(zone.Owner),
			Until:    core.F32(core.Round1(zone.Until)),
			Dur:      core.F32(zone.Cfg.Duration),
			Interval: core.F32(zone.Cfg.Interval),
			Heal:     core.F32(zone.Cfg.Heal),
		})
	}
	return infos
}

// petInfos 是宠物图鉴：每种宠物的名字、说明和外观，按 pets.yaml 的顺序（第一个是默认）。
func petInfos(pets []*config.Pet) []*pb.PetInfo {
	infos := make([]*pb.PetInfo, 0, len(pets))
	for _, pet := range pets {
		infos = append(infos, &pb.PetInfo{
			Id:    proto.String(pet.ID),
			Name:  proto.String(pet.Name),
			Desc:  proto.String(pet.Desc),
			Color: proto.String(pet.Color),
			Model: proto.String(pet.Model),
		})
	}
	return infos
}

// petStatus 是玩家 owner 的宠物现在的状态：选了哪只、实体 id、复活倒计时、换宠物冷却。
func petStatus(state *core.State, owner *core.Entity) *pb.PetStatus {
	now := state.Now()
	status := &pb.PetStatus{
		Pet:      proto.String(owner.PetID),
		Entity:   core.I32(owner.PetEntity),
		Cooldown: core.F32(math.Max(0, core.Round1(owner.PetSwapAt-now))),
	}
	respawnIn := 0.0
	if pet := state.Ents.Get(owner.PetEntity); pet != nil && pet.Dead {
		respawnIn = math.Max(0, core.Round1(pet.RespawnAt-now))
	}
	status.RespawnIn = core.F32(respawnIn)
	return status
}
