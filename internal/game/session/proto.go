package session

import (
	"slices"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/attr"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

var kindToPB = map[core.Kind]pb.EntityKind{
	core.KindPlayer:  pb.EntityKind_PLAYER,
	core.KindMonster: pb.EntityKind_MONSTER,
	core.KindNPC:     pb.EntityKind_NPC,
	core.KindPet:     pb.EntityKind_PET,
}

// entityInfo 是实体进入视野（或外观变了）时客户端获知的信息，带全部状态。
func entityInfo(entity *core.Entity) *pb.EntityInfo {
	return &pb.EntityInfo{
		Id:    core.I32(entity.ID),
		Kind:  kindToPB[entity.Kind].Enum(),
		Name:  proto.String(entity.Name),
		Color: proto.String(entity.Color),
		R:     core.FloorI32(entity.Radius),
		State: entityDelta(entity, core.DirtyAll),
		Model: proto.String(entity.Model),
		Skin:  proto.String(entity.Skin),
		Gear:  proto.String(entity.GearLook()),
		Owner: core.I32(entity.Owner),
	}
}

// entityDelta 是实体的状态里 dirty 这些位对应的字段（其余字段不设置，客户端保持原值）。
// 加同步字段时，在 core.Dirty 加一位，在这里加一个分支。
func entityDelta(entity *core.Entity, dirty core.Dirty) *pb.EntityState {
	delta := &pb.EntityState{Id: core.I32(entity.ID)}
	if dirty&core.DirtyPos != 0 {
		delta.X = core.FloorI32(entity.X)
		delta.Y = core.FloorI32(entity.Y)
	}
	if dirty&core.DirtyHP != 0 {
		delta.Hp = core.I32(entity.HP)
	}
	if dirty&core.DirtyMaxHP != 0 {
		delta.MaxHp = core.I32(entity.Attr.MaxHP)
	}
	if dirty&core.DirtyLevel != 0 {
		delta.Lv = core.I32(entity.Level)
	}
	if dirty&core.DirtyAction != 0 {
		delta.Act = proto.String(entity.Action)
	}
	if dirty&core.DirtyTarget != 0 {
		delta.Tg = core.I32(entity.Target)
	}
	if dirty&core.DirtyDead != 0 {
		delta.Dead = proto.Bool(entity.Dead)
	}
	if dirty&core.DirtyShield != 0 {
		delta.Shield = core.I32(entity.Shield())
	}
	if dirty&core.DirtyBlocking != 0 {
		delta.Blocking = proto.Bool(entity.Blocking)
	}
	if dirty&core.DirtyLooks != 0 {
		delta.Looks = core.I32(int(entity.Looks()))
	}
	// 玩家和配了架势（guard）的怪会格挡，其余的不发架势
	if dirty&core.DirtyGuard != 0 && (entity.Kind == core.KindPlayer || entity.Tmpl != nil && entity.Tmpl.Guard > 0) {
		delta.Guard = core.I32(core.GuardShown(entity.GuardSpent))
	}
	return delta
}

// skillInfo 是一个技能在技能栏（slot 从 1 起）或技能池（slot 为 0）里的样子。
func skillInfo(slot int, skill *config.Skill) *pb.SkillInfo {
	radius := skill.Radius
	if skill.Zone != nil {
		radius = skill.Zone.Radius // 放回血区的技能：悬停时显示区域多大
	}
	info := &pb.SkillInfo{
		Slot:     core.I32(slot),
		Id:       proto.String(skill.ID),
		Name:     proto.String(skill.Name),
		Kind:     proto.String(skill.Kind),
		Range:    core.I32(skill.Range),
		Radius:   core.I32(radius),
		Cooldown: core.I32(int(skill.Cooldown)),
		Color:    proto.String(skill.Color),
		Fx:       proto.String(skill.FX),
		Desc:     proto.String(skill.Desc),
	}
	if skill.Kind == "dash" || skill.Kind == "rain" {
		info.Distance = core.I32(skill.Distance) // 位移距离 / 箭雨没有目标时的落点距离
	}
	return info
}

// skillPool 是职业 class 可以挑的技能（slot 为 0）。
func skillPool(cfg *config.Config, class *config.Class) []*pb.SkillInfo {
	pool := make([]*pb.SkillInfo, 0, len(class.SkillPool))
	for _, id := range class.SkillPool {
		pool = append(pool, skillInfo(0, cfg.Skills[id]))
	}
	return pool
}

// classInfo 是选职业时客户端看到的职业：默认技能栏、技能池、要挑几个、能不能格挡。
func classInfo(cfg *config.Config, class *config.Class) *pb.ClassInfo {
	defaults := make([]*config.Skill, 0, len(class.Skills))
	for _, id := range class.Skills {
		defaults = append(defaults, cfg.Skills[id])
	}
	return &pb.ClassInfo{
		Id:       proto.String(class.ID),
		Name:     proto.String(class.Name),
		Desc:     proto.String(class.Desc),
		Model:    proto.String(class.Model),
		Color:    proto.String(class.Color),
		Skills:   skillBar(defaults),
		Pool:     skillPool(cfg, class),
		Pick:     core.I32(class.Pick()),
		CanBlock: proto.Bool(class.CanBlock),
		Skins:    skinInfos(class.Skins),
	}
}

// skinInfos 是职业的皮肤列表（第一个是默认）。
func skinInfos(skins []*config.Skin) []*pb.SkinInfo {
	infos := make([]*pb.SkinInfo, 0, len(skins))
	for _, skin := range skins {
		infos = append(infos, &pb.SkinInfo{
			Id:     proto.String(skin.ID),
			Name:   proto.String(skin.Name),
			Desc:   proto.String(skin.Desc),
			Color:  proto.String(skin.Color),
			Unlock: proto.String(skin.Unlock),
		})
	}
	return infos
}

// itemInfos 是装备图鉴：每件物品的定义，属性按 config.StatNames 的顺序，只列不为 0 的。
func itemInfos(items []*config.Item) []*pb.ItemInfo {
	infos := make([]*pb.ItemInfo, 0, len(items))
	for _, item := range items {
		info := &pb.ItemInfo{
			Id:     proto.String(item.ID),
			Name:   proto.String(item.Name),
			Slot:   proto.String(item.Slot),
			Class:  proto.String(item.Class),
			Rarity: proto.String(item.Rarity),
			Desc:   proto.String(item.Desc),
			Look:   proto.String(item.Look),
		}
		for _, stat := range config.StatNames {
			if value := item.Stats[stat]; value != 0 {
				info.Stats = append(info.Stats, &pb.ItemStat{
					Stat:  proto.String(stat),
					Value: proto.Int32(int32(value)), // crit、crit_dmg、cdr 是万分比
				})
			}
		}
		if item.Effect != nil {
			info.Effect = proto.String(item.Effect.Kind)
		}
		infos = append(infos, info)
	}
	return infos
}

// inventoryInfo 是玩家完整的背包和装备，按 UID 排好；capacity 是背包格数。
func inventoryInfo(entity *core.Entity, capacity int) *pb.Inventory {
	inventory := &pb.Inventory{Capacity: core.I32(capacity)}
	for _, owned := range entity.Items {
		inventory.Items = append(inventory.Items, &pb.ItemSlotted{
			Uid:  core.I32(owned.UID),
			Id:   proto.String(owned.Cfg.ID),
			Slot: proto.String(owned.Slot),
		})
	}
	return inventory
}

// skillBar 是按格子排好的技能栏。
func skillBar(skills []*config.Skill) []*pb.SkillInfo {
	bar := make([]*pb.SkillInfo, 0, len(skills))
	for i, skill := range skills {
		bar = append(bar, skillInfo(i+1, skill))
	}
	return bar
}

// selfInfo 是玩家自身的属性、冷却和增益效果（全部字段）。时间都是到期的时间点（Frame.time 的时钟），
// 不是剩余毫秒数，这样它们只在施法、加 Buff 时变一次，不会每帧都变。
func selfInfo(entity *core.Entity, now config.Millis) *pb.SelfInfo {
	self := &pb.SelfInfo{
		Lv:   core.I32(entity.Level),
		Exp:  core.I32(entity.Exp),
		Next: core.I32(attr.ExpToNext(entity.Level)),
		Hp:   core.I32(entity.HP),
		Base: &pb.Attrs{
			Str: core.I32(entity.Base.Str),
			Agi: core.I32(entity.Base.Agi),
			Int: core.I32(entity.Base.Int),
			Vit: core.I32(entity.Base.Vit),
		},
		Attr: &pb.Derived{
			MaxHp:   core.I32(entity.Attr.MaxHP),
			Atk:     core.I32(entity.Attr.Atk),
			Matk:    core.I32(entity.Attr.MAtk),
			Def:     core.I32(entity.Attr.Def),
			Mdef:    core.I32(entity.Attr.MDef),
			Crit:    core.I32(entity.Attr.Crit),
			CritDmg: core.I32(entity.Attr.CritDmg),
			Speed:   core.I32(entity.Attr.Speed),
		},
		Dead:     proto.Bool(entity.Dead),
		CdsSet:   proto.Bool(true),
		BuffsSet: proto.Bool(true),
		Skins:    entity.UnlockedSkins,
		SkinsSet: proto.Bool(true),
	}
	if entity.Dead {
		self.RespawnAt = core.I64(entity.RespawnAt)
	} else {
		self.RespawnAt = core.I64(0)
	}
	for _, skill := range entity.Skills {
		if readyAt := entity.Cooldowns[skill.ID]; readyAt > now {
			self.Cds = append(self.Cds, &pb.SkillCooldown{
				Skill:   proto.String(skill.ID),
				ReadyAt: core.I64(readyAt),
			})
		}
	}
	for _, buff := range entity.Buffs {
		self.Buffs = append(self.Buffs, &pb.BuffInfo{
			Name:  proto.String(buff.Cfg.Name),
			Until: core.I64(buff.Until),
		})
	}
	return self
}

// selfDelta 返回 current 相对上次发出的 previous 变了的部分；没变返回 nil。previous 为 nil 时返回全部。
// base / attr 变了就整个发；cds / buffs 变了就整个列表发并设 *_set。
func selfDelta(previous, current *pb.SelfInfo) *pb.SelfInfo {
	if previous == nil {
		return current
	}
	delta := &pb.SelfInfo{}
	changed := false
	if previous.GetLv() != current.GetLv() {
		delta.Lv, changed = current.Lv, true
	}
	if previous.GetExp() != current.GetExp() {
		delta.Exp, changed = current.Exp, true
	}
	if previous.GetNext() != current.GetNext() {
		delta.Next, changed = current.Next, true
	}
	if previous.GetHp() != current.GetHp() {
		delta.Hp, changed = current.Hp, true
	}
	if previous.GetDead() != current.GetDead() {
		delta.Dead, changed = current.Dead, true
	}
	if previous.GetRespawnAt() != current.GetRespawnAt() {
		delta.RespawnAt, changed = current.RespawnAt, true
	}
	if !proto.Equal(previous.Base, current.Base) {
		delta.Base, changed = current.Base, true
	}
	if !proto.Equal(previous.Attr, current.Attr) {
		delta.Attr, changed = current.Attr, true
	}
	if !sameList(previous.Cds, current.Cds) {
		delta.Cds, delta.CdsSet, changed = current.Cds, proto.Bool(true), true
	}
	if !sameList(previous.Buffs, current.Buffs) {
		delta.Buffs, delta.BuffsSet, changed = current.Buffs, proto.Bool(true), true
	}
	if !slices.Equal(previous.Skins, current.Skins) {
		delta.Skins, delta.SkinsSet, changed = current.Skins, proto.Bool(true), true
	}
	if !changed {
		return nil
	}
	return delta
}

// sameList 报告两个消息列表是否逐项相等。
func sameList[Message proto.Message](previous, current []Message) bool {
	if len(previous) != len(current) {
		return false
	}
	for index := range previous {
		if !proto.Equal(previous[index], current[index]) {
			return false
		}
	}
	return true
}

// obstacles 是欢迎消息中包含的障碍物形状（调试显示用；物件本身前端从 /map.tmj 读）。
func obstacles(navMap *nav.Map) []*pb.Obstacle {
	shapes := navMap.Shapes()
	obs := make([]*pb.Obstacle, 0, len(shapes))
	for _, shape := range shapes {
		obstacle := &pb.Obstacle{
			Shape: pb.ObstacleShape(shape.Kind).Enum(),
			Ax:    core.FloorI32(shape.A.X),
			Ay:    core.FloorI32(shape.A.Y),
		}
		switch shape.Kind {
		case nav.Rect:
			obstacle.Bx, obstacle.By = core.FloorI32(shape.B.X), core.FloorI32(shape.B.Y)
		case nav.Capsule:
			obstacle.Bx, obstacle.By = core.FloorI32(shape.B.X), core.FloorI32(shape.B.Y)
			obstacle.R = core.FloorI32(shape.Radius)
		default:
			obstacle.R = core.FloorI32(shape.Radius)
		}
		obs = append(obs, obstacle)
	}
	return obs
}

// zoneInfos 是发给客户端的回血区列表。
func zoneInfos(zones []*core.Zone) []*pb.Zone {
	infos := make([]*pb.Zone, 0, len(zones))
	for _, zone := range zones {
		infos = append(infos, &pb.Zone{
			Id:       core.I32(zone.ID),
			X:        core.FloorI32(zone.X),
			Y:        core.FloorI32(zone.Y),
			Radius:   core.I32(zone.Cfg.Radius),
			Name:     proto.String(zone.Cfg.Name),
			Color:    proto.String(zone.Cfg.Color),
			Look:     proto.String(zone.Cfg.Look),
			Owner:    core.I32(zone.Owner),
			Until:    core.I64(zone.Until),
			Dur:      core.I32(int(zone.Cfg.Duration)),
			Interval: core.I32(int(zone.Cfg.Interval)),
			Heal:     core.I32(zone.Cfg.Heal),
		})
	}
	return infos
}

// levelState 是发给客户端的副本进度。
func levelState(level *core.Level) *pb.LevelState {
	state := &pb.LevelState{}
	for _, room := range level.Rooms {
		state.Rooms = append(state.Rooms, &pb.RoomState{
			Id:    proto.String(room.ID),
			Phase: pb.RoomPhase(room.Phase).Enum(),
			Wave:  core.I32(room.Wave),
		})
	}
	for _, gate := range level.Gates {
		if gate.Open {
			state.Open = append(state.Open, gate.ID)
		}
	}
	state.Keys = append(state.Keys, level.Keys...)
	return state
}

// petInfos 是宠物图鉴：每种宠物的名字、说明和外观，按 pets.yaml 的顺序（第一个是默认）。
func petInfos(pets []*config.Pet) []*pb.PetInfo {
	infos := make([]*pb.PetInfo, 0, len(pets))
	for _, pet := range pets {
		infos = append(infos, &pb.PetInfo{
			Id:    proto.String(pet.ID),
			Name:  proto.String(pet.Name),
			Desc:  proto.String(pet.Desc),
			Color: proto.String(pet.Color),
			Model: proto.String(pet.Model),
		})
	}
	return infos
}

// petStatus 是玩家 owner 的宠物现在的状态：选了哪只、实体 id、复活倒计时、换宠物冷却。
func petStatus(state *core.State, owner *core.Entity) *pb.PetStatus {
	now := state.Now()
	status := &pb.PetStatus{
		Pet:      proto.String(owner.PetID),
		Entity:   core.I32(owner.PetEntity),
		Cooldown: core.I32(int(max(0, owner.PetSwapAt-now))),
	}
	var respawnIn config.Millis
	if pet := state.Ents.Get(owner.PetEntity); pet != nil && pet.Dead {
		respawnIn = max(0, pet.RespawnAt-now)
	}
	status.RespawnIn = core.I32(int(respawnIn))
	return status
}
