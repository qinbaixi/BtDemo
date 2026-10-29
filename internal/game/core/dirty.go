package core

import "github.com/qinbaixi/BtDemo/internal/config"

// Dirty 是实体自上次同步以来变了的、要同步给客户端的字段（pb.EntityState 的字段），每个字段一位。
// 改这些字段时用下面的 setter（或者改完调 MarkDirty），session 每个同步帧只把变了的字段
// 按实体所在位置推给附近的玩家，然后清零。
//
// 加一个要同步的字段：在这里加一位，在 session.entityDelta 里按这一位填 pb.EntityState。
type Dirty uint64

const (
	DirtyPos      Dirty = 1 << iota // X, Y
	DirtyHP                         // HP
	DirtyMaxHP                      // Attr.MaxHP
	DirtyLevel                      // Level
	DirtyAction                     // Action（行为树当前在做的事）
	DirtyTarget                     // Target
	DirtyDead                       // Dead
	DirtyShield                     // Shield()（护盾 Buff 的 Absorb 之和）
	DirtyBlocking                   // Blocking
	DirtyLooks                      // Looks()（Buff 外观位集合）
	DirtyGuard                      // GuardSpent（按 GuardStep 取整后变了才算）

	DirtyAll Dirty = 1<<iota - 1 // 全部字段（实体进入视野时发全量用）
)

// Sync 记录实体要同步给客户端的变化（由 session 读取并清零）。
type Sync struct {
	Dirty Dirty
}

// MarkDirty 记下 bits 这些字段变了。
func (entity *Entity) MarkDirty(bits Dirty) { entity.Dirty |= bits }

// SetPos 移动实体（不处理碰撞和 AOI 格子，那是 move 和 aoi 的事）。
// 坐标按整数像素下发，所以只有向下取整后的整数变了才标脏（亚像素的挪动不发包）。
func (entity *Entity) SetPos(x, y float64) {
	if Floor(entity.X) != Floor(x) || Floor(entity.Y) != Floor(y) {
		entity.Dirty |= DirtyPos
	}
	entity.X, entity.Y = x, y
}

// SetHP 设置生命值。
func (entity *Entity) SetHP(hp int) {
	if entity.HP != hp {
		entity.HP = hp
		entity.Dirty |= DirtyHP
	}
}

// SetLevel 设置等级。
func (entity *Entity) SetLevel(level int) {
	if entity.Level != level {
		entity.Level = level
		entity.Dirty |= DirtyLevel
	}
}

// SetAction 设置实体当前在做的事（显示用）。
func (entity *Entity) SetAction(action string) {
	if entity.Action != action {
		entity.Action = action
		entity.Dirty |= DirtyAction
	}
}

// SetTarget 设置当前目标（实体 ID，0 表示无）。
func (entity *Entity) SetTarget(id int) {
	if entity.Target != id {
		entity.Target = id
		entity.Dirty |= DirtyTarget
	}
}

// SetDead 设置是否死亡。
func (entity *Entity) SetDead(dead bool) {
	if entity.Dead != dead {
		entity.Dead = dead
		entity.Dirty |= DirtyDead
	}
}

// GuardStep 是架势同步的精度（万分比）：架势回复是连续的，每变化这么多才发一次。
const GuardStep config.BasisPoints = 500

// SetGuardSpent 设置扣掉的架势（万分比，夹在 0..10000），取整后的值变了才标脏。
func (entity *Entity) SetGuardSpent(spent config.BasisPoints) {
	spent = max(0, min(config.OneHundredPercent, spent))
	if GuardShown(spent) != GuardShown(entity.GuardSpent) {
		entity.Dirty |= DirtyGuard
	}
	entity.GuardSpent = spent
}

// GuardShown 是发给客户端的剩余架势（万分比 0..10000，按 GuardStep 向下取整；扣了一点点也不显示满）。
func GuardShown(spent config.BasisPoints) config.BasisPoints {
	if spent <= 0 {
		return config.OneHundredPercent
	}
	return (config.OneHundredPercent - spent) / GuardStep * GuardStep
}

// SetBlocking 设置是否举盾格挡。
func (entity *Entity) SetBlocking(on bool) {
	if entity.Blocking != on {
		entity.Blocking = on
		entity.Dirty |= DirtyBlocking
	}
}
