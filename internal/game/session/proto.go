package session

import (
	"math"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/game/attr"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

var kindToPB = map[core.Kind]pb.EntityKind{
	core.KindPlayer:  pb.EntityKind_PLAYER,
	core.KindMonster: pb.EntityKind_MONSTER,
	core.KindNPC:     pb.EntityKind_NPC,
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
	}
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
