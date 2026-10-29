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
	KindPet     Kind = "pet"
)

// 宠物的特效名（CAST 事件的 fx 字段），客户端据此画召唤和传送特效：
// 召唤 / 复活时 (x, y) 是出现的位置；传送时 (x, y) 是出发的位置、(tx, ty) 是到达的位置。
const (
	FXPetSummon   = "pet_summon"
	FXPetTeleport = "pet_teleport"
)

// Entity 是玩家、怪物、NPC 或宠物。其字段按职责分组为组件，每类职责一个组件；
// 组件以内嵌方式引入，因此可以直接写 entity.X、entity.HP，不用写 entity.Transform.X。
type Entity struct {
	Identity
	Transform
	Stats
	Combat
	Impact
	Life
	Control
	Steering
	Brain
	Inventory
	Companion
	Sync
}

// Identity 描述实体是什么，以及客户端如何绘制它。
type Identity struct {
	ID      int
	Kind    Kind
	Name    string
	Faction string
	Color   string
	Model   string           // 客户端外观，例如 knight、slime
	Class   string           // 玩家职业 id（config.Class.ID）；怪物和 NPC 为空
	Skin    string           // 玩家皮肤 id（config.Skin.ID）；怪物和 NPC 为空
	Tmpl    *config.Template // 玩家和宠物为 nil
	// Owner 是宠物的主人（玩家实体）的 ID；其他实体为 0
	Owner int
	// PetCfg 是宠物的模板；其他实体为 nil
	PetCfg *config.Pet
	// LookDirty 为 true 表示皮肤或武器外观变了，session 要让所有能看见它的会话重发 Enter
	LookDirty bool
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
	CDR     float64 // 冷却缩减 0..config.MaxCDR：技能冷却 ×(1-CDR)
}

// Combat 包含实体的技能、Buff，以及它与谁战斗（由 combat 管理）。
type Combat struct {
	Skills    []*config.Skill
	Cooldowns map[string]float64 // 技能 ID -> 再次可用的时间
	Buffs     []*Buff

	Target       int     // 实体 ID，0 表示无
	LastAttacker int     // 最近一次攻击者的实体 ID
	LastHitAt    float64 // 最近一次受击的时间
	LastDealtAt  float64 // 最近一次出手打人（造成伤害，含被免疫的）的时间，0 表示没打过

	// CanPick 为 true 时玩家可以重新挑技能：进游戏或死亡之后、放下一个技能之前（由 session、combat 管理）
	CanPick bool
	// AmbushUntil 之前的下一次伤害必定暴击（ambush 特效，位移技能后设置）
	AmbushUntil float64
}

// Impact 是挨打和出招的过程状态：前摇、击退、硬直、韧性（由 combat 管理，move 和 ai 读取）。
type Impact struct {
	// Windup 是正在前摇的技能；nil 表示没有在前摇
	Windup *Windup
	// Knock 是正在进行的击退位移；nil 表示没有
	Knock *Knock
	// StunUntil 之前处于硬直：不能移动、不能出招，行为树暂停
	StunUntil float64
	// PoiseTaken 是最近被打掉的韧性，PoiseHitAt 是最近一次被打掉的时间（过了 hit.poise_reset 秒清零）
	PoiseTaken float64
	PoiseHitAt float64
	Guard
}

// Guard 是格挡的状态（只有能格挡的玩家用到，由 session 和 combat 管理）。
type Guard struct {
	// BlockFace 是举盾时盾朝着的一侧（-1 左，1 右）；选了目标时盾朝着目标，见 combat 的 blockFacing
	BlockFace float64
	// ParryUntil 之前挡住的近战是完美格挡（举盾那一刻开窗口）
	ParryUntil float64
	// BlockLoweredAt 是上一次放下盾的时间：放下不够久再举起没有完美格挡窗口
	BlockLoweredAt float64
	// GuardSpent 是已经扣掉的架势比例，0 = 满，1 = 扣空（破防）；用 SetGuardSpent 改
	GuardSpent float64
	// GuardHitAt 是最近一次挡住东西的时间，过一会儿架势才开始回复
	GuardHitAt float64
}

// Windup 是一次还没结算的出招：到 HitAt 才判定命中。
type Windup struct {
	Skill  *config.Skill
	Target int // target 技能的目标；aoe 为 0
	HitAt  float64
}

// Knock 是一段击退位移：从 From 在 Start 开始，Duration 秒内缓出地走到 To。
type Knock struct {
	From, To nav.Vec
	Start    float64
	Duration float64
}

// Stunned 报告 entity 在 now 时是否处于硬直。
func (impact *Impact) Stunned(now float64) bool { return now < impact.StunUntil }

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

// Inventory 是玩家的背包和身上的装备（由 item 管理）。怪物和 NPC 没有物品。
type Inventory struct {
	Items   []*OwnedItem // 玩家拥有的所有物品，按 UID 从小到大；Slot 不空的是装备着的
	NextUID int          // 上一个分配出去的 UID
	// StartersGiven 记下已经发过哪些职业的新手装备（config.Class.Starter），每个职业只发一次
	StartersGiven map[string]bool
	// InventoryDirty 为 true 表示背包或装备变了，session 要给玩家发一份完整的 Inventory
	InventoryDirty bool
	// Notices 是要以 Toast 发给玩家的提示（比如背包满了），session 发完后清空
	Notices []string
}

// Companion 是玩家带的宠物的记录（由 pet 管理）。怪物、NPC 和宠物自己这些字段都是空的。
type Companion struct {
	// PetID 是玩家选的宠物（config.Pet.ID）；空 = 不带宠物
	PetID string
	// PetEntity 是宠物实体的 ID；0 = 现在场上没有（收回了，或主人死亡期间）
	PetEntity int
	// PetSwapAt 之前不能再换宠物
	PetSwapAt float64
	// PetDeadSeen 为 true 表示宠物这次死亡已经通知过主人
	PetDeadSeen bool
	// PetDirty 为 true 表示宠物的状态变了（召唤、收回、死亡、复活、换宠物），
	// session 要给玩家发一份 PetStatus
	PetDirty bool
}

// OwnedItem 是玩家拥有的一件物品。
type OwnedItem struct {
	UID  int          // 在这个玩家的物品里唯一
	Cfg  *config.Item // 物品定义
	Slot string       // 装备在哪个槽位；空 = 在背包里
}

// Equipped 返回装备在槽位 slot 里的物品，没有返回 nil。
func (inventory *Inventory) Equipped(slot string) *OwnedItem {
	for _, owned := range inventory.Items {
		if owned.Slot == slot {
			return owned
		}
	}
	return nil
}

// Owned 按 UID 找物品，找不到返回 nil。
func (inventory *Inventory) Owned(uid int) *OwnedItem {
	for _, owned := range inventory.Items {
		if owned.UID == uid {
			return owned
		}
	}
	return nil
}

// BagCount 是背包里（没装备的）物品数量。
func (inventory *Inventory) BagCount() int {
	count := 0
	for _, owned := range inventory.Items {
		if owned.Slot == "" {
			count++
		}
	}
	return count
}

// GearLook 是装备着的武器的外观（config.Item.Look）；没有武器时为空。
func (inventory *Inventory) GearLook() string {
	if weapon := inventory.Equipped("weapon"); weapon != nil {
		return weapon.Cfg.Look
	}
	return ""
}

// Effects 返回装备着的物品里种类为 kind 的特效。
func (inventory *Inventory) Effects(kind string) []*config.ItemEffect {
	var effects []*config.ItemEffect
	for _, owned := range inventory.Items {
		if owned.Slot != "" && owned.Cfg.Effect != nil && owned.Cfg.Effect.Kind == kind {
			effects = append(effects, owned.Cfg.Effect)
		}
	}
	return effects
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

// Invulnerable 报告 entity 身上有没有无敌的 Buff。
func (entity *Entity) Invulnerable() bool {
	for _, buff := range entity.Buffs {
		if buff.Cfg.Invulnerable {
			return true
		}
	}
	return false
}

// Looks 是 entity 身上 Buff 外观的位集合（见 config.Looks），同步给客户端画特效。
func (entity *Entity) Looks() int32 {
	var looks int32
	for _, buff := range entity.Buffs {
		looks |= config.Looks[buff.Cfg.Look]
	}
	return looks
}

// Shield 是 entity 身上所有护盾还能吸收的伤害之和。
func (entity *Entity) Shield() float64 {
	sum := 0.0
	for _, buff := range entity.Buffs {
		sum += buff.Absorb
	}
	return sum
}
