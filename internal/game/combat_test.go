package game

import (
	"github.com/qinbaixi/BtDemo/internal/game/attr"
	"github.com/qinbaixi/BtDemo/internal/game/combat"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"math"
	"testing"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

var (
	playerBase  = config.Attrs{Str: 10, Agi: 8, Int: 8, Vit: 10}
	monsterBase = config.Attrs{Str: 6, Agi: 4, Int: 2, Vit: 8}
)

// testWorld 使用一份手写的小型配置构建 1000x1000 的世界：没有刷怪点，不读取配置文件，
// 只包含给定的障碍物。
func testWorld(obstacles ...nav.Shape) *World {
	cfg := &config.Config{
		Skills:    map[string]*config.Skill{},
		Templates: map[string]*config.Template{},
	}
	cfg.World.Map.Width, cfg.World.Map.Height, cfg.World.AOI.Cell = 1000, 1000, 200
	cfg.World.TickRate, cfg.World.SyncRate = 20, 10
	cfg.World.Hostile = map[string][]string{"player": {"monster"}, "monster": {"player"}}
	world, err := newWorld(cfg, 1, obstacles)
	if err != nil {
		panic(err)
	}
	return world
}

// addTestEntity 在 world 中放入一个半径为 16 的存活实体。"player" 的 Kind 为 core.KindPlayer，其余为 core.KindMonster。
func addTestEntity(
	world *World,
	id int,
	faction string,
	x, y float64,
	base config.Attrs,
) *core.Entity {
	entity := &core.Entity{
		Identity:  core.Identity{ID: id, Kind: core.KindMonster, Faction: faction},
		Transform: core.Transform{X: x, Y: y, HomeX: x, HomeY: y, Radius: 16},
		Stats:     core.Stats{Level: 1, Base: base, Speed: 100},
		Combat:    core.Combat{Cooldowns: map[string]float64{}},
	}
	if faction == "player" {
		entity.Kind = core.KindPlayer
	}
	attr.Init(entity)
	world.State.Ents.Add(entity)
	world.Grid.Add(entity)
	return entity
}

func slashSkill() *config.Skill {
	return &config.Skill{
		ID:       "slash",
		Name:     "斩击",
		Kind:     "target",
		Range:    70,
		Cooldown: 0.7,
		Damage:   "physical",
		Ratio:    1,
		Base:     4,
		FX:       "melee",
	}
}

func checkDerived(t *testing.T, got, want core.Derived) {
	t.Helper()
	fields := []struct {
		name      string
		got, want float64
	}{
		{"MaxHP", got.MaxHP, want.MaxHP}, {"Atk", got.Atk, want.Atk}, {"MAtk", got.MAtk, want.MAtk},
		{"Def", got.Def, want.Def}, {"MDef", got.MDef, want.MDef}, {"Crit", got.Crit, want.Crit},
		{"CritDmg", got.CritDmg, want.CritDmg}, {"Speed", got.Speed, want.Speed},
	}
	for _, field := range fields {
		if math.Abs(field.got-field.want) > 1e-9 {
			t.Errorf("%s = %v, want %v", field.name, field.got, field.want)
		}
	}
}

func TestComputeDerived(t *testing.T) {
	base := config.Attrs{Str: 10, Agi: 10, Int: 10, Vit: 10}
	checkDerived(t, attr.Compute(base, 100, nil), core.Derived{
		MaxHP: 220, Atk: 33, MAtk: 33, Def: 19, MDef: 19, Crit: 0.09, CritDmg: 1.55, Speed: 100,
	})

	// 两个 Buff：Atk/MAtk 乘以 1.5，Def/MDef 乘以 1.1，Speed 乘以 1.25。
	buffs := []*core.Buff{
		{Cfg: &config.Buff{AtkPct: 0.4, DefPct: 0.1, SpeedPct: 0.25}, Until: 10},
		{Cfg: &config.Buff{AtkPct: 0.1}, Until: 10},
	}
	checkDerived(t, attr.Compute(base, 100, buffs), core.Derived{
		MaxHP: 220, Atk: 49.5, MAtk: 49.5, Def: 20.9, MDef: 20.9, Crit: 0.09, CritDmg: 1.55, Speed: 125,
	})
}

func TestRecalcKeepsHPRatio(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 0, 0, playerBase) // MaxHP 220
	player.HP = player.Attr.MaxHP / 2
	player.Base.Vit += 5 // MaxHP 增加 60 -> 280
	attr.Recalc(player)
	if player.Attr.MaxHP != 280 {
		t.Fatalf("MaxHP = %v, want 280", player.Attr.MaxHP)
	}
	if math.Abs(player.HP-140) > 1e-9 {
		t.Errorf("HP = %v, want 140 (half of the new MaxHP)", player.HP)
	}
}

func TestTargetOutOfRange(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 0, 0, playerBase)
	monster := addTestEntity(world, 2, "monster", 500, 0, monsterBase)
	if err := world.Combat.Cast(player, slashSkill(), monster.ID); err != combat.ErrTooFar {
		t.Fatalf("err = %v, want %v", err, combat.ErrTooFar)
	}
	if monster.HP != monster.Attr.MaxHP {
		t.Errorf("out-of-range cast damaged target: HP = %v", monster.HP)
	}
}

func TestCooldownBlocksRecast(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 0, 0, playerBase)
	monster := addTestEntity(world, 2, "monster", 60, 0, monsterBase) // 边缘距离 28，在范围 70 之内
	skill := slashSkill()
	if err := world.Combat.Cast(player, skill, monster.ID); err != nil {
		t.Fatalf("first cast: %v", err)
	}
	if err := world.Combat.Cast(player, skill, monster.ID); err != combat.ErrCooldown {
		t.Fatalf("second cast err = %v, want %v", err, combat.ErrCooldown)
	}
	world.State.Clock.Now = skill.Cooldown
	if err := world.Combat.Cast(player, skill, monster.ID); err != nil {
		t.Errorf("cast after cooldown: %v", err)
	}
}

func TestDamageSetsLastAttacker(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 0, 0, playerBase)
	monster := addTestEntity(world, 2, "monster", 60, 0, monsterBase)
	world.State.Clock.Now = 3

	skill := slashSkill()
	if dmg, _ := world.Combat.CalcDamage(player, monster, skill); dmg < 1 ||
		dmg != math.Round(dmg) {
		t.Fatalf("CalcDamage = %v, want a whole number >= 1", dmg)
	}
	if err := world.Combat.Cast(player, skill, monster.ID); err != nil {
		t.Fatalf("cast: %v", err)
	}
	if monster.HP >= monster.Attr.MaxHP {
		t.Errorf("HP = %v, want less than MaxHP %v", monster.HP, monster.Attr.MaxHP)
	}
	if monster.LastAttacker != player.ID || monster.LastHitAt != 3 {
		t.Errorf(
			"LastAttacker = %d, LastHitAt = %v; want %d, 3",
			monster.LastAttacker,
			monster.LastHitAt,
			player.ID,
		)
	}
	if len(world.State.Events.List()) < 2 ||
		world.State.Events.List()[0].Event.GetKind() != pb.EventKind_CAST ||
		world.State.Events.List()[1].Event.GetKind() != pb.EventKind_DAMAGE {
		t.Errorf("events = %v, want cast then dmg", world.State.Events.List())
	}
}

func TestAOEHitsOnlyHostileInRadius(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 500, 500, playerBase)
	near := addTestEntity(world, 2, "monster", 550, 500, monsterBase) // 边缘距离 18：命中
	side := addTestEntity(world, 3, "monster", 500, 620, monsterBase) // 边缘距离 88：命中
	far := addTestEntity(world, 4, "monster", 500, 660, monsterBase)  // 边缘距离 128：未命中
	ally := addTestEntity(world, 5, "player", 520, 500, playerBase)   // 在范围内但不是敌对目标：未命中
	whirl := &config.Skill{
		ID:       "whirlwind",
		Name:     "旋风斩",
		Kind:     "aoe",
		Radius:   110,
		Cooldown: 5,
		Damage:   "physical",
		Ratio:    1.2,
		Base:     6,
		FX:       "circle",
	}

	if err := world.Combat.Cast(player, whirl, 0); err != nil {
		t.Fatalf("aoe cast: %v", err)
	}
	for _, tc := range []struct {
		name   string
		entity *core.Entity
		hit    bool
	}{{"near", near, true}, {"side", side, true}, {"far", far, false}, {"ally", ally, false}} {
		if hurt := tc.entity.HP < tc.entity.Attr.MaxHP; hurt != tc.hit {
			t.Errorf("%s: hurt = %v, want %v", tc.name, hurt, tc.hit)
		}
	}
}

func TestAOESucceedsWithoutTargets(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 500, 500, playerBase)
	whirl := &config.Skill{
		ID:       "whirlwind",
		Kind:     "aoe",
		Radius:   110,
		Cooldown: 5,
		Damage:   "physical",
		Ratio:    1.2,
		Base:     6,
	}
	if err := world.Combat.Cast(player, whirl, 0); err != nil {
		t.Errorf("aoe with no targets: %v", err)
	}
	if player.Cooldowns["whirlwind"] != 5 {
		t.Errorf("cooldown = %v, want 5", player.Cooldowns["whirlwind"])
	}
}

func TestHealClampsToMaxHP(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 0, 0, playerBase)
	heal := &config.Skill{ID: "heal", Kind: "self", Cooldown: 8, Heal: 0.35, FX: "heal"}
	player.HP = player.Attr.MaxHP - 5
	if err := world.Combat.Cast(player, heal, 0); err != nil {
		t.Fatalf("cast: %v", err)
	}
	if player.HP != player.Attr.MaxHP {
		t.Errorf("HP = %v, want clamped to MaxHP %v", player.HP, player.Attr.MaxHP)
	}
}

func TestBuffAppliesAndExpires(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 0, 0, playerBase)
	warcry := &config.Skill{ID: "warcry", Kind: "self", Cooldown: 15, FX: "buff",
		Buff: &config.Buff{Name: "战吼", Duration: 6, AtkPct: 0.4, SpeedPct: 0.25}}
	baseAtk := player.Attr.Atk

	if err := world.Combat.Cast(player, warcry, 0); err != nil {
		t.Fatalf("cast: %v", err)
	}
	if len(player.Buffs) != 1 || math.Abs(player.Attr.Atk-baseAtk*1.4) > 1e-9 {
		t.Fatalf(
			"after cast: %d buffs, Atk = %v; want 1 buff, Atk = %v",
			len(player.Buffs),
			player.Attr.Atk,
			baseAtk*1.4,
		)
	}
	world.State.Clock.Now = 5
	world.Combat.UpdateBuffs(player)
	if len(player.Buffs) != 1 {
		t.Errorf("buff expired early at t=5")
	}
	world.State.Clock.Now = 6
	world.Combat.UpdateBuffs(player)
	if len(player.Buffs) != 0 || player.Attr.Atk != baseAtk {
		t.Errorf(
			"after expiry: %d buffs, Atk = %v; want 0 buffs, Atk = %v",
			len(player.Buffs),
			player.Attr.Atk,
			baseAtk,
		)
	}
}

func TestBuffRecastRefreshes(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 0, 0, playerBase)
	warcry := &config.Skill{ID: "warcry", Kind: "self", Cooldown: 15, FX: "buff",
		Buff: &config.Buff{Name: "战吼", Duration: 6, AtkPct: 0.4}}
	if err := world.Combat.Cast(player, warcry, 0); err != nil {
		t.Fatalf("first cast: %v", err)
	}
	world.State.Clock.Now = 15
	if err := world.Combat.Cast(player, warcry, 0); err != nil {
		t.Fatalf("recast: %v", err)
	}
	if len(player.Buffs) != 1 || player.Buffs[0].Until != 21 {
		t.Errorf(
			"buffs = %d (Until %v), want 1 buff refreshed to Until 21",
			len(player.Buffs),
			player.Buffs[0].Until,
		)
	}
}

func TestGainExpLevelsUp(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 0, 0, playerBase)
	player.Growth = config.Attrs{Str: 2, Agi: 1.5, Int: 1.5, Vit: 2}

	world.Attr.GainExp(player, 100) // 恰好够升到 2 级
	if player.Level != 2 || player.Exp != 0 || player.Base.Str != 12 {
		t.Fatalf(
			"after 100 exp: level %d, exp %d, str %v; want 2, 0, 12",
			player.Level,
			player.Exp,
			player.Base.Str,
		)
	}

	player.HP = 1
	world.Attr.GainExp(player, 250) // 升到 3 级需要 200，剩余 50
	if player.Level != 3 || player.Exp != 50 || player.Base.Str != 14 {
		t.Errorf(
			"after 250 exp: level %d, exp %d, str %v; want 3, 50, 14",
			player.Level,
			player.Exp,
			player.Base.Str,
		)
	}
	if player.HP != player.Attr.MaxHP {
		t.Errorf("HP = %v after level up, want MaxHP %v", player.HP, player.Attr.MaxHP)
	}
}

// 被玩家击杀的怪物会给予经验，在重生时间到达前保持死亡状态，然后回到家中并恢复满血。
func TestKillGrantsExpAndRespawns(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 500, 500, playerBase)
	monster := addTestEntity(world, 2, "monster", 540, 500, monsterBase)
	monster.Tmpl = &config.Template{Respawn: 2, Exp: 30}
	world.Combat.Kill(monster, player)
	if !monster.Dead || monster.HP != 0 || player.Exp != 30 {
		t.Fatalf("dead %v hp %v exp %v", monster.Dead, monster.HP, player.Exp)
	}
	world.Combat.Kill(monster, player) // 杀死已死亡的实体不会有任何效果
	if player.Exp != 30 {
		t.Fatalf("exp granted twice: %v", player.Exp)
	}
	for world.State.Clock.Now < 1.9 {
		world.Step()
	}
	if !monster.Dead {
		t.Fatal("respawned early")
	}
	for world.State.Clock.Now < 2.1 {
		world.Step()
	}
	if monster.Dead || monster.HP != monster.Attr.MaxHP || monster.X != monster.HomeX ||
		monster.Y != monster.HomeY {
		t.Fatalf(
			"after respawn dead %v hp %v/%v at %v,%v",
			monster.Dead,
			monster.HP,
			monster.Attr.MaxHP,
			monster.X,
			monster.Y,
		)
	}
}

// 只有玩家击杀者才能获得经验。
func TestMonsterKillerGetsNoExp(t *testing.T) {
	world := testWorld()
	first := addTestEntity(world, 1, "monster", 500, 500, monsterBase)
	second := addTestEntity(world, 2, "monster", 540, 500, monsterBase)
	second.Tmpl = &config.Template{Respawn: 2, Exp: 30}
	world.Combat.Kill(second, first)
	if first.Exp != 0 {
		t.Fatalf("monster got exp %v", first.Exp)
	}
}

// lastDamage 返回最后一个伤害事件。
func lastDamage(world *World) *pb.Event {
	var event *pb.Event
	for _, pending := range world.State.Events.List() {
		if pending.Event.GetKind() == pb.EventKind_DAMAGE {
			event = pending.Event
		}
	}
	return event
}

func TestBlockReducesDamage(t *testing.T) {
	world := testWorld()
	world.State.Cfg.World.Player.Block = config.Block{Reduce: 0.8, Speed: 0.5}
	player := addTestEntity(world, 1, "player", 0, 0, playerBase)
	monster := addTestEntity(world, 2, "monster", 60, 0, monsterBase)
	big := &config.Skill{ID: "big", Kind: "target", Range: 70, Damage: "physical", Base: 1000}
	player.Blocking = true
	if err := world.Combat.Cast(monster, big, player.ID); err != nil {
		t.Fatalf("cast: %v", err)
	}
	event := lastDamage(world)
	total := float64(event.GetValue() + event.GetBlocked())
	if math.Abs(float64(event.GetBlocked())-math.Round(total*0.8)) > 0.5 ||
		player.HP != player.Attr.MaxHP-float64(event.GetValue()) {
		t.Fatalf(
			"blocked %v of %v, HP %v/%v",
			event.GetBlocked(),
			total,
			player.HP,
			player.Attr.MaxHP,
		)
	}
	// 格挡时不能出招
	if err := world.Combat.Cast(player, slashSkill(), monster.ID); err != combat.ErrBlocking {
		t.Fatalf("cast while blocking: %v, want ErrBlocking", err)
	}
}

func TestShieldAbsorbsThenBreaks(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 0, 0, playerBase)
	monster := addTestEntity(world, 2, "monster", 60, 0, monsterBase)
	shield := &config.Skill{ID: "shield", Kind: "self", Cooldown: 14, FX: "shield",
		Buff: &config.Buff{Name: "护盾", Duration: 8, ShieldPct: 0.3}}
	if err := world.Combat.Cast(player, shield, 0); err != nil {
		t.Fatalf("cast: %v", err)
	}
	want := math.Round(player.Attr.MaxHP * 0.3)
	if player.Shield() != want {
		t.Fatalf("shield = %v, want %v", player.Shield(), want)
	}
	// 小伤害全被吸收
	small := &config.Skill{ID: "small", Kind: "target", Range: 70, Damage: "physical", Base: 5}
	if err := world.Combat.Cast(monster, small, player.ID); err != nil {
		t.Fatalf("cast: %v", err)
	}
	if event := lastDamage(world); event.GetValue() != 0 || player.HP != player.Attr.MaxHP ||
		player.Shield() != want-float64(event.GetAbsorbed()) {
		t.Fatalf(
			"after small hit: value %v absorbed %v HP %v shield %v",
			event.GetValue(),
			event.GetAbsorbed(),
			player.HP,
			player.Shield(),
		)
	}
	// 大伤害打破护盾，剩下的扣血，护盾 Buff 消失
	left := player.Shield()
	big := &config.Skill{ID: "big", Kind: "target", Range: 70, Damage: "physical", Base: 1000}
	if err := world.Combat.Cast(monster, big, player.ID); err != nil {
		t.Fatalf("cast: %v", err)
	}
	event := lastDamage(world)
	if float64(event.GetAbsorbed()) != left || player.Shield() != 0 || len(player.Buffs) != 0 {
		t.Fatalf(
			"after big hit: absorbed %v (want %v), shield %v, buffs %d",
			event.GetAbsorbed(),
			left,
			player.Shield(),
			len(player.Buffs),
		)
	}
}
