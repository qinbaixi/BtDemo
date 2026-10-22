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
// 装备的加成（config.StatBonus）分两步加：str/agi/int/vit 先加到基础属性上再套公式；
// max_hp、atk 等派生属性的加成直接加在公式的结果上（暴击率的 0.6 上限只管公式那部分），
// cdr 求和后限制在 config.MaxCDR 以内。
//
// 随后 Buff 会对结果进行缩放：Atk 和 MAtk 按 (1+ΣAtkPct) 缩放，Def 和 MDef 按
// (1+ΣDefPct) 缩放，Speed 按 (1+ΣSpeedPct) 缩放（装备加的那部分也一起缩放）。

// Compute 根据基础属性、基础移动速度和生效中的 Buff 计算派生属性（不算装备）。
func Compute(base config.Attrs, speed float64, buffs []*core.Buff) core.Derived {
	return ComputeWithGear(base, speed, buffs, config.StatBonus{})
}

// ComputeWithGear 和 Compute 一样，另外加上装备的属性加成 gear。
func ComputeWithGear(
	base config.Attrs,
	speed float64,
	buffs []*core.Buff,
	gear config.StatBonus,
) core.Derived {
	base.Str += gear.Attrs.Str
	base.Agi += gear.Attrs.Agi
	base.Int += gear.Attrs.Int
	base.Vit += gear.Attrs.Vit
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
	derived.MaxHP += gear.MaxHP
	derived.Atk += gear.Atk
	derived.MAtk += gear.MAtk
	derived.Def += gear.Def
	derived.MDef += gear.MDef
	derived.Crit += gear.Crit
	derived.CritDmg += gear.CritDmg
	derived.Speed += gear.Speed
	derived.CDR = math.Max(0, math.Min(config.MaxCDR, gear.CDR))
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

// GearBonus 是 entity 身上所有装备着的物品的属性加成之和。
func GearBonus(entity *core.Entity) config.StatBonus {
	var bonus config.StatBonus
	for _, owned := range entity.Items {
		if owned.Slot != "" {
			bonus.Add(owned.Cfg.Bonus)
		}
	}
	return bonus
}

// Recalc 根据 entity.Base、entity.Speed、entity.Buffs 和装备重新计算 entity.Attr。MaxHP 变化时，HP 保持与
// MaxHP 的比例不变（若旧的 MaxHP 为 0，则 HP 保持不变）。随后 HP 被限制在 [0, MaxHP] 之内。
func Recalc(entity *core.Entity) {
	old := entity.Attr.MaxHP
	entity.Attr = ComputeWithGear(entity.Base, entity.Speed, entity.Buffs, GearBonus(entity))
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
