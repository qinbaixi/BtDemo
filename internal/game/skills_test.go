package game

import (
	"math"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/combat"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 新技能（闪现、飞斧、无敌、附魔、减速）和挑技能的测试。

func lastCast(world *World) *pb.Event {
	var event *pb.Event
	for _, pending := range world.State.Events.List() {
		if pending.Event.GetKind() == pb.EventKind_CAST {
			event = pending.Event
		}
	}
	return event
}

func TestBlinkMovesAndStopsAtWall(t *testing.T) {
	// x = 400..420 有一道墙
	wall := nav.Shape{Kind: nav.Rect, A: nav.Vec{X: 400, Y: 0}, B: nav.Vec{X: 420, Y: 1000}}
	world := testWorld(wall)
	player := addTestEntity(world, 1, "player", 100, 500, playerBase)
	blink := &config.Skill{ID: "blink", Kind: "dash", Distance: 170, Cooldown: 8, FX: "blink"}
	if err := world.Combat.CastAimed(player, blink, 0, 3, 0); err != nil {
		t.Fatalf("blink: %v", err)
	}
	if math.Abs(player.X-270) > 1e-6 || player.Y != 500 {
		t.Fatalf("after open blink at (%v, %v), want (270, 500)", player.X, player.Y)
	}
	event := lastCast(world)
	if event.GetX() != 100 || event.GetTx() != 270 {
		t.Fatalf("cast event from %v to %v", event.GetX(), event.GetTx())
	}
	// 再闪一次就撞墙：停在墙前面，身体不进墙
	player.Cooldowns = map[string]float64{}
	if err := world.Combat.CastAimed(player, blink, 0, 1, 0); err != nil {
		t.Fatalf("blink into wall: %v", err)
	}
	if player.X+player.Radius > 400 || player.X < 370 {
		t.Fatalf("blink into wall ended at x = %v", player.X)
	}
	// 紧贴着墙再往墙里闪：放不出来，也不进冷却
	player.Cooldowns = map[string]float64{}
	player.X = 400 - player.Radius
	world.Grid.Moved(player)
	if err := world.Combat.CastAimed(player, blink, 0, 1, 0); err != combat.ErrNoRoom {
		t.Fatalf("blink against wall: %v, want ErrNoRoom", err)
	}
	if err := world.Combat.CastAimed(player, blink, 0, 0, 0); err != combat.ErrNoAim {
		t.Fatalf("blink without aim: %v, want ErrNoAim", err)
	}
}

func TestAxeHitsFirstEnemyOnLine(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 100, 500, playerBase)
	near := addTestEntity(world, 2, "monster", 250, 505, monsterBase)
	far := addTestEntity(world, 3, "monster", 350, 500, monsterBase)
	aside := addTestEntity(world, 4, "monster", 200, 600, monsterBase) // 不在飞行线上
	axe := &config.Skill{ID: "axe", Kind: "line", Range: 320, Damage: "physical", Ratio: 1, Base: 5, FX: "axe"}
	if err := world.Combat.CastAimed(player, axe, 0, 1, 0); err != nil {
		t.Fatalf("axe: %v", err)
	}
	if near.HP == near.Attr.MaxHP || far.HP != far.Attr.MaxHP || aside.HP != aside.Attr.MaxHP {
		t.Fatalf("HP near %v far %v aside %v", near.HP, far.HP, aside.HP)
	}
	event := lastCast(world)
	if int(event.GetDst()) != near.ID || event.GetTx() > 250 || event.GetTx() < 200 {
		t.Fatalf("cast dst %v ended at x = %v", event.GetDst(), event.GetTx())
	}
	// 往反方向扔：没打中，一直飞到地图边缘（左边只有 100 像素，不到射程）
	player.Cooldowns = map[string]float64{}
	if err := world.Combat.CastAimed(player, axe, 0, -1, 0); err != nil {
		t.Fatalf("axe miss: %v", err)
	}
	if event := lastCast(world); event.Dst != nil || event.GetTx() > 12 {
		t.Fatalf("missed axe: dst %v, ended at x = %v", event.GetDst(), event.GetTx())
	}
}

func TestInvulnerableTakesNoDamage(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 0, 0, playerBase)
	monster := addTestEntity(world, 2, "monster", 60, 0, monsterBase)
	holy := &config.Skill{ID: "holy", Kind: "self", Cooldown: 25,
		Buff: &config.Buff{Name: "圣光庇护", Duration: 2, Invulnerable: true, Look: "holy"}}
	if err := world.Combat.Cast(player, holy, 0); err != nil {
		t.Fatalf("cast: %v", err)
	}
	if player.Looks() != config.Looks["holy"] {
		t.Fatalf("looks = %v", player.Looks())
	}
	big := &config.Skill{ID: "big", Kind: "target", Range: 70, Damage: "physical", Base: 100000}
	if err := world.Combat.Cast(monster, big, player.ID); err != nil {
		t.Fatalf("hit: %v", err)
	}
	if event := lastDamage(world); !event.GetImmune() || event.GetValue() != 0 ||
		player.HP != player.Attr.MaxHP || player.Dead {
		t.Fatalf("immune %v value %v HP %v dead %v", event.GetImmune(), event.GetValue(), player.HP, player.Dead)
	}
}

func TestEnchantAddsMagicDamage(t *testing.T) {
	plain := func(enchanted bool) float64 {
		world := testWorld()
		player := addTestEntity(world, 1, "player", 0, 0, playerBase)
		monster := addTestEntity(world, 2, "monster", 60, 0, monsterBase)
		player.Attr.Crit = 0
		if enchanted {
			enchant := &config.Skill{ID: "enchant", Kind: "self",
				Buff: &config.Buff{Name: "烈焰附魔", Duration: 8, BonusMagic: 0.6, Look: "fire"}}
			if err := world.Combat.Cast(player, enchant, 0); err != nil {
				t.Fatalf("enchant: %v", err)
			}
			player.Attr.Crit = 0
		}
		damage, _ := world.Combat.CalcDamage(player, monster, slashSkill())
		return damage
	}
	without, with := plain(false), plain(true)
	// 法强 28 × 0.6 ≈ 17，按法抗减免后也有十几点
	if with-without < 8 {
		t.Fatalf("enchanted %v vs plain %v", with, without)
	}
}

func TestFrostSlowsTargets(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 0, 0, playerBase)
	monster := addTestEntity(world, 2, "monster", 60, 0, monsterBase)
	speed := monster.Attr.Speed
	frost := &config.Skill{ID: "frost", Kind: "aoe", Radius: 120, Damage: "magic", Ratio: 0.1, Base: 1,
		Debuff: &config.Buff{Name: "冰冻", Duration: 3, SpeedPct: -0.5, Look: "frost"}}
	if err := world.Combat.Cast(player, frost, 0); err != nil {
		t.Fatalf("frost: %v", err)
	}
	if monster.Attr.Speed != speed*0.5 || monster.Looks() != config.Looks["frost"] {
		t.Fatalf("speed %v (was %v), looks %v", monster.Attr.Speed, speed, monster.Looks())
	}
	if len(player.Buffs) != 0 {
		t.Fatal("caster got the debuff")
	}
}

func TestLoadoutOnlyAtJoinAndDeath(t *testing.T) {
	world := testWorld()
	cfg := world.State.Cfg
	for _, id := range []string{"slash", "fireball", "heal", "axe", "blink"} {
		cfg.Skills[id] = &config.Skill{ID: id, Name: id, Kind: "self"}
	}
	cfg.Skills["slash"] = slashSkill()
	cfg.World.Player.Skills = []string{"slash", "fireball", "heal"}
	cfg.World.Player.SkillPool = []string{"fireball", "heal", "axe", "blink"}
	cfg.World.Player.Respawn = 3
	session := world.Join()
	player := session.Player
	loadout := func(ids ...string) {
		world.Input(session, &pb.ClientMsg{Msg: &pb.ClientMsg_Loadout{Loadout: &pb.Loadout{Skills: ids}}})
	}
	ids := func() []string {
		var out []string
		for _, skill := range player.Skills {
			out = append(out, skill.ID)
		}
		return out
	}
	// 数量不对、重复、不在池子里的都不行
	for _, bad := range [][]string{{"axe"}, {"axe", "axe"}, {"axe", "slash"}} {
		loadout(bad...)
		if got := ids(); got[1] != "fireball" || got[2] != "heal" {
			t.Fatalf("bad loadout %v accepted: %v", bad, got)
		}
	}
	loadout("blink", "axe")
	if got := ids(); len(got) != 3 || got[0] != "slash" || got[1] != "blink" || got[2] != "axe" {
		t.Fatalf("loadout = %v", got)
	}
	// 放过技能之后就不能换了
	cast := &pb.ClientMsg{Msg: &pb.ClientMsg_Cast{Cast: &pb.Cast{Slot: proto.Int32(3), Dx: proto.Float32(1)}}}
	world.Input(session, cast)
	loadout("heal", "fireball")
	if got := ids(); got[1] != "blink" {
		t.Fatalf("loadout after casting accepted: %v", got)
	}
	// 死了又可以换
	world.Combat.Kill(player, nil)
	loadout("heal", "fireball")
	if got := ids(); got[1] != "heal" || got[2] != "fireball" {
		t.Fatalf("loadout while dead = %v", got)
	}
}
