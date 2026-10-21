// Package attr 负责计算派生属性，并处理经验与升级。
package attr

import (
	"math"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 派生属性公式，其中 Str/Agi/Int/Vit 为基础属性：
//
//	MaxHP   = 80 + Vit*12 + Str*2
//	Atk     = 8 + Str*2 + Agi*0.5
//	MAtk    = 8 + Int*2.5
//	Def     = 4 + Vit*1 + Str*0.5
//	MDef    = 4 + Int*1 + Vit*0.5
//	Crit    = min(0.6, 0.05 + Agi*0.004)
//	CritDmg = 1.5 + Agi*0.005
//	Speed   = 基础移速
//
// 随后 Buff 会对结果进行缩放：Atk 和 MAtk 按 (1+ΣAtkPct) 缩放，Def 和 MDef 按
// (1+ΣDefPct) 缩放，Speed 按 (1+ΣSpeedPct) 缩放。

// Compute 根据基础属性、基础移动速度和生效中的 Buff 计算派生属性。
func Compute(base config.Attrs, speed float64, buffs []*core.Buff) core.Derived {
	d := core.Derived{
		MaxHP:   80 + base.Vit*12 + base.Str*2,
		Atk:     8 + base.Str*2 + base.Agi*0.5,
		MAtk:    8 + base.Int*2.5,
		Def:     4 + base.Vit*1 + base.Str*0.5,
		MDef:    4 + base.Int*1 + base.Vit*0.5,
		Crit:    math.Min(0.6, 0.05+base.Agi*0.004),
		CritDmg: 1.5 + base.Agi*0.005,
		Speed:   speed,
	}
	var atkPct, defPct, speedPct float64
	for _, b := range buffs {
		if b.Cfg == nil {
			continue
		}
		atkPct += b.Cfg.AtkPct
		defPct += b.Cfg.DefPct
		speedPct += b.Cfg.SpeedPct
	}
	d.Atk *= 1 + atkPct
	d.MAtk *= 1 + atkPct
	d.Def *= 1 + defPct
	d.MDef *= 1 + defPct
	d.Speed *= 1 + speedPct
	return d
}

// Recalc 根据 e.Base、e.Speed 和 e.Buffs 重新计算 e.Attr。MaxHP 变化时，HP 保持与
// MaxHP 的比例不变（若旧的 MaxHP 为 0，则 HP 保持不变）。随后 HP 被限制在 [0, MaxHP] 之内。
func Recalc(e *core.Entity) {
	old := e.Attr.MaxHP
	e.Attr = Compute(e.Base, e.Speed, e.Buffs)
	if old > 0 && e.Attr.MaxHP != old {
		e.HP = e.HP / old * e.Attr.MaxHP
	}
	e.HP = math.Max(0, math.Min(e.HP, e.Attr.MaxHP))
}

// Init 从零开始设置 e 的属性，并将 HP 补满。
func Init(e *core.Entity) {
	Recalc(e)
	e.HP = e.Attr.MaxHP
}

// ExpToNext 为从 level 升到 level+1 所需的经验：100*level。
func ExpToNext(level int) int { return 100 * level }

// System 负责发放经验并让实体升级。
type System struct {
	s *core.State
}

// New 创建属性系统。
func New(s *core.State) *System { return &System{s: s} }

// LevelUp 使 e 升一级：基础属性按 e.Growth 增长。
func LevelUp(e *core.Entity) {
	e.Level++
	e.Base.Str += e.Growth.Str
	e.Base.Agi += e.Growth.Agi
	e.Base.Int += e.Growth.Int
	e.Base.Vit += e.Growth.Vit
}

// GainExp 为 e 增加经验，并在经验允许的范围内连续升级。每次升级都会提升基础属性、
// 补满 HP，并通知客户端。
func (a *System) GainExp(e *core.Entity, n int) {
	e.Exp += n
	for e.Exp >= ExpToNext(e.Level) {
		e.Exp -= ExpToNext(e.Level)
		LevelUp(e)
		Init(e)
		a.s.Events.Emit(e, &core.Event{Kind: pb.EventKind_LEVEL_UP.Enum(), Id: core.I32(e.ID), Lv: core.I32(e.Level)})
	}
}
