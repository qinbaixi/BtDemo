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
}

// entityInfo 是实体进入视野时客户端获知的信息。
func entityInfo(e *core.Entity) *pb.EntityInfo {
	return &pb.EntityInfo{
		Id: core.I32(e.ID), Kind: kindToPB[e.Kind].Enum(), Name: proto.String(e.Name),
		Color: proto.String(e.Color), R: core.F32(e.Radius), Lv: core.I32(e.Level),
		X: core.F32(core.Round1(e.X)), Y: core.F32(core.Round1(e.Y)),
		Hp: core.F32(math.Ceil(e.HP)), MaxHp: core.F32(math.Ceil(e.Attr.MaxHP)), Model: proto.String(e.Model),
	}
}

// entityState 是可见实体在每次同步时的状态。
func entityState(e *core.Entity) *pb.EntityState {
	return &pb.EntityState{
		Id: core.I32(e.ID), X: core.F32(core.Round1(e.X)), Y: core.F32(core.Round1(e.Y)),
		Hp: core.F32(math.Ceil(e.HP)), MaxHp: core.F32(math.Ceil(e.Attr.MaxHP)), Lv: core.I32(e.Level),
		Act: proto.String(e.Action), Tg: core.I32(e.Target), Dead: proto.Bool(e.Dead),
	}
}

// selfInfo 是玩家自身的属性、冷却和增益效果。
func selfInfo(e *core.Entity, now float64) *pb.SelfInfo {
	si := &pb.SelfInfo{
		Lv: core.I32(e.Level), Exp: core.I32(e.Exp), Next: core.I32(attr.ExpToNext(e.Level)), Hp: core.F32(math.Ceil(e.HP)),
		Base: &pb.Attrs{Str: core.F32(e.Base.Str), Agi: core.F32(e.Base.Agi), Int: core.F32(e.Base.Int), Vit: core.F32(e.Base.Vit)},
		Attr: &pb.Derived{
			MaxHp: core.F32(e.Attr.MaxHP), Atk: core.F32(e.Attr.Atk), Matk: core.F32(e.Attr.MAtk), Def: core.F32(e.Attr.Def),
			Mdef: core.F32(e.Attr.MDef), Crit: core.F32(e.Attr.Crit), CritDmg: core.F32(e.Attr.CritDmg), Speed: core.F32(e.Attr.Speed),
		},
		Dead:      proto.Bool(e.Dead),
		RespawnIn: core.F32(math.Max(0, core.Round1(e.RespawnAt-now))),
	}
	for _, sk := range e.Skills {
		if left := e.Cooldowns[sk.ID] - now; left > 0 {
			si.Cds = append(si.Cds, &pb.SkillCooldown{Skill: proto.String(sk.ID), Left: core.F32(core.Round1(left))})
		}
	}
	for _, b := range e.Buffs {
		si.Buffs = append(si.Buffs, &pb.BuffInfo{Name: proto.String(b.Cfg.Name), Left: core.F32(core.Round1(b.Until - now))})
	}
	return si
}

// mapInfo 是欢迎消息中包含的地图场景物件和障碍物形状。
func mapInfo(l config.Layout, m *nav.Map) ([]*pb.MapProp, []*pb.Obstacle) {
	props := make([]*pb.MapProp, 0, len(l.Props))
	for _, p := range l.Props {
		mp := &pb.MapProp{Kind: proto.String(p.Kind), X: core.F32(p.X), Y: core.F32(p.Y), S: core.F32(p.S)}
		if p.Variant != 0 {
			mp.Variant = core.I32(p.Variant)
		}
		if p.Flip {
			mp.Flip = proto.Bool(true)
		}
		if p.DX != 0 || p.DY != 0 {
			mp.Dx, mp.Dy = core.F32(p.DX), core.F32(p.DY)
		}
		props = append(props, mp)
	}
	shapes := m.Shapes()
	obs := make([]*pb.Obstacle, 0, len(shapes))
	for _, sh := range shapes {
		o := &pb.Obstacle{Shape: pb.ObstacleShape(sh.Kind).Enum(), Ax: core.F32(sh.A.X), Ay: core.F32(sh.A.Y)}
		switch sh.Kind {
		case nav.Rect:
			o.Bx, o.By = core.F32(sh.B.X), core.F32(sh.B.Y)
		case nav.Capsule:
			o.Bx, o.By, o.R = core.F32(sh.B.X), core.F32(sh.B.Y), core.F32(sh.R)
		default:
			o.R = core.F32(sh.R)
		}
		obs = append(obs, o)
	}
	return props, obs
}
