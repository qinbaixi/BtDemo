// Package core 保存所有游戏系统共享的数据：实体及其组件、实体表、时钟和事件队列。
// 它不包含任何游戏规则，游戏规则位于其旁边的各个系统包中。
package core

import (
	"math"

	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// Kind 是实体的类型。
type Kind string

const (
	KindPlayer  Kind = "player"
	KindMonster Kind = "monster"
	KindNPC     Kind = "npc"
)

// Entity 是玩家、怪物或 NPC。其字段按职责分组为组件，每类职责一个组件；
// 组件以内嵌方式引入，因此可以直接写 entity.X、entity.HP，不用写 entity.Transform.X。
type Entity struct {
	Identity
	Transform
	Stats
	Combat
	Life
	Control
	Steering
	Brain
}

// Identity 描述实体是什么，以及客户端如何绘制它。
type Identity struct {
	ID      int
	Kind    Kind
	Name    string
	Faction string
	Color   string
	Model   string           // 客户端外观，例如 knight、slime
	Tmpl    *config.Template // 玩家为 nil
}

// Transform 描述实体所在的位置（由 move 和 aoi 管理）。
type Transform struct {
	X, Y         float64
	HomeX, HomeY float64
	Radius       float64
}

// Stats 包括等级、属性和生命值（由 attr 管理）。
type Stats struct {
	Level  int
	Exp    int
	Base   config.Attrs // 基础属性，包含等级成长
	Growth config.Attrs // 每次升级时加到 Base 上
	Speed  float64      // Buff 生效前的基础移动速度
	Attr   Derived
	HP     float64
}

// Derived 是根据基础属性、等级和 Buff 计算得出的属性。
type Derived struct {
	MaxHP   float64
	Atk     float64 // 物理攻击
	MAtk    float64 // 法术攻击
	Def     float64 // 物理防御
	MDef    float64 // 法术防御
	Crit    float64 // 暴击率 0..1
	CritDmg float64 // 暴击倍率
	Speed   float64 // 每秒像素数
}

// Combat 包含实体的技能、Buff，以及它与谁战斗（由 combat 管理）。
type Combat struct {
	Skills    []*config.Skill
	Cooldowns map[string]float64 // 技能 ID -> 再次可用的时间
	Buffs     []*Buff

	Target       int     // 实体 ID，0 表示无
	LastAttacker int     // 最近一次攻击者的实体 ID
	LastHitAt    float64 // 最近一次受击的时间
}

// Buff 是一个生效中的限时修饰效果。
type Buff struct {
	Cfg    *config.Buff
	Until  float64
	Absorb float64 // 护盾还能吸收的伤害（Cfg.ShieldPct > 0 时）
}

// Life 表示实体是否死亡，以及何时重生（由 spawn 管理）。
type Life struct {
	Dead      bool
	RespawnAt float64
}

// Control 是玩家的输入（由 session 管理，由 move 读取）。
type Control struct {
	MoveX, MoveY float64 // 输入方向，已归一化或为零
	Blocking     bool    // 按住右键格挡
}

// Steering 是怪物或 NPC 正在行走的路线（由 move 管理）。
type Steering struct {
	Path     []nav.Vec // 尚未经过的路径点
	Goal     nav.Vec   // 规划路径时所指向的目标位置
	Reaches  bool      // 路径是否终止于目标（false：停在最近的可达位置）
	Planned  bool
	RepathAt float64 // 即使目标没有移动，也在此时间重新规划路径
	StuckFor float64 // 沿路径行走时几乎没有移动的秒数
}

// Brain 是怪物或 NPC 的行为树（由 ai 管理）。
type Brain struct {
	AI      *bt.Instance // 玩家为 nil
	Action  string       // 实体当前正在做的事，用于显示
	AITicks []*pb.AiTick // 被观察期间，自上次同步以来记录的追踪 tick
}

// MaxRadius 为判断边缘距离的范围查询设定实体半径的上限。
const MaxRadius = 64

// Alive 报告 entity 是否可以行动并且可以被选为目标。
func (entity *Entity) Alive() bool { return entity != nil && !entity.Dead }

// Dist 是 a 与 b 中心之间的距离。
func Dist(a, b *Entity) float64 { return math.Hypot(a.X-b.X, a.Y-b.Y) }

// EdgeDist 是 a 与 b 边缘之间的距离（不会为负数）。
func EdgeDist(a, b *Entity) float64 { return math.Max(0, Dist(a, b)-a.Radius-b.Radius) }

// HomeDist 是 entity 与其家之间的距离。
func (entity *Entity) HomeDist() float64 {
	return math.Hypot(entity.X-entity.HomeX, entity.Y-entity.HomeY)
}

// HPRatio 为 HP / MaxHP。
func (entity *Entity) HPRatio() float64 {
	if entity.Attr.MaxHP <= 0 {
		return 0
	}
	return entity.HP / entity.Attr.MaxHP
}

// Shield 是 entity 身上所有护盾还能吸收的伤害之和。
func (entity *Entity) Shield() float64 {
	sum := 0.0
	for _, buff := range entity.Buffs {
		sum += buff.Absorb
	}
	return sum
}
