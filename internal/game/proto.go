package game

import (
	"math"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

func i32(v int) *int32       { return proto.Int32(int32(v)) }
func f32(v float64) *float32 { return proto.Float32(float32(v)) }
func round1(v float64) float64 {
	return math.Round(v*10) / 10
}

var kindToPB = map[Kind]pb.EntityKind{
	KindPlayer:  pb.EntityKind_PLAYER,
	KindMonster: pb.EntityKind_MONSTER,
	KindNPC:     pb.EntityKind_NPC,
}

// castEvent describes e using sk on dst (nil for an aoe skill).
func castEvent(e, dst *Entity, sk *config.Skill) *Event {
	ev := &Event{
		Kind: pb.EventKind_CAST.Enum(), Src: i32(e.ID), Skill: proto.String(sk.ID),
		Name: proto.String(sk.Name), Fx: proto.String(sk.FX), Color: proto.String(sk.Color),
	}
	if dst != nil {
		ev.Dst = i32(dst.ID)
	}
	return ev
}

func entityInfo(e *Entity) *pb.EntityInfo {
	return &pb.EntityInfo{
		Id: i32(e.ID), Kind: kindToPB[e.Kind].Enum(), Name: proto.String(e.Name),
		Color: proto.String(e.Color), R: f32(e.Radius), Lv: i32(e.Level),
		X: f32(round1(e.X)), Y: f32(round1(e.Y)),
		Hp: f32(math.Ceil(e.HP)), MaxHp: f32(math.Ceil(e.Attr.MaxHP)), Model: proto.String(e.Model),
	}
}

func (w *World) selfInfo(e *Entity) *pb.SelfInfo {
	si := &pb.SelfInfo{
		Lv: i32(e.Level), Exp: i32(e.Exp), Next: i32(ExpToNext(e.Level)), Hp: f32(math.Ceil(e.HP)),
		Base: &pb.Attrs{Str: f32(e.Base.Str), Agi: f32(e.Base.Agi), Int: f32(e.Base.Int), Vit: f32(e.Base.Vit)},
		Attr: &pb.Derived{
			MaxHp: f32(e.Attr.MaxHP), Atk: f32(e.Attr.Atk), Matk: f32(e.Attr.MAtk), Def: f32(e.Attr.Def),
			Mdef: f32(e.Attr.MDef), Crit: f32(e.Attr.Crit), CritDmg: f32(e.Attr.CritDmg), Speed: f32(e.Attr.Speed),
		},
		Dead:      proto.Bool(e.Dead),
		RespawnIn: f32(math.Max(0, round1(e.RespawnAt-w.Now))),
	}
	for _, sk := range e.Skills {
		if left := e.Cooldowns[sk.ID] - w.Now; left > 0 {
			si.Cds = append(si.Cds, &pb.SkillCooldown{Skill: proto.String(sk.ID), Left: f32(round1(left))})
		}
	}
	for _, b := range e.Buffs {
		si.Buffs = append(si.Buffs, &pb.BuffInfo{Name: proto.String(b.Cfg.Name), Left: f32(round1(b.Until - w.Now))})
	}
	return si
}
