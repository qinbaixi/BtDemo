package session

import (
	"math"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/game/attr"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

var kindToPB = map[core.Kind]pb.EntityKind{
	core.KindPlayer:  pb.EntityKind_PLAYER,
	core.KindMonster: pb.EntityKind_MONSTER,
	core.KindNPC:     pb.EntityKind_NPC,
}

// entityInfo is what a client learns about an entity when it comes into view.
func entityInfo(e *core.Entity) *pb.EntityInfo {
	return &pb.EntityInfo{
		Id: core.I32(e.ID), Kind: kindToPB[e.Kind].Enum(), Name: proto.String(e.Name),
		Color: proto.String(e.Color), R: core.F32(e.Radius), Lv: core.I32(e.Level),
		X: core.F32(core.Round1(e.X)), Y: core.F32(core.Round1(e.Y)),
		Hp: core.F32(math.Ceil(e.HP)), MaxHp: core.F32(math.Ceil(e.Attr.MaxHP)), Model: proto.String(e.Model),
	}
}

// entityState is the per-sync state of a visible entity.
func entityState(e *core.Entity) *pb.EntityState {
	return &pb.EntityState{
		Id: core.I32(e.ID), X: core.F32(core.Round1(e.X)), Y: core.F32(core.Round1(e.Y)),
		Hp: core.F32(math.Ceil(e.HP)), MaxHp: core.F32(math.Ceil(e.Attr.MaxHP)), Lv: core.I32(e.Level),
		Act: proto.String(e.Action), Tg: core.I32(e.Target), Dead: proto.Bool(e.Dead),
	}
}

// selfInfo is the player's own attributes, cooldowns and buffs.
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
