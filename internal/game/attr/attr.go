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
	derived := core.Derived{
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
	for _, buff := range buffs {
		if buff.Cfg == nil {
			continue
		}
		atkPct += buff.Cfg.AtkPct
		defPct += buff.Cfg.DefPct
		speedPct += buff.Cfg.SpeedPct
	}
	derived.Atk *= 1 + atkPct
	derived.MAtk *= 1 + atkPct
	derived.Def *= 1 + defPct
	derived.MDef *= 1 + defPct
	derived.Speed *= 1 + speedPct
	return derived
}

// Recalc 根据 entity.Base、entity.Speed 和 entity.Buffs 重新计算 entity.Attr。MaxHP 变化时，HP 保持与
// MaxHP 的比例不变（若旧的 MaxHP 为 0，则 HP 保持不变）。随后 HP 被限制在 [0, MaxHP] 之内。
func Recalc(entity *core.Entity) {
	old := entity.Attr.MaxHP
	entity.Attr = Compute(entity.Base, entity.Speed, entity.Buffs)
	if old > 0 && entity.Attr.MaxHP != old {
		entity.HP = entity.HP / old * entity.Attr.MaxHP
	}
	entity.HP = math.Max(0, math.Min(entity.HP, entity.Attr.MaxHP))
}

// Init 从零开始设置 entity 的属性，并将 HP 补满。
func Init(entity *core.Entity) {
	Recalc(entity)
	entity.HP = entity.Attr.MaxHP
}

// ExpToNext 为从 level 升到 level+1 所需的经验：100*level。
func ExpToNext(level int) int { return 100 * level }

// System 负责发放经验并让实体升级。
type System struct {
	state *core.State
}

// New 创建属性系统。
func New(state *core.State) *System { return &System{state: state} }

// LevelUp 使 entity 升一级：基础属性按 entity.Growth 增长。
func LevelUp(entity *core.Entity) {
	entity.Level++
	entity.Base.Str += entity.Growth.Str
	entity.Base.Agi += entity.Growth.Agi
	entity.Base.Int += entity.Growth.Int
	entity.Base.Vit += entity.Growth.Vit
}

// GainExp 为 entity 增加经验，并在经验允许的范围内连续升级。每次升级都会提升基础属性、
// 补满 HP，并通知客户端。
func (sys *System) GainExp(entity *core.Entity, amount int) {
	entity.Exp += amount
	for entity.Exp >= ExpToNext(entity.Level) {
		entity.Exp -= ExpToNext(entity.Level)
		LevelUp(entity)
		Init(entity)
		sys.state.Events.Emit(
			entity,
			&core.Event{
				Kind: pb.EventKind_LEVEL_UP.Enum(),
				Id:   core.I32(entity.ID),
				Lv:   core.I32(entity.Level),
			},
		)
	}
}
