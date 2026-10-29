package game

import (
	"math"
	"math/rand"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/attr"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/item"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// fixedSource 是总是返回同一个数的随机数来源，用来强制特效和掉落触发或不触发。
type fixedSource struct{ value int64 }

func (source fixedSource) Int63() int64 { return source.value }
func (source fixedSource) Seed(int64)   {}

// forceLuck 让 State.Luck 的每次掷骰都成功（lucky 为 true，Float64 总是 0）或都失败（总是 0.99）。
func forceLuck(world *World, lucky bool) {
	value := int64(0)
	if !lucky {
		value = (1 << 63) / 100 * 99
	}
	world.State.Luck = rand.New(fixedSource{value: value})
}

// gearWorld 用随附的配置（职业、技能、物品、掉落）建一个没有刷怪点、没有障碍物的世界，
// 并把新加入的玩家放到远离泉水的 (1500, 400)。
func gearWorld(t *testing.T) *World {
	t.Helper()
	cfg, err := config.Load("../../config", TreeNames())
	if err != nil {
		t.Fatal(err)
	}
	cfg.Spawns = nil
	cfg.World.HealZones = nil
	cfg.World.Map.Width, cfg.World.Map.Height = 2400, 1600 // 比随附的地图大，测试里的坐标都放得下
	world, err := newWorld(cfg, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	return world
}

// joinAt 让一个新玩家加入并放到 (x, y)。
func joinAt(world *World, x, y float64) *Session {
	session := world.Join()
	session.Player.X, session.Player.Y = x, y
	world.Grid.Moved(session.Player)
	return session
}

// giveAndEquip 往玩家背包里放一件 itemID 并通过 Equip 消息装上。
func giveAndEquip(t *testing.T, world *World, session *Session, itemID string) {
	t.Helper()
	player := session.Player
	if !world.Items.Give(player, world.State.Cfg.Item(itemID)) {
		t.Fatalf("bag full giving %s", itemID)
	}
	sendEquip(world, session, player.NextUID)
	if owned := player.Owned(player.NextUID); owned.Slot == "" {
		t.Fatalf("%s not equipped", itemID)
	}
}

func sendEquip(world *World, session *Session, uid int) {
	equip := &pb.Equip{Uid: proto.Int32(int32(uid))}
	world.Input(session, &pb.ClientMsg{Msg: &pb.ClientMsg_Equip{Equip: equip}})
}

func sendUnequip(world *World, session *Session, slot string) {
	unequip := &pb.Unequip{Slot: proto.String(slot)}
	world.Input(session, &pb.ClientMsg{Msg: &pb.ClientMsg_Unequip{Unequip: unequip}})
}

func sendSkin(world *World, session *Session, skin string) {
	setSkin := &pb.SetSkin{Skin: proto.String(skin)}
	world.Input(session, &pb.ClientMsg{Msg: &pb.ClientMsg_Skin{Skin: setSkin}})
}

// ownedID 找玩家拥有的第一件 itemID，找不到返回 nil。
func ownedID(entity *core.Entity, itemID string) *core.OwnedItem {
	for _, owned := range entity.Items {
		if owned.Cfg.ID == itemID {
			return owned
		}
	}
	return nil
}

// toasts 是消息里所有 Toast 的文字。
func toasts(msgs []*pb.ServerMsg) []string {
	var texts []string
	for _, msg := range msgs {
		if toast := msg.GetToast(); toast != nil {
			texts = append(texts, toast.GetText())
		}
	}
	return texts
}

// lastInventory 是消息里最后一份 Inventory，没有返回 nil。
func lastInventory(msgs []*pb.ServerMsg) *pb.Inventory {
	var inventory *pb.Inventory
	for _, msg := range msgs {
		if msg.GetInventory() != nil {
			inventory = msg.GetInventory()
		}
	}
	return inventory
}

// enteredInfo 是消息里实体 id 的最后一份 EntityInfo，没有返回 nil。
func enteredInfo(msgs []*pb.ServerMsg, id int) *pb.EntityInfo {
	var found *pb.EntityInfo
	for _, msg := range msgs {
		for _, info := range msg.GetEnter().GetEnts() {
			if int(info.GetId()) == id {
				found = info
			}
		}
	}
	return found
}

// queuedEvents 是事件队列里种类为 kind、proc 为 proc 的事件。
func queuedEvents(world *World, kind pb.EventKind, proc string) []*pb.Event {
	var events []*pb.Event
	for _, pending := range world.State.Events.List() {
		if pending.Event.GetKind() == kind && pending.Event.GetProc() == proc {
			events = append(events, pending.Event)
		}
	}
	return events
}

// fillBag 往背包里塞皮革护甲，直到满。
func fillBag(world *World, entity *core.Entity) {
	for world.Items.Give(entity, world.State.Cfg.Item("leather_vest")) {
	}
}

func TestJoinSendsCatalogueSkinsAndStarterInventory(t *testing.T) {
	world := gearWorld(t)
	session := world.Join()
	msgs := readMessages(t, session)
	welcome := msgs[0].GetWelcome()
	if len(welcome.Items) != 13 {
		t.Fatalf("%d items in welcome, want 13", len(welcome.Items))
	}
	sword := welcome.Items[0]
	if sword.GetId() != "recruit_sword" || sword.GetLook() != "knight_sword" ||
		len(sword.Stats) != 1 || sword.Stats[0].GetStat() != "atk" || sword.Stats[0].GetValue() != 4 {
		t.Fatalf("sword info = %v", sword)
	}
	for _, class := range welcome.Classes {
		if len(class.Skins) != 3 || class.Skins[0].GetColor() == "" {
			t.Fatalf("class %s skins = %v", class.GetId(), class.Skins)
		}
	}
	if welcome.Classes[0].Skins[0].GetId() != "paladin" || welcome.Classes[1].Skins[0].GetId() != "woodland" {
		t.Fatal("default skins wrong")
	}
	inventory := lastInventory(msgs)
	if inventory == nil || inventory.GetCapacity() != 24 || len(inventory.Items) != 3 {
		t.Fatalf("starter inventory = %v", inventory)
	}
	wantIDs := []string{"leather_vest", "life_charm", "recruit_sword"}
	for i, slotted := range inventory.Items {
		if slotted.GetId() != wantIDs[i] || slotted.GetSlot() != "" || slotted.GetUid() != int32(i+1) {
			t.Fatalf("starter item %d = %v", i, slotted)
		}
	}
	if session.Player.Skin != "paladin" {
		t.Fatalf("skin = %q, want paladin", session.Player.Skin)
	}
}

func TestEquipAndUnequipRules(t *testing.T) {
	world := gearWorld(t)
	session := joinAt(world, 1500, 400)
	observer := joinAt(world, 1520, 400)
	player := session.Player
	world.Sessions.Flush()
	readMessages(t, session)
	readMessages(t, observer)
	atkBefore := player.Attr.Atk

	sword := ownedID(player, "recruit_sword")
	sendEquip(world, session, sword.UID)
	if sword.Slot != "weapon" || player.Attr.Atk != atkBefore+4 || player.GearLook() != "knight_sword" {
		t.Fatalf("equip sword: slot %q atk %v look %q", sword.Slot, player.Attr.Atk, player.GearLook())
	}
	inventory := lastInventory(readMessages(t, session))
	if inventory == nil || inventory.Items[2].GetSlot() != "weapon" {
		t.Fatalf("inventory after equip = %v", inventory)
	}
	// 武器外观变了：所有能看见他的会话下次 Flush 重发 Enter，带上 gear
	world.Sessions.Flush()
	if info := enteredInfo(readMessages(t, observer), player.ID); info == nil || info.GetGear() != "knight_sword" {
		t.Fatalf("observer re-enter = %v", info)
	}

	// 换武器：原来的回到背包
	giveAndEquip(t, world, session, "blood_blade")
	if sword.Slot != "" || player.GearLook() != "blood_blade" || player.Attr.Atk != atkBefore+6 {
		t.Fatalf("swap: sword slot %q, look %q", sword.Slot, player.GearLook())
	}

	// 拒绝：别的职业的、不在背包里的（已装备的也算）、不存在的
	world.Items.Give(player, world.State.Cfg.Item("hunter_bow"))
	sendEquip(world, session, player.NextUID)
	sendEquip(world, session, ownedID(player, "blood_blade").UID)
	sendEquip(world, session, 999)
	sendUnequip(world, session, "boots")
	sendUnequip(world, session, "trinket")
	got := toasts(readMessages(t, session))
	want := []string{
		item.ReasonWrongClass,
		item.ReasonNotInBag,
		item.ReasonNotInBag,
		item.ReasonBadSlot,
		item.ReasonSlotEmpty,
	}
	if len(got) != len(want) {
		t.Fatalf("toasts = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("toast %d = %q, want %q", i, got[i], want[i])
		}
	}

	// 背包满了卸不下来；有空位就能卸
	fillBag(world, player)
	sendUnequip(world, session, "weapon")
	if player.Equipped("weapon") == nil {
		t.Fatal("unequipped into a full bag")
	}
	if got := toasts(readMessages(t, session)); len(got) != 1 || got[0] != item.ReasonBagFull {
		t.Fatalf("toasts = %v", got)
	}
	player.Items = player.Items[:len(player.Items)-1]
	sendUnequip(world, session, "weapon")
	if player.Equipped("weapon") != nil || player.Attr.Atk != atkBefore || player.GearLook() != "" {
		t.Fatal("unequip did not take the weapon off")
	}
	// 死亡期间也能换
	world.Combat.Kill(player, nil)
	sendEquip(world, session, sword.UID)
	if sword.Slot != "weapon" {
		t.Fatal("cannot equip while dead")
	}
}

func TestItemStatsApplied(t *testing.T) {
	world := gearWorld(t)
	session := joinAt(world, 1500, 400)
	player := session.Player
	before := player.Attr
	giveAndEquip(t, world, session, "sage_ring")
	// 贤者之戒：int +3 → MAtk +7.5、MDef +3；cdr 0.15
	if math.Abs(player.Attr.MAtk-before.MAtk-7.5) > 1e-9 || math.Abs(player.Attr.MDef-before.MDef-3) > 1e-9 ||
		player.Attr.CDR != 0.15 {
		t.Fatalf("sage ring: %+v -> %+v", before, player.Attr)
	}
	slash := player.Skills[0]
	target := addTestEntity(world, 500, "monster", 1530, 400, monsterBase)
	if err := world.Combat.Cast(player, slash, target.ID); err != nil {
		t.Fatal(err)
	}
	wantCooldown := world.State.Now() + slash.Cooldown*0.85
	if math.Abs(player.Cooldowns[slash.ID]-wantCooldown) > 1e-9 {
		t.Fatalf("cooldown until %v, want %v", player.Cooldowns[slash.ID], wantCooldown)
	}
	// 鹰羽坠饰：派生属性直接加
	giveAndEquip(t, world, session, "hawk_pendant") // 换下贤者之戒
	if math.Abs(player.Attr.Crit-before.Crit-0.06) > 1e-9 || math.Abs(player.Attr.CritDmg-before.CritDmg-0.3) > 1e-9 ||
		player.Attr.CDR != 0 {
		t.Fatalf("hawk pendant: %+v", player.Attr)
	}
	// 守护者胸甲：max_hp +40 直接加，血量按比例保留
	player.HP = player.Attr.MaxHP / 2
	giveAndEquip(t, world, session, "guardian_mail")
	if math.Abs(player.Attr.MaxHP-before.MaxHP-40) > 1e-9 || math.Abs(player.HPRatio()-0.5) > 1e-9 {
		t.Fatalf("guardian mail: max hp %v, ratio %v", player.Attr.MaxHP, player.HPRatio())
	}
	// 冷却缩减有上限
	capped := attr.ComputeWithGear(playerBase, 100, nil, config.StatBonus{CDR: 0.9})
	if capped.CDR != config.MaxCDR {
		t.Fatalf("cdr = %v, want capped at %v", capped.CDR, config.MaxCDR)
	}
}

func TestLifestealHealsAttacker(t *testing.T) {
	world := gearWorld(t)
	forceLuck(world, true)
	session := joinAt(world, 1500, 400)
	player := session.Player
	giveAndEquip(t, world, session, "blood_blade")
	player.HP = 50
	target := addTestEntity(world, 500, "monster", 1530, 400, config.Attrs{Vit: 30})
	world.State.Events.Clear()
	if err := world.Combat.Cast(player, player.Skills[0], target.ID); err != nil {
		t.Fatal(err)
	}
	heals := queuedEvents(world, pb.EventKind_HEAL, "lifesteal")
	taken := lastDamage(world).GetValue()
	if len(heals) != 1 || heals[0].GetDst() != int32(player.ID) ||
		heals[0].GetValue() != float32(math.Round(float64(taken)*0.1)) || player.HP != 50+float64(heals[0].GetValue()) {
		t.Fatalf("lifesteal heals %v after %v damage, hp %v", heals, taken, player.HP)
	}
}

func TestIgniteAddsMagicDamage(t *testing.T) {
	world := gearWorld(t)
	session := joinAt(world, 1500, 400)
	player := session.Player
	giveAndEquip(t, world, session, "flame_greatsword")
	target := addTestEntity(world, 500, "monster", 1530, 400, config.Attrs{Vit: 30})
	forceLuck(world, false)
	world.Combat.Cast(player, player.Skills[0], target.ID)
	if len(queuedEvents(world, pb.EventKind_DAMAGE, "ignite")) != 0 {
		t.Fatal("ignite procced on a failed roll")
	}
	forceLuck(world, true)
	player.Cooldowns = map[string]float64{}
	world.State.Events.Clear()
	world.Combat.Cast(player, player.Skills[0], target.ID)
	ignites := queuedEvents(world, pb.EventKind_DAMAGE, "ignite")
	mdef := target.Attr.MDef
	want := math.Round(player.Attr.Atk * 0.6 * (1 - mdef/(mdef+100)))
	if len(ignites) != 1 || ignites[0].GetSrc() != int32(player.ID) || ignites[0].GetValue() != float32(want) {
		t.Fatalf("ignite events %v, want value %v", ignites, want)
	}
}

func TestThornsReflectsOnlyNearbyAttackers(t *testing.T) {
	world := gearWorld(t)
	forceLuck(world, true)
	session := joinAt(world, 1500, 400)
	player := session.Player
	giveAndEquip(t, world, session, "thorn_plate")
	near := addTestEntity(world, 500, "monster", 1540, 400, monsterBase)
	bite := world.State.Cfg.Skills["bite"]
	world.State.Events.Clear()
	if err := world.Combat.Cast(near, bite, player.ID); err != nil {
		t.Fatal(err)
	}
	landWindup(world, near)
	thorns := queuedEvents(world, pb.EventKind_DAMAGE, "thorns")
	if len(thorns) != 1 || thorns[0].GetSrc() != int32(player.ID) || thorns[0].GetDst() != int32(near.ID) {
		t.Fatalf("thorns events = %v", thorns)
	}
	if near.HP >= near.Attr.MaxHP {
		t.Fatal("attacker took no thorns damage")
	}
	// 远处的攻击者（边缘距离超过 120）不反弹
	far := addTestEntity(world, 501, "monster", 1700, 400, monsterBase)
	arrow := world.State.Cfg.Skills["arrow"]
	world.State.Events.Clear()
	if err := world.Combat.Cast(far, arrow, player.ID); err != nil {
		t.Fatal(err)
	}
	landWindup(world, far)
	if len(queuedEvents(world, pb.EventKind_DAMAGE, "thorns")) != 0 {
		t.Fatal("thorns reflected a far attacker")
	}
}

func TestThornsDoNotReflectThorns(t *testing.T) {
	world := gearWorld(t)
	forceLuck(world, true)
	first := joinAt(world, 1500, 400)
	giveAndEquip(t, world, first, "thorn_plate")
	// 两个都穿荆棘板甲、互相敌对：反伤只弹一次
	world.State.Cfg.World.Hostile["player"] = []string{"monster", "player"}
	second := joinAt(world, 1540, 400)
	giveAndEquip(t, world, second, "thorn_plate")
	world.State.Events.Clear()
	if err := world.Combat.Cast(first.Player, first.Player.Skills[0], second.Player.ID); err != nil {
		t.Fatal(err)
	}
	if thorns := queuedEvents(world, pb.EventKind_DAMAGE, "thorns"); len(thorns) != 1 {
		t.Fatalf("%d thorns events, want 1", len(thorns))
	}
}

func TestBlockHeal(t *testing.T) {
	world := gearWorld(t)
	session := joinAt(world, 1500, 400)
	player := session.Player
	giveAndEquip(t, world, session, "guardian_mail")
	player.HP = player.Attr.MaxHP / 2
	player.Blocking = true
	monster := addTestEntity(world, 500, "monster", 1540, 400, monsterBase)
	world.State.Events.Clear()
	if err := world.Combat.Cast(monster, world.State.Cfg.Skills["bite"], player.ID); err != nil {
		t.Fatal(err)
	}
	landWindup(world, monster)
	heals := queuedEvents(world, pb.EventKind_HEAL, "block_heal")
	if len(heals) != 1 || heals[0].GetValue() != float32(math.Round(player.Attr.MaxHP*0.04)) {
		t.Fatalf("block heal events = %v", heals)
	}
	// 没格挡就不回
	player.Blocking = false
	monster.Cooldowns = map[string]float64{}
	world.State.Events.Clear()
	world.Combat.Cast(monster, world.State.Cfg.Skills["bite"], player.ID)
	landWindup(world, monster)
	if len(queuedEvents(world, pb.EventKind_HEAL, "block_heal")) != 0 {
		t.Fatal("block heal without blocking")
	}
}

// rangerAt 让一个新玩家加入、换成游侠，放到 (x, y)。
func rangerAt(t *testing.T, world *World, x, y float64) *Session {
	t.Helper()
	session := joinAt(world, x, y)
	sendLoadout(world, session, "ranger", "pierce_shot", "arrow_rain", "roll", "frost_arrow", "focus")
	if session.Player.Class != "ranger" {
		t.Fatal("not a ranger")
	}
	return session
}

func TestMultishotOnBasicAttack(t *testing.T) {
	world := gearWorld(t)
	forceLuck(world, true)
	session := rangerAt(t, world, 1500, 400)
	player := session.Player
	giveAndEquip(t, world, session, "wind_bow")
	first := addTestEntity(world, 500, "monster", 1700, 400, config.Attrs{Vit: 30})
	second := addTestEntity(world, 501, "monster", 1600, 450, config.Attrs{Vit: 30})
	world.State.Events.Clear()
	if err := world.Combat.Cast(player, player.Skills[0], first.ID); err != nil {
		t.Fatal(err)
	}
	casts := queuedEvents(world, pb.EventKind_CAST, "multishot")
	hits := queuedEvents(world, pb.EventKind_DAMAGE, "multishot")
	if len(casts) != 1 || casts[0].GetFx() != "arrow" || casts[0].GetDst() != int32(second.ID) {
		t.Fatalf("multishot casts = %v", casts)
	}
	if len(hits) != 1 || hits[0].GetDst() != int32(second.ID) {
		t.Fatalf("multishot hits = %v", hits)
	}
	// 射程内没有别的敌人：再射同一个
	second.Dead = true
	player.Cooldowns = map[string]float64{}
	world.State.Events.Clear()
	world.Combat.Cast(player, player.Skills[0], first.ID)
	if hits := queuedEvents(world, pb.EventKind_DAMAGE, "multishot"); len(hits) != 1 || hits[0].GetDst() != int32(first.ID) {
		t.Fatalf("multishot without a second enemy = %v", hits)
	}
	// 只有普攻（1 号位）会触发
	world.State.Events.Clear()
	world.Combat.Cast(player, world.State.Cfg.Skills["frost_arrow"], first.ID)
	if len(queuedEvents(world, pb.EventKind_DAMAGE, "multishot")) != 0 {
		t.Fatal("multishot on a non-basic skill")
	}
}

func TestChillSlowsTarget(t *testing.T) {
	world := gearWorld(t)
	forceLuck(world, true)
	session := rangerAt(t, world, 1500, 400)
	player := session.Player
	giveAndEquip(t, world, session, "frost_bow")
	target := addTestEntity(world, 500, "monster", 1700, 400, config.Attrs{Vit: 30})
	world.State.Events.Clear()
	world.Combat.Cast(player, player.Skills[0], target.ID)
	buffs := queuedEvents(world, pb.EventKind_BUFF, "chill")
	if len(buffs) != 1 || buffs[0].GetDst() != int32(target.ID) || buffs[0].GetName() != config.ChillBuffName {
		t.Fatalf("chill buffs = %v", buffs)
	}
	if math.Abs(target.Attr.Speed-target.Speed*0.7) > 1e-9 || target.Looks()&config.Looks["frost"] == 0 {
		t.Fatalf("speed %v (base %v), looks %v", target.Attr.Speed, target.Speed, target.Looks())
	}
}

func TestAmbushCritsAfterDash(t *testing.T) {
	world := gearWorld(t)
	session := rangerAt(t, world, 1500, 400)
	player := session.Player
	giveAndEquip(t, world, session, "shadow_leather")
	player.Attr.Crit = 0 // 没有伏击就不会暴击
	target := addTestEntity(world, 500, "monster", 1800, 400, config.Attrs{Vit: 30})
	roll := world.State.Cfg.Skills["roll"]
	if err := world.Combat.CastAimed(player, roll, 0, 1, 0); err != nil {
		t.Fatal(err)
	}
	if player.AmbushUntil != world.State.Now()+3 {
		t.Fatalf("ambush until %v", player.AmbushUntil)
	}
	world.Combat.Cast(player, player.Skills[0], target.ID)
	if !lastDamage(world).GetCrit() || player.AmbushUntil != 0 {
		t.Fatal("first hit after the dash did not crit")
	}
	player.Cooldowns = map[string]float64{}
	world.Combat.Cast(player, player.Skills[0], target.ID)
	if lastDamage(world).GetCrit() {
		t.Fatal("ambush crit twice")
	}
}

func TestRegenHealsOverTime(t *testing.T) {
	world := gearWorld(t)
	session := joinAt(world, 1500, 400)
	player := session.Player
	giveAndEquip(t, world, session, "life_charm")
	player.HP = player.Attr.MaxHP / 2
	before := player.HP
	for i := 0; i < world.State.Cfg.World.TickRate; i++ {
		world.Step()
	}
	if math.Abs(player.HP-before-player.Attr.MaxHP*0.01) > 1e-6 {
		t.Fatalf("regen healed %v in 1s, want %v", player.HP-before, player.Attr.MaxHP*0.01)
	}
}

func TestLootGoesToKillersBag(t *testing.T) {
	world := gearWorld(t)
	session := joinAt(world, 1500, 400)
	player := session.Player
	readMessages(t, session)
	slime := world.State.Cfg.Templates["slime"]

	forceLuck(world, false)
	world.Combat.Kill(world.Spawn.Template(slime, 1530, 400), player)
	if len(player.Items) != 3 || len(queuedEvents(world, pb.EventKind_LOOT, "")) != 0 {
		t.Fatal("dropped loot on a failed roll")
	}

	// 骰子都是 0：从本职业能用的里抽、稀有度 common、第一件 → 新兵长剑
	forceLuck(world, true)
	monster := world.Spawn.Template(slime, 1530, 400)
	world.Combat.Kill(monster, player)
	loot := queuedEvents(world, pb.EventKind_LOOT, "")
	if len(loot) != 1 || loot[0].GetSrc() != int32(monster.ID) || loot[0].GetDst() != int32(player.ID) ||
		loot[0].GetItem() != "recruit_sword" {
		t.Fatalf("loot events = %v", loot)
	}
	if len(player.Items) != 4 || player.Items[3].Cfg.ID != "recruit_sword" {
		t.Fatal("loot not in the bag")
	}
	world.Sessions.Flush()
	if inventory := lastInventory(readMessages(t, session)); inventory == nil || len(inventory.Items) != 4 {
		t.Fatalf("inventory after loot = %v", inventory)
	}

	// 背包满了：提示，不给，不发 LOOT
	fillBag(world, player)
	count := len(player.Items)
	world.State.Events.Clear()
	world.Combat.Kill(world.Spawn.Template(slime, 1530, 400), player)
	if len(player.Items) != count || len(queuedEvents(world, pb.EventKind_LOOT, "")) != 0 {
		t.Fatal("loot given into a full bag")
	}
	world.Sessions.Flush()
	if got := toasts(readMessages(t, session)); len(got) != 1 || got[0] != item.ReasonBagFull {
		t.Fatalf("toasts = %v", got)
	}
}

func TestSkinSwitch(t *testing.T) {
	world := gearWorld(t)
	session := joinAt(world, 1500, 400)
	observer := joinAt(world, 1520, 400)
	player := session.Player
	world.Sessions.Flush()
	if info := enteredInfo(readMessages(t, observer), player.ID); info.GetSkin() != "paladin" {
		t.Fatalf("first enter skin %q", info.GetSkin())
	}
	readMessages(t, session)
	sendSkin(world, session, "obsidian")
	if player.Skin != "obsidian" {
		t.Fatalf("skin %q", player.Skin)
	}
	world.Sessions.Flush()
	if info := enteredInfo(readMessages(t, observer), player.ID); info == nil || info.GetSkin() != "obsidian" {
		t.Fatalf("re-enter = %v", info)
	}
	sendSkin(world, session, "woodland") // 游侠的皮肤
	if got := toasts(readMessages(t, session)); len(got) != 1 || got[0] != item.ReasonBadSkin || player.Skin != "obsidian" {
		t.Fatalf("toasts %v, skin %q", got, player.Skin)
	}
	sendSkin(world, session, "")
	if player.Skin != "paladin" {
		t.Fatalf("empty skin -> %q, want default", player.Skin)
	}
	// 换成一样的皮肤不重发 Enter
	world.Sessions.Flush()
	readMessages(t, observer)
	sendSkin(world, session, "paladin")
	if !canSee(world, observer, player.ID) {
		t.Fatal("same skin re-sent Enter")
	}
}

func TestClassSwitchUnequipsAndResetsSkin(t *testing.T) {
	world := gearWorld(t)
	session := joinAt(world, 1500, 400)
	player := session.Player
	sendEquip(world, session, ownedID(player, "recruit_sword").UID)
	sendEquip(world, session, ownedID(player, "leather_vest").UID)
	sendSkin(world, session, "gilded")
	readMessages(t, session)
	sendLoadout(world, session, "ranger", "pierce_shot", "arrow_rain", "roll", "frost_arrow", "focus")
	if player.Equipped("weapon") != nil || player.Equipped("armor") == nil {
		t.Fatal("knight sword kept or vest removed")
	}
	if player.Skin != "woodland" || player.GearLook() != "" {
		t.Fatalf("skin %q look %q after class switch", player.Skin, player.GearLook())
	}
	// 第一次当游侠：发游侠的新手弓
	inventory := lastInventory(readMessages(t, session))
	if inventory == nil || ownedID(player, "hunter_bow") == nil || len(inventory.Items) != 4 {
		t.Fatalf("inventory after switch = %v", inventory)
	}
	// 换回骑士再换游侠：不再发新手弓
	world.Combat.Kill(player, nil)
	sendLoadout(world, session, "knight", "fireball", "whirlwind", "heal", "warcry", "shield")
	sendLoadout(world, session, "ranger", "pierce_shot", "arrow_rain", "roll", "frost_arrow", "focus")
	if len(player.Items) != 4 {
		t.Fatalf("%d items, starter given twice", len(player.Items))
	}
}

func TestClassSwitchDropsWhenBagFull(t *testing.T) {
	world := gearWorld(t)
	session := joinAt(world, 1500, 400)
	player := session.Player
	sendEquip(world, session, ownedID(player, "recruit_sword").UID)
	fillBag(world, player)
	readMessages(t, session)
	sendLoadout(world, session, "ranger", "pierce_shot", "arrow_rain", "roll", "frost_arrow", "focus")
	if ownedID(player, "recruit_sword") != nil {
		t.Fatal("sword kept although the bag is full")
	}
	got := toasts(readMessages(t, session))
	// 剑被丢掉；背包满着，游侠的新手弓也领不到
	if len(got) != 2 ||
		got[0] != item.NoticeDropped+"「新兵长剑」" ||
		got[1] != item.NoticeStarterLost+"「猎人短弓」" {
		t.Fatalf("toasts = %v", got)
	}
}
