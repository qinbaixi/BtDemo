// Package attr 负责计算派生属性，并处理经验与升级。
package attr

import (
	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 派生属性公式，其中 Str/Agi/Int/Vit 为基础属性，全部整数运算、向下取整
// （暴击率、暴击倍率是万分比）：
//
//	MaxHP   = 80 + Vit*12 + Str*2
//	Atk     = 8 + Str*2 + ⌊Agi/2⌋
//	MAtk    = 8 + ⌊Int*5/2⌋
//	Def     = 4 + Vit + ⌊Str/2⌋
//	MDef    = 4 + Int + ⌊Vit/2⌋
//	Crit    = min(6000, 500 + Agi*40)        （5% + 每点敏捷 0.4%，最多 60%）
//	CritDmg = 15000 + Agi*50                 （1.5 倍 + 每点敏捷 0.005 倍）
//	Speed   = 基础移速
//
// 装备的加成（config.StatBonus）分两步加：str/agi/int/vit 先加到基础属性上再套公式；
// max_hp、atk 等派生属性的加成直接加在公式的结果上（暴击率的 6000 上限只管公式那部分），
// cdr 求和后限制在 config.MaxCDR 以内。
//
// 随后 Buff 会对结果进行缩放（万分比，向下取整）：Atk 和 MAtk 按 (10000+ΣAtkPct) 缩放，
// Def 和 MDef 按 (10000+ΣDefPct) 缩放，Speed 按 (10000+ΣSpeedPct) 缩放（装备加的那部分也一起缩放）。

// Compute 根据基础属性、基础移动速度和生效中的 Buff 计算派生属性（不算装备）。
func Compute(base config.Attrs, speed int, buffs []*core.Buff) core.Derived {
	return ComputeWithGear(base, speed, buffs, config.StatBonus{})
}

// ComputeWithGear 和 Compute 一样，另外加上装备的属性加成 gear。
func ComputeWithGear(
	base config.Attrs,
	speed int,
	buffs []*core.Buff,
	gear config.StatBonus,
) core.Derived {
	base.Str += gear.Attrs.Str
	base.Agi += gear.Attrs.Agi
	base.Int += gear.Attrs.Int
	base.Vit += gear.Attrs.Vit
	derived := core.Derived{
		MaxHP:   80 + base.Vit*12 + base.Str*2,
		Atk:     8 + base.Str*2 + config.FloorDiv(base.Agi, 2),
		MAtk:    8 + config.FloorDiv(base.Int*5, 2),
		Def:     4 + base.Vit + config.FloorDiv(base.Str, 2),
		MDef:    4 + base.Int + config.FloorDiv(base.Vit, 2),
		Crit:    min(6000, 500+base.Agi*40),
		CritDmg: 15000 + base.Agi*50,
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
	derived.CDR = max(0, min(config.MaxCDR, gear.CDR))
	var atkPct, defPct, speedPct config.BasisPoints
	for _, buff := range buffs {
		if buff.Cfg == nil {
			continue
		}
		atkPct += buff.Cfg.AtkPct
		defPct += buff.Cfg.DefPct
		speedPct += buff.Cfg.SpeedPct
	}
	derived.Atk = scale(derived.Atk, atkPct)
	derived.MAtk = scale(derived.MAtk, atkPct)
	derived.Def = scale(derived.Def, defPct)
	derived.MDef = scale(derived.MDef, defPct)
	derived.Speed = scale(derived.Speed, speedPct)
	return derived
}

// scale 返回 ⌊value × (10000 + percent) / 10000⌋，倍率最低为 0（减速减到头就是站住不动）。
func scale(value int, percent config.BasisPoints) int {
	return config.ScaleBasisPoints(value, max(0, config.OneHundredPercent+percent))
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
	if entity.Attr.MaxHP != old {
		entity.MarkDirty(core.DirtyMaxHP)
	}
	if old > 0 && entity.Attr.MaxHP != old {
		entity.SetHP(config.FloorDiv(entity.HP*entity.Attr.MaxHP, old))
	}
	entity.SetHP(max(0, min(entity.HP, entity.Attr.MaxHP)))
}

// Init 从零开始设置 entity 的属性，并将 HP 补满。
func Init(entity *core.Entity) {
	Recalc(entity)
	entity.SetHP(entity.Attr.MaxHP)
}

// ExpToNext 为从 level 升到 level+1 所需的经验：100*level。
func ExpToNext(level int) int { return 100 * level }

// System 负责发放经验并让实体升级。
type System struct {
	state *core.State
}

// New 创建属性系统。
func New(state *core.State) *System { return &System{state: state} }

// LevelUp 使 entity 升一级：基础属性按 entity.Growth 从 1 级的属性重新算（见 config.Attrs.Grown）。
func LevelUp(entity *core.Entity) {
	entity.SetLevel(entity.Level + 1)
	entity.Base = entity.Born.Grown(entity.Growth, entity.Level-1)
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
