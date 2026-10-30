// Package item 负责玩家的物品：背包、穿脱装备、换皮肤、换职业时卸下用不了的装备、新手装备和怪物掉落。
// 装备的属性加成由 attr.Recalc 计算，装备特效在战斗里的效果由 combat 处理（combat/effects.go）。
package item

import (
	"slices"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/attr"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 操作被拒绝的原因和其他提示（以 Toast 发给玩家）。
const (
	ReasonNotInBag   = "这件装备不在背包里"
	ReasonWrongClass = "当前职业用不了这件装备"
	ReasonBadSlot    = "没有这个装备槽位"
	ReasonSlotEmpty  = "这个槽位没有装备"
	ReasonBagFull    = "背包满了"
	ReasonBadSkin    = "当前职业没有这个皮肤"
	ReasonLockedSkin = "这个皮肤还没解锁"
	// NoticeStarterLost 后面接物品名：职业新手装备背包放不下，没发
	NoticeStarterLost = "背包满了，没能领到"
	// NoticeDropped 后面接物品名：换职业时卸下的装备背包放不下，被丢掉了
	NoticeDropped = "背包满了，丢掉了"
)

// System 管理玩家的物品。
type System struct {
	state *core.State
}

// New 创建物品系统。
func New(state *core.State) *System { return &System{state: state} }

// Capacity 是背包格数（装备着的物品不占格子）。
func (sys *System) Capacity() int { return sys.state.Cfg.World.Player.Bag }

// BagFull 报告 entity 的背包是不是满了。
func (sys *System) BagFull(entity *core.Entity) bool {
	return entity.BagCount() >= sys.Capacity()
}

// Give 把一件 item 放进 entity 的背包，背包满了返回 false，什么都不改。
func (sys *System) Give(entity *core.Entity, item *config.Item) bool {
	if sys.BagFull(entity) {
		return false
	}
	entity.NextUID++
	entity.Items = append(entity.Items, &core.OwnedItem{UID: entity.NextUID, Cfg: item})
	entity.InventoryDirty = true
	return true
}

// GiveStarter 给刚进游戏的玩家发新手装备：所有人都有的 player.starter，加上当前职业的 starter。
// 都放在背包里，不装备。
func (sys *System) GiveStarter(entity *core.Entity) {
	player := sys.state.Cfg.World.Player
	for _, id := range player.Starter {
		sys.Give(entity, sys.state.Cfg.Item(id))
	}
	if class := player.Class(entity.Class); class != nil {
		sys.giveClassStarter(entity, class)
	}
	entity.InventoryDirty = true // 背包是空的也要发一份 Inventory
}

// giveClassStarter 发职业 class 的新手装备，每个职业只发一次。背包放不下的就不发了，并提示玩家。
func (sys *System) giveClassStarter(entity *core.Entity, class *config.Class) {
	if entity.StartersGiven == nil {
		entity.StartersGiven = map[string]bool{}
	}
	if entity.StartersGiven[class.ID] {
		return
	}
	entity.StartersGiven[class.ID] = true
	for _, id := range class.Starter {
		item := sys.state.Cfg.Item(id)
		if !sys.Give(entity, item) {
			entity.Notices = append(entity.Notices, NoticeStarterLost+"「"+item.Name+"」")
		}
	}
}

// Equip 把背包里 UID 为 uid 的物品装上，原来那个槽位里的物品回到背包。任何时候都可以换（包括死亡期间）。
// 物品不在背包里、或者当前职业用不了时返回给玩家看的原因，什么都不改。
func (sys *System) Equip(entity *core.Entity, uid int) string {
	owned := entity.Owned(uid)
	if owned == nil || owned.Slot != "" {
		return ReasonNotInBag
	}
	if !owned.Cfg.UsableBy(entity.Class) {
		return ReasonWrongClass
	}
	oldLook := entity.GearLook()
	slot := owned.Cfg.Slot
	if previous := entity.Equipped(slot); previous != nil {
		previous.Slot = "" // 换下来的回到背包，刚好占装上的那件空出来的格子
	}
	owned.Slot = slot
	sys.changed(entity, oldLook)
	return ""
}

// Unequip 把槽位 slot 里的物品卸回背包；槽位不对、没有装备、背包满了时返回原因。
func (sys *System) Unequip(entity *core.Entity, slot string) string {
	if !slices.Contains(config.ItemSlots, slot) {
		return ReasonBadSlot
	}
	owned := entity.Equipped(slot)
	if owned == nil {
		return ReasonSlotEmpty
	}
	if sys.BagFull(entity) {
		return ReasonBagFull
	}
	oldLook := entity.GearLook()
	owned.Slot = ""
	sys.changed(entity, oldLook)
	return ""
}

// changed 在装备变化后重算属性（血量按比例保留），标记要发 Inventory；武器外观变了还要重发 Enter。
func (sys *System) changed(entity *core.Entity, oldLook string) {
	attr.Recalc(entity)
	entity.InventoryDirty = true
	if entity.GearLook() != oldLook {
		entity.LookDirty = true
	}
}

// SetSkin 换成当前职业的皮肤 skinID（空 = 默认皮肤），任何时候都可以换。
// 不是当前职业的皮肤时返回原因。
func (sys *System) SetSkin(entity *core.Entity, skinID string) string {
	class := sys.state.Cfg.World.Player.Class(entity.Class)
	if class == nil {
		return ReasonBadSkin
	}
	if skinID == "" {
		skinID = class.DefaultSkin()
	} else if skin := class.Skin(skinID); skin == nil {
		return ReasonBadSkin
	} else if config.SkinLocked(skin, entity.UnlockedSkins) {
		return ReasonLockedSkin
	}
	if entity.Skin != skinID {
		entity.Skin = skinID
		entity.LookDirty = true
	}
	return ""
}

// ClassChanged 在玩家换成职业 class 之后（spawn.ApplyClass 已经换了皮肤和属性）调用：
// 新职业用不了的已装备物品卸回背包，背包满了就丢掉并提示；第一次当这个职业时发它的新手装备。
func (sys *System) ClassChanged(entity *core.Entity, class *config.Class) {
	oldLook := entity.GearLook()
	removed := false
	kept := entity.Items[:0]
	for _, owned := range entity.Items {
		if owned.Slot != "" && !owned.Cfg.UsableBy(class.ID) {
			if sys.BagFull(entity) {
				entity.Notices = append(entity.Notices, NoticeDropped+"「"+owned.Cfg.Name+"」")
				removed = true
				continue
			}
			owned.Slot = ""
			removed = true
		}
		kept = append(kept, owned)
	}
	clear(entity.Items[len(kept):])
	entity.Items = kept
	sys.giveClassStarter(entity, class)
	if removed {
		sys.changed(entity, oldLook)
	}
	entity.InventoryDirty = true
}

// Loot 在怪物 monster 被玩家 killer 打死时调用：按 world.yaml 的 loot 配置掷骰子，
// 掉落的物品直接进击杀者的背包，并发 LOOT 事件（src = 怪物，dst = 玩家，item = 物品 id）；
// 背包满了只提示，不给。
func (sys *System) Loot(monster, killer *core.Entity) {
	loot := &sys.state.Cfg.World.Loot
	if monster.Tmpl == nil || len(sys.state.Cfg.Items) == 0 {
		return
	}
	if !sys.state.Lucky(loot.ChanceFor(monster.Tmpl.ID)) {
		return
	}
	item := sys.roll(killer.Class)
	if item == nil {
		return
	}
	if !sys.Give(killer, item) {
		killer.Notices = append(killer.Notices, ReasonBagFull)
		return
	}
	sys.state.Events.Emit(
		monster,
		&core.Event{
			Kind: pb.EventKind_LOOT.Enum(),
			Src:  core.I32(monster.ID),
			Dst:  core.I32(killer.ID),
			Item: &item.ID,
		},
	)
}

// Reward 给玩家 player 一件装备（副本房间的奖励）：和怪物掉落一样抽，但一定给；背包满了只提示。
// 发 LOOT 事件（src = dst = 玩家），返回给出的物品，没给返回 nil。
func (sys *System) Reward(player *core.Entity) *config.Item {
	item := sys.roll(player.Class)
	if item == nil {
		return nil
	}
	if !sys.Give(player, item) {
		player.Notices = append(player.Notices, ReasonBagFull)
		return nil
	}
	sys.state.Events.Emit(
		player,
		&core.Event{
			Kind: pb.EventKind_LOOT.Enum(),
			Src:  core.I32(player.ID),
			Dst:  core.I32(player.ID),
			Item: &item.ID,
		},
	)
	return item
}

// roll 抽一件掉落的物品：ClassBias 的概率只从 classID 能用的物品里抽，否则从所有物品里抽；
// 先按稀有度权重抽稀有度（只算候选里有的稀有度），再在这个稀有度里等概率抽一件。
func (sys *System) roll(classID string) *config.Item {
	loot := &sys.state.Cfg.World.Loot
	candidates := sys.state.Cfg.Items
	if sys.state.Lucky(loot.ClassBias) {
		candidates = nil
		for _, item := range sys.state.Cfg.Items {
			if item.UsableBy(classID) {
				candidates = append(candidates, item)
			}
		}
	}
	byRarity := map[string][]*config.Item{}
	totalWeight := 0
	for _, item := range candidates {
		if len(byRarity[item.Rarity]) == 0 {
			totalWeight += loot.Rarity[item.Rarity]
		}
		byRarity[item.Rarity] = append(byRarity[item.Rarity], item)
	}
	if totalWeight <= 0 {
		return nil
	}
	// 按 config.Rarities 的固定顺序累加权重，结果不依赖 map 的遍历顺序
	pick := sys.state.Luck.Intn(totalWeight) // 0..totalWeight-1 的整数
	var chosen []*config.Item
	for _, rarity := range config.Rarities {
		pool := byRarity[rarity]
		weight := loot.Rarity[rarity]
		if len(pool) == 0 || weight <= 0 {
			continue
		}
		chosen = pool
		if pick < weight {
			break
		}
		pick -= weight
	}
	return chosen[sys.state.Luck.Intn(len(chosen))]
}
