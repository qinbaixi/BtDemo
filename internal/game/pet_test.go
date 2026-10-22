package game

import (
	"math"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/pet"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// stepNoFlush 把世界推进一个 tick，但不同步（不清事件队列，也不往会话输出里写），
// 这样测试可以在 tick 之后检查事件。
func stepNoFlush(world *World) {
	world.State.Clock.Advance()
	world.Spawn.Tick()
	world.Pet.Tick()
	world.Combat.Tick()
	world.Zone.Tick()
	world.Move.Tick()
	world.AI.Tick(nil)
}

// stepFor 推进世界 seconds 秒（不同步）。
func stepFor(world *World, seconds float64) {
	end := world.State.Now() + seconds
	for world.State.Now() < end {
		stepNoFlush(world)
	}
}

// petOf 是玩家现在场上的宠物，没有返回 nil。
func petOf(world *World, owner *core.Entity) *core.Entity {
	return world.State.Ents.Get(owner.PetEntity)
}

// joinWithPet 让新玩家加入并放到 (x, y)，宠物也跟过去（进游戏时它在出生点召唤出来）。
func joinWithPet(world *World, x, y float64) *Session {
	session := joinAt(world, x, y)
	if pup := petOf(world, session.Player); pup != nil {
		pup.X, pup.Y = x-40, y+24
		world.Grid.Moved(pup)
	}
	return session
}

// inGrid 报告 entity 是否还在 AOI 网格里。
func inGrid(world *World, entity *core.Entity) bool {
	found := false
	world.Grid.InRange(entity.X, entity.Y, 1, func(other *core.Entity) {
		found = found || other == entity
	})
	return found
}

// lastPetStatus 是消息里最后一条 PetStatus，没有返回 nil。
func lastPetStatus(msgs []*pb.ServerMsg) *pb.PetStatus {
	var status *pb.PetStatus
	for _, msg := range msgs {
		if msg.GetPetStatus() != nil {
			status = msg.GetPetStatus()
		}
	}
	return status
}

// sendPet 让玩家发 SetPet 消息；petID 为空表示收回。
func sendPet(world *World, session *Session, petID string) {
	setPet := &pb.SetPet{Pet: proto.String(petID)}
	world.Input(session, &pb.ClientMsg{Msg: &pb.ClientMsg_Pet{Pet: setPet}})
}

// castEvents 是事件队列里 fx 为 fx 的 CAST 事件。
func castEvents(world *World, fx string) []*pb.Event {
	var events []*pb.Event
	for _, pending := range world.State.Events.List() {
		event := pending.Event
		if event.GetKind() == pb.EventKind_CAST && event.GetFx() == fx {
			events = append(events, event)
		}
	}
	return events
}

// 进游戏默认召唤第一只宠物：Welcome 带宠物图鉴，宠物是 kind = pet 的实体，
// 等级和主人一样，属性按模板，阵营和主人一样，并且发了 PetStatus。
func TestPetSummonedOnJoin(t *testing.T) {
	world := gearWorld(t)
	session := joinWithPet(world, 1500, 400)
	owner := session.Player
	msgs := readMessages(t, session)

	welcome := msgs[0].GetWelcome()
	if len(welcome.Pets) != 3 || welcome.Pets[0].GetId() != "wolf_pup" ||
		welcome.Pets[0].GetName() != "小狼" || welcome.Pets[2].GetModel() != "sprout" {
		t.Fatalf("welcome pets = %v", welcome.Pets)
	}
	pup := petOf(world, owner)
	if pup == nil || pup.Kind != core.KindPet || pup.Owner != owner.ID || pup.Faction != "player" ||
		pup.Level != owner.Level || owner.PetID != "wolf_pup" || pup.PetCfg.ID != "wolf_pup" {
		t.Fatalf("pet = %+v", pup)
	}
	template := world.State.Cfg.Pet("wolf_pup")
	if pup.Base != template.Attrs || pup.HP != pup.Attr.MaxHP || pup.AI == nil {
		t.Fatalf("pet base %+v hp %v/%v", pup.Base, pup.HP, pup.Attr.MaxHP)
	}
	if len(pup.Skills) != 2 || pup.Skills[0].ID != "pet_bite" {
		t.Fatalf("pet skills = %v", pup.Skills)
	}
	status := lastPetStatus(msgs)
	if status.GetPet() != "wolf_pup" || int(status.GetEntity()) != pup.ID ||
		status.GetRespawnIn() != 0 || status.GetCooldown() != 0 {
		t.Fatalf("status = %v", status)
	}
	if !inGrid(world, pup) {
		t.Fatal("pet not in the AOI grid")
	}

	world.Sessions.Flush()
	info := enteredInfo(readMessages(t, session), pup.ID)
	if info == nil || info.GetKind() != pb.EntityKind_PET || int(info.GetOwner()) != owner.ID ||
		info.GetModel() != "wolf_pup" {
		t.Fatalf("pet info = %v", info)
	}
}

// 换宠物：换成新的、旧的删掉；冷却中被拒绝；不认识的 id 被拒绝；收回也占冷却。
func TestPetSwapAndCooldown(t *testing.T) {
	world := gearWorld(t)
	session := joinWithPet(world, 1500, 400)
	owner := session.Player
	oldPet := petOf(world, owner)
	readMessages(t, session)

	sendPet(world, session, "ember")
	msgs := readMessages(t, session)
	ember := petOf(world, owner)
	if ember == nil || ember.ID == oldPet.ID || ember.PetCfg.ID != "ember" || ember.Model != "ember" {
		t.Fatalf("pet after swap = %+v", ember)
	}
	if world.State.Ents.Get(oldPet.ID) != nil || inGrid(world, oldPet) {
		t.Fatal("old pet still in the world")
	}
	status := lastPetStatus(msgs)
	if status.GetPet() != "ember" || int(status.GetEntity()) != ember.ID ||
		math.Abs(float64(status.GetCooldown())-5) > 0.01 {
		t.Fatalf("status after swap = %v", status)
	}

	sendPet(world, session, "sprout")
	if got := toasts(readMessages(t, session)); len(got) != 1 || got[0] != pet.ReasonCooldown {
		t.Fatalf("toasts = %v, want %q", got, pet.ReasonCooldown)
	}
	if petOf(world, owner) != ember {
		t.Fatal("pet swapped during the cooldown")
	}

	sendPet(world, session, "nobody")
	if got := toasts(readMessages(t, session)); len(got) != 1 || got[0] != pet.ReasonUnknown {
		t.Fatalf("toasts = %v, want %q", got, pet.ReasonUnknown)
	}

	// 冷却过了可以换；选的就是现在这只不算换，不占冷却
	world.State.Clock.Now += 5.1
	sendPet(world, session, "ember")
	if got := toasts(readMessages(t, session)); len(got) != 0 {
		t.Fatalf("toasts = %v", got)
	}
	sendPet(world, session, "")
	if petOf(world, owner) != nil || owner.PetID != "" {
		t.Fatal("pet not dismissed")
	}
	status = lastPetStatus(readMessages(t, session))
	if status.GetPet() != "" || status.GetEntity() != 0 || status.GetCooldown() < 4.9 {
		t.Fatalf("status after dismiss = %v", status)
	}
	sendPet(world, session, "sprout") // 收回也占了冷却
	if got := toasts(readMessages(t, session)); len(got) != 1 || got[0] != pet.ReasonCooldown {
		t.Fatalf("toasts = %v, want %q", got, pet.ReasonCooldown)
	}
	world.State.Clock.Now += 5.1
	sendPet(world, session, "sprout")
	if sprout := petOf(world, owner); sprout == nil || sprout.PetCfg.ID != "sprout" {
		t.Fatalf("pet after the second swap = %+v", sprout)
	}
}

// 宠物跟着主人走，离得太远时直接传送，并发 pet_teleport 事件。
func TestPetFollowsOwnerAndTeleports(t *testing.T) {
	world := gearWorld(t)
	session := joinWithPet(world, 1500, 400)
	owner := session.Player
	pup := petOf(world, owner)

	owner.X = 1700
	world.Grid.Moved(owner)
	stepFor(world, 3)
	if dist := core.Dist(pup, owner); dist > 70 {
		t.Fatalf("pet is %.0f away after following", dist)
	}
	if len(castEvents(world, core.FXPetTeleport)) != 0 {
		t.Fatal("teleported although close")
	}

	world.State.Events.Clear()
	owner.X, owner.Y = 500, 1200
	world.Grid.Moved(owner)
	from := core.Dist(pup, owner)
	if from <= world.State.Cfg.World.Pet.Teleport {
		t.Fatalf("test setup: pet only %.0f away", from)
	}
	stepNoFlush(world)
	if dist := core.Dist(pup, owner); dist > 60 {
		t.Fatalf("pet is %.0f away after teleporting", dist)
	}
	events := castEvents(world, core.FXPetTeleport)
	if len(events) != 1 || events[0].GetSrc() != int32(pup.ID) ||
		math.Abs(float64(events[0].GetTx())-pup.X) > 0.2 || events[0].GetX() > 1800 {
		t.Fatalf("teleport events = %v", events)
	}
}

// 宠物打主人的目标，打不到的时候追上去。
func TestPetAttacksOwnersTarget(t *testing.T) {
	world := gearWorld(t)
	session := joinWithPet(world, 1500, 400)
	owner := session.Player
	pup := petOf(world, owner)
	slime := world.Spawn.Template(world.State.Cfg.Templates["slime"], 1600, 400)
	owner.Target = slime.ID

	stepFor(world, 0.5)
	if pup.Target != slime.ID {
		t.Fatalf("pet target = %d, want the owner's target %d", pup.Target, slime.ID)
	}
	stepFor(world, 4)
	if slime.HP >= slime.Attr.MaxHP && !slime.Dead {
		t.Fatalf("slime untouched: hp %v/%v", slime.HP, slime.Attr.MaxHP)
	}
	if pup.Action == "" {
		t.Fatal("pet shows no action")
	}
}

// 主人没选目标时，宠物打攻击主人的怪；目标离主人太远就放弃。
func TestPetGuardsOwnerAndLeash(t *testing.T) {
	world := gearWorld(t)
	session := joinWithPet(world, 1500, 400)
	owner := session.Player
	pup := petOf(world, owner)
	attacker := world.Spawn.Template(world.State.Cfg.Templates["slime"], 1560, 400)
	owner.LastAttacker, owner.LastHitAt = attacker.ID, world.State.Now()
	stepNoFlush(world)
	stepNoFlush(world)
	if pup.Target != attacker.ID {
		t.Fatalf("pet target = %d, want the attacker %d", pup.Target, attacker.ID)
	}

	// 怪物被拉到离主人超过 Leash（450）的地方
	owner.LastAttacker = 0
	attacker.X, attacker.Y = 1500+800, 400
	world.Grid.Moved(attacker)
	owner.Target = 0
	stepFor(world, 1)
	if pup.Target != 0 {
		t.Fatalf("pet still targets %d beyond the leash", pup.Target)
	}
}

// 林精在主人血量低于 60% 时给主人回血，高于时不治疗。
func TestHealerHealsOwnerBelowSixtyPercent(t *testing.T) {
	world := gearWorld(t)
	session := joinWithPet(world, 1500, 400)
	owner := session.Player
	sendPet(world, session, "sprout")
	sprout := petOf(world, owner)
	if sprout == nil || sprout.PetCfg.Tree != "pet_healer" {
		t.Fatalf("pet = %+v", sprout)
	}

	owner.HP = owner.Attr.MaxHP * 0.8
	before := owner.HP
	stepFor(world, 2)
	if owner.HP != before {
		t.Fatalf("healed at 80%%: %v -> %v", before, owner.HP)
	}

	owner.HP = owner.Attr.MaxHP * 0.4
	before = owner.HP
	world.State.Events.Clear()
	for i := 0; i < 60 && owner.HP == before; i++ {
		stepNoFlush(world)
	}
	if owner.HP <= before {
		t.Fatalf("owner not healed: %v", owner.HP)
	}
	heals := queuedEvents(world, pb.EventKind_HEAL, "")
	if len(heals) == 0 || heals[0].GetDst() != int32(owner.ID) {
		t.Fatalf("heal events = %v", heals)
	}
	want := math.Round(owner.Attr.MaxHP * 0.25)
	if got := owner.HP - before; math.Abs(got-want) > 1 {
		t.Fatalf("healed %v, want %v", got, want)
	}
}

// ally 技能：不在范围内放不出，敌对的目标放不出。
func TestAllySkillRules(t *testing.T) {
	world := gearWorld(t)
	session := joinWithPet(world, 1500, 400)
	owner := session.Player
	sendPet(world, session, "sprout")
	sprout := petOf(world, owner)
	mend := world.State.Cfg.Skills["pet_mend"]
	owner.HP = owner.Attr.MaxHP * 0.5

	sprout.X, sprout.Y = owner.X+400, owner.Y
	world.Grid.Moved(sprout)
	if err := world.Combat.Cast(sprout, mend, owner.ID); err == nil {
		t.Fatal("mended from out of range")
	}
	sprout.X = owner.X + 50
	world.Grid.Moved(sprout)
	slime := world.Spawn.Template(world.State.Cfg.Templates["slime"], 1560, 400)
	if err := world.Combat.Cast(sprout, mend, slime.ID); err == nil {
		t.Fatal("mended an enemy")
	}
	if err := world.Combat.Cast(sprout, mend, owner.ID); err != nil {
		t.Fatal(err)
	}
	if owner.HP <= owner.Attr.MaxHP*0.5 {
		t.Fatal("owner not healed")
	}
}

// 玩家不能伤害宠物，不能把宠物当目标；怪物可以打宠物，守卫不打。
func TestPlayersCannotDamagePets(t *testing.T) {
	world := gearWorld(t)
	session := joinWithPet(world, 1500, 400)
	other := joinWithPet(world, 1530, 400)
	owner := session.Player
	pup := petOf(world, owner)
	pup.X, pup.Y = 1520, 400
	world.Grid.Moved(pup)
	slash := other.Player.Skills[0]
	whirlwind := world.State.Cfg.Skills["whirlwind"]

	for _, attacker := range []*core.Entity{owner, other.Player} {
		if err := world.Combat.Cast(attacker, slash, pup.ID); err == nil {
			t.Fatalf("player %d attacked a pet", attacker.ID)
		}
		if err := world.Combat.Cast(attacker, whirlwind, 0); err != nil {
			t.Fatal(err)
		}
	}
	if pup.HP != pup.Attr.MaxHP || pup.Dead {
		t.Fatalf("pet hurt by players: %v/%v", pup.HP, pup.Attr.MaxHP)
	}
	if world.Combat.NearestMonster(owner, 300) != nil || world.Combat.NearestHostile(owner, 300) != nil {
		t.Fatal("players auto-target the pet")
	}

	slime := world.Spawn.Template(world.State.Cfg.Templates["slime"], 1560, 400)
	if !world.State.Hostile(slime, pup) {
		t.Fatal("monsters do not attack pets")
	}
	guard := world.Spawn.Template(world.State.Cfg.Templates["guard"], 1400, 400)
	if world.State.Hostile(guard, pup) || world.State.Hostile(pup, guard) {
		t.Fatal("guards and pets are hostile to each other")
	}
	if err := world.Combat.Cast(slime, slime.Skills[0], pup.ID); err != nil {
		t.Fatal(err)
	}
	if pup.HP >= pup.Attr.MaxHP {
		t.Fatal("monster did not hurt the pet")
	}
}

// 宠物打死怪物：经验和掉落记给主人。
func TestPetKillCreditsOwner(t *testing.T) {
	world := gearWorld(t)
	session := joinWithPet(world, 1500, 400)
	owner := session.Player
	pup := petOf(world, owner)
	forceLuck(world, true)
	slime := world.Spawn.Template(world.State.Cfg.Templates["slime"], 1530, 400)
	items := len(owner.Items)
	world.State.Events.Clear()

	world.Combat.Kill(slime, pup)
	if !slime.Dead || owner.Exp != slime.Tmpl.Exp {
		t.Fatalf("dead %v owner exp %d, want %d", slime.Dead, owner.Exp, slime.Tmpl.Exp)
	}
	loot := queuedEvents(world, pb.EventKind_LOOT, "")
	if len(owner.Items) != items+1 || len(loot) != 1 || loot[0].GetDst() != int32(owner.ID) {
		t.Fatalf("items %d -> %d, loot events %v", items, len(owner.Items), loot)
	}
	if pup.Exp != 0 {
		t.Fatalf("pet got exp %d", pup.Exp)
	}
}

// 宠物死后 10 秒在主人身边复活；死亡和复活都通知主人。
func TestPetRespawns(t *testing.T) {
	world := gearWorld(t)
	session := joinWithPet(world, 1500, 400)
	owner := session.Player
	pup := petOf(world, owner)
	slime := world.Spawn.Template(world.State.Cfg.Templates["slime"], 1530, 400)
	readMessages(t, session)

	world.Combat.Kill(pup, slime)
	stepNoFlush(world)
	world.Sessions.Flush()
	status := lastPetStatus(readMessages(t, session))
	if !pup.Dead || status == nil || int(status.GetEntity()) != pup.ID ||
		status.GetRespawnIn() < 9 || status.GetRespawnIn() > 10 {
		t.Fatalf("dead %v, status after death = %v", pup.Dead, status)
	}

	stepFor(world, 9)
	if !pup.Dead {
		t.Fatal("pet respawned early")
	}
	owner.X, owner.Y = 1000, 900 // 主人走远了：复活在主人身边
	world.Grid.Moved(owner)
	world.State.Events.Clear()
	stepFor(world, 1.2)
	if pup.Dead || pup.HP != pup.Attr.MaxHP || core.Dist(pup, owner) > 100 {
		t.Fatalf("after respawn dead %v hp %v dist %.0f", pup.Dead, pup.HP, core.Dist(pup, owner))
	}
	world.Sessions.Flush()
	status = lastPetStatus(readMessages(t, session))
	if status == nil || status.GetRespawnIn() != 0 || int(status.GetEntity()) != pup.ID {
		t.Fatalf("status after respawn = %v", status)
	}
}

// 主人死亡时宠物收回，主人复活时重新召唤；主人断线时宠物删除。
func TestPetFollowsOwnerLifecycle(t *testing.T) {
	world := gearWorld(t)
	session := joinWithPet(world, 1500, 400)
	owner := session.Player
	pup := petOf(world, owner)
	slime := world.Spawn.Template(world.State.Cfg.Templates["slime"], 1530, 400)

	world.Combat.Kill(owner, slime)
	stepNoFlush(world)
	if world.State.Ents.Get(pup.ID) != nil || owner.PetEntity != 0 || owner.PetID != "wolf_pup" {
		t.Fatal("pet not recalled when the owner died")
	}
	stepFor(world, world.State.Cfg.World.Player.Respawn+0.5)
	if owner.Dead {
		t.Fatal("owner did not respawn")
	}
	revived := petOf(world, owner)
	if revived == nil || revived.PetCfg.ID != "wolf_pup" || core.Dist(revived, owner) > 100 {
		t.Fatalf("pet after the owner respawned = %+v", revived)
	}

	petID := revived.ID
	world.Leave(session)
	if world.State.Ents.Get(petID) != nil || inGrid(world, revived) {
		t.Fatal("pet stayed after the owner left")
	}
	if world.State.Ents.Get(owner.ID) != nil {
		t.Fatal("owner stayed")
	}
}

// 主人升级后宠物等级和属性跟着刷新：属性 = 模板 attrs + growth × (等级 - 1)。
func TestPetLevelFollowsOwner(t *testing.T) {
	world := gearWorld(t)
	session := joinWithPet(world, 1500, 400)
	owner := session.Player
	pup := petOf(world, owner)
	template := pup.PetCfg
	oldMax := pup.Attr.MaxHP

	world.Attr.GainExp(owner, 100*owner.Level+100*(owner.Level+1)) // 连升两级
	if owner.Level != 3 {
		t.Fatalf("owner level %d", owner.Level)
	}
	stepNoFlush(world)
	if pup.Level != 3 {
		t.Fatalf("pet level %d, want 3", pup.Level)
	}
	if want := template.Attrs.Vit + template.Growth.Vit*2; pup.Base.Vit != want {
		t.Fatalf("pet vit %v, want %v", pup.Base.Vit, want)
	}
	if pup.Attr.MaxHP <= oldMax {
		t.Fatalf("pet max hp %v did not grow from %v", pup.Attr.MaxHP, oldMax)
	}
}

// 火灵和目标保持距离（边缘距离在 120 ~ 220 之间）并用火球打它。
func TestCasterKeepsDistance(t *testing.T) {
	world := gearWorld(t)
	session := joinWithPet(world, 1500, 400)
	owner := session.Player
	sendPet(world, session, "ember")
	ember := petOf(world, owner)
	slime := world.Spawn.Template(world.State.Cfg.Templates["slime"], 1560, 400)
	slime.Attr.Speed = 0 // 站着不动，只看火灵怎么走位
	owner.Target = slime.ID

	stepFor(world, 3)
	dist := core.EdgeDist(ember, slime)
	if dist < 115 || dist > 225 {
		t.Fatalf("ember edge distance to the target is %.0f, want 120 ~ 220", dist)
	}
	if slime.HP >= slime.Attr.MaxHP && !slime.Dead {
		t.Fatal("ember did not attack")
	}
}

// 调试面板能像看怪物一样看宠物的行为树，并写出为什么选了这个目标。
func TestPetTreeCanBeWatched(t *testing.T) {
	world := gearWorld(t)
	session := joinWithPet(world, 1500, 400)
	pup := petOf(world, session.Player)
	slime := world.Spawn.Template(world.State.Cfg.Templates["slime"], 1560, 400)
	session.Player.Target = slime.ID
	session.Watch = pup.ID
	readMessages(t, session)

	world.AI.Tick(map[int]bool{pup.ID: true})
	world.Sessions.Flush()
	var trace *pb.AiTrace
	for _, msg := range readMessages(t, session) {
		if ai := msg.GetSync().GetAi(); ai != nil {
			trace = ai
		}
	}
	if trace == nil || trace.GetTree() != "pet_melee" || trace.GetDef() == nil || len(trace.Ticks) == 0 {
		t.Fatalf("trace = %v", trace)
	}
	found := false
	for _, node := range trace.Ticks[0].Nodes {
		for _, note := range node.Notes {
			found = found || note != ""
		}
	}
	if !found {
		t.Fatal("trace has no service notes")
	}
}
