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

// testWorld builds a 1000x1000 world from a small hand-written config: no
// spawns, no config files, and only the given obstacles.
func testWorld(obstacles ...nav.Shape) *World {
	cfg := &config.Config{Skills: map[string]*config.Skill{}, Templates: map[string]*config.Template{}}
	cfg.World.Map.Width, cfg.World.Map.Height, cfg.World.AOI.Cell = 1000, 1000, 200
	cfg.World.TickRate, cfg.World.SyncRate = 20, 10
	cfg.World.Hostile = map[string][]string{"player": {"monster"}, "monster": {"player"}}
	w, err := newWorld(cfg, 1, obstacles)
	if err != nil {
		panic(err)
	}
	return w
}

// addTestEntity places a living entity with radius 16 into w. "player" gets core.KindPlayer, anything else core.KindMonster.
func addTestEntity(w *World, id int, faction string, x, y float64, base config.Attrs) *core.Entity {
	e := &core.Entity{
		Identity:  core.Identity{ID: id, Kind: core.KindMonster, Faction: faction},
		Transform: core.Transform{X: x, Y: y, HomeX: x, HomeY: y, Radius: 16},
		Stats:     core.Stats{Level: 1, Base: base, Speed: 100},
		Combat:    core.Combat{Cooldowns: map[string]float64{}},
	}
	if faction == "player" {
		e.Kind = core.KindPlayer
	}
	attr.Init(e)
	w.State.Ents.Add(e)
	w.Grid.Add(e)
	return e
}

func slashSkill() *config.Skill {
	return &config.Skill{ID: "slash", Name: "斩击", Kind: "target", Range: 70, Cooldown: 0.7, Damage: "physical", Ratio: 1, Base: 4, FX: "melee"}
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
	for _, f := range fields {
		if math.Abs(f.got-f.want) > 1e-9 {
			t.Errorf("%s = %v, want %v", f.name, f.got, f.want)
		}
	}
}

func TestComputeDerived(t *testing.T) {
	base := config.Attrs{Str: 10, Agi: 10, Int: 10, Vit: 10}
	checkDerived(t, attr.Compute(base, 100, nil), core.Derived{
		MaxHP: 220, Atk: 33, MAtk: 33, Def: 19, MDef: 19, Crit: 0.09, CritDmg: 1.55, Speed: 100,
	})

	// Two buffs: Atk/MAtk x1.5, Def/MDef x1.1, Speed x1.25.
	buffs := []*core.Buff{
		{Cfg: &config.Buff{AtkPct: 0.4, DefPct: 0.1, SpeedPct: 0.25}, Until: 10},
		{Cfg: &config.Buff{AtkPct: 0.1}, Until: 10},
	}
	checkDerived(t, attr.Compute(base, 100, buffs), core.Derived{
		MaxHP: 220, Atk: 49.5, MAtk: 49.5, Def: 20.9, MDef: 20.9, Crit: 0.09, CritDmg: 1.55, Speed: 125,
	})
}

func TestRecalcKeepsHPRatio(t *testing.T) {
	w := testWorld()
	p := addTestEntity(w, 1, "player", 0, 0, playerBase) // MaxHP 220
	p.HP = p.Attr.MaxHP / 2
	p.Base.Vit += 5 // MaxHP +60 -> 280
	attr.Recalc(p)
	if p.Attr.MaxHP != 280 {
		t.Fatalf("MaxHP = %v, want 280", p.Attr.MaxHP)
	}
	if math.Abs(p.HP-140) > 1e-9 {
		t.Errorf("HP = %v, want 140 (half of the new MaxHP)", p.HP)
	}
}

func TestTargetOutOfRange(t *testing.T) {
	w := testWorld()
	p := addTestEntity(w, 1, "player", 0, 0, playerBase)
	m := addTestEntity(w, 2, "monster", 500, 0, monsterBase)
	if err := w.Combat.Cast(p, slashSkill(), m.ID); err != combat.ErrTooFar {
		t.Fatalf("err = %v, want %v", err, combat.ErrTooFar)
	}
	if m.HP != m.Attr.MaxHP {
		t.Errorf("out-of-range cast damaged target: HP = %v", m.HP)
	}
}

func TestCooldownBlocksRecast(t *testing.T) {
	w := testWorld()
	p := addTestEntity(w, 1, "player", 0, 0, playerBase)
	m := addTestEntity(w, 2, "monster", 60, 0, monsterBase) // edge distance 28, within range 70
	sk := slashSkill()
	if err := w.Combat.Cast(p, sk, m.ID); err != nil {
		t.Fatalf("first cast: %v", err)
	}
	if err := w.Combat.Cast(p, sk, m.ID); err != combat.ErrCooldown {
		t.Fatalf("second cast err = %v, want %v", err, combat.ErrCooldown)
	}
	w.State.Clock.Now = sk.Cooldown
	if err := w.Combat.Cast(p, sk, m.ID); err != nil {
		t.Errorf("cast after cooldown: %v", err)
	}
}

func TestDamageSetsLastAttacker(t *testing.T) {
	w := testWorld()
	p := addTestEntity(w, 1, "player", 0, 0, playerBase)
	m := addTestEntity(w, 2, "monster", 60, 0, monsterBase)
	w.State.Clock.Now = 3

	sk := slashSkill()
	if dmg, _ := w.Combat.CalcDamage(p, m, sk); dmg < 1 || dmg != math.Round(dmg) {
		t.Fatalf("CalcDamage = %v, want a whole number >= 1", dmg)
	}
	if err := w.Combat.Cast(p, sk, m.ID); err != nil {
		t.Fatalf("cast: %v", err)
	}
	if m.HP >= m.Attr.MaxHP {
		t.Errorf("HP = %v, want less than MaxHP %v", m.HP, m.Attr.MaxHP)
	}
	if m.LastAttacker != p.ID || m.LastHitAt != 3 {
		t.Errorf("LastAttacker = %d, LastHitAt = %v; want %d, 3", m.LastAttacker, m.LastHitAt, p.ID)
	}
	if len(w.State.Events.List()) < 2 || w.State.Events.List()[0].Ev.GetKind() != pb.EventKind_CAST || w.State.Events.List()[1].Ev.GetKind() != pb.EventKind_DAMAGE {
		t.Errorf("events = %v, want cast then dmg", w.State.Events.List())
	}
}

func TestAOEHitsOnlyHostileInRadius(t *testing.T) {
	w := testWorld()
	p := addTestEntity(w, 1, "player", 500, 500, playerBase)
	near := addTestEntity(w, 2, "monster", 550, 500, monsterBase) // edge distance 18: hit
	side := addTestEntity(w, 3, "monster", 500, 620, monsterBase) // edge distance 88: hit
	far := addTestEntity(w, 4, "monster", 500, 660, monsterBase)  // edge distance 128: miss
	ally := addTestEntity(w, 5, "player", 520, 500, playerBase)   // in range but not hostile: miss
	whirl := &config.Skill{ID: "whirlwind", Name: "旋风斩", Kind: "aoe", Radius: 110, Cooldown: 5, Damage: "physical", Ratio: 1.2, Base: 6, FX: "circle"}

	if err := w.Combat.Cast(p, whirl, 0); err != nil {
		t.Fatalf("aoe cast: %v", err)
	}
	for _, tc := range []struct {
		name string
		e    *core.Entity
		hit  bool
	}{{"near", near, true}, {"side", side, true}, {"far", far, false}, {"ally", ally, false}} {
		if hurt := tc.e.HP < tc.e.Attr.MaxHP; hurt != tc.hit {
			t.Errorf("%s: hurt = %v, want %v", tc.name, hurt, tc.hit)
		}
	}
}

func TestAOESucceedsWithoutTargets(t *testing.T) {
	w := testWorld()
	p := addTestEntity(w, 1, "player", 500, 500, playerBase)
	whirl := &config.Skill{ID: "whirlwind", Kind: "aoe", Radius: 110, Cooldown: 5, Damage: "physical", Ratio: 1.2, Base: 6}
	if err := w.Combat.Cast(p, whirl, 0); err != nil {
		t.Errorf("aoe with no targets: %v", err)
	}
	if p.Cooldowns["whirlwind"] != 5 {
		t.Errorf("cooldown = %v, want 5", p.Cooldowns["whirlwind"])
	}
}

func TestHealClampsToMaxHP(t *testing.T) {
	w := testWorld()
	p := addTestEntity(w, 1, "player", 0, 0, playerBase)
	heal := &config.Skill{ID: "heal", Kind: "self", Cooldown: 8, Heal: 0.35, FX: "heal"}
	p.HP = p.Attr.MaxHP - 5
	if err := w.Combat.Cast(p, heal, 0); err != nil {
		t.Fatalf("cast: %v", err)
	}
	if p.HP != p.Attr.MaxHP {
		t.Errorf("HP = %v, want clamped to MaxHP %v", p.HP, p.Attr.MaxHP)
	}
}

func TestBuffAppliesAndExpires(t *testing.T) {
	w := testWorld()
	p := addTestEntity(w, 1, "player", 0, 0, playerBase)
	warcry := &config.Skill{ID: "warcry", Kind: "self", Cooldown: 15, FX: "buff",
		Buff: &config.Buff{Name: "战吼", Duration: 6, AtkPct: 0.4, SpeedPct: 0.25}}
	baseAtk := p.Attr.Atk

	if err := w.Combat.Cast(p, warcry, 0); err != nil {
		t.Fatalf("cast: %v", err)
	}
	if len(p.Buffs) != 1 || math.Abs(p.Attr.Atk-baseAtk*1.4) > 1e-9 {
		t.Fatalf("after cast: %d buffs, Atk = %v; want 1 buff, Atk = %v", len(p.Buffs), p.Attr.Atk, baseAtk*1.4)
	}
	w.State.Clock.Now = 5
	w.Combat.UpdateBuffs(p)
	if len(p.Buffs) != 1 {
		t.Errorf("buff expired early at t=5")
	}
	w.State.Clock.Now = 6
	w.Combat.UpdateBuffs(p)
	if len(p.Buffs) != 0 || p.Attr.Atk != baseAtk {
		t.Errorf("after expiry: %d buffs, Atk = %v; want 0 buffs, Atk = %v", len(p.Buffs), p.Attr.Atk, baseAtk)
	}
}

func TestBuffRecastRefreshes(t *testing.T) {
	w := testWorld()
	p := addTestEntity(w, 1, "player", 0, 0, playerBase)
	warcry := &config.Skill{ID: "warcry", Kind: "self", Cooldown: 15, FX: "buff",
		Buff: &config.Buff{Name: "战吼", Duration: 6, AtkPct: 0.4}}
	if err := w.Combat.Cast(p, warcry, 0); err != nil {
		t.Fatalf("first cast: %v", err)
	}
	w.State.Clock.Now = 15
	if err := w.Combat.Cast(p, warcry, 0); err != nil {
		t.Fatalf("recast: %v", err)
	}
	if len(p.Buffs) != 1 || p.Buffs[0].Until != 21 {
		t.Errorf("buffs = %d (Until %v), want 1 buff refreshed to Until 21", len(p.Buffs), p.Buffs[0].Until)
	}
}

func TestGainExpLevelsUp(t *testing.T) {
	w := testWorld()
	p := addTestEntity(w, 1, "player", 0, 0, playerBase)
	p.Growth = config.Attrs{Str: 2, Agi: 1.5, Int: 1.5, Vit: 2}

	w.Attr.GainExp(p, 100) // exactly enough for level 2
	if p.Level != 2 || p.Exp != 0 || p.Base.Str != 12 {
		t.Fatalf("after 100 exp: level %d, exp %d, str %v; want 2, 0, 12", p.Level, p.Exp, p.Base.Str)
	}

	p.HP = 1
	w.Attr.GainExp(p, 250) // 200 for level 3, 50 left over
	if p.Level != 3 || p.Exp != 50 || p.Base.Str != 14 {
		t.Errorf("after 250 exp: level %d, exp %d, str %v; want 3, 50, 14", p.Level, p.Exp, p.Base.Str)
	}
	if p.HP != p.Attr.MaxHP {
		t.Errorf("HP = %v after level up, want MaxHP %v", p.HP, p.Attr.MaxHP)
	}
}

// A monster killed by a player grants exp, lies dead until its respawn time,
// then comes back at home with full HP.
func TestKillGrantsExpAndRespawns(t *testing.T) {
	w := testWorld()
	p := addTestEntity(w, 1, "player", 500, 500, playerBase)
	m := addTestEntity(w, 2, "monster", 540, 500, monsterBase)
	m.Tmpl = &config.Template{Respawn: 2, Exp: 30}
	w.Combat.Kill(m, p)
	if !m.Dead || m.HP != 0 || p.Exp != 30 {
		t.Fatalf("dead %v hp %v exp %v", m.Dead, m.HP, p.Exp)
	}
	w.Combat.Kill(m, p) // killing the dead does nothing
	if p.Exp != 30 {
		t.Fatalf("exp granted twice: %v", p.Exp)
	}
	for w.State.Clock.Now < 1.9 {
		w.Step()
	}
	if !m.Dead {
		t.Fatal("respawned early")
	}
	for w.State.Clock.Now < 2.1 {
		w.Step()
	}
	if m.Dead || m.HP != m.Attr.MaxHP || m.X != m.HomeX || m.Y != m.HomeY {
		t.Fatalf("after respawn dead %v hp %v/%v at %v,%v", m.Dead, m.HP, m.Attr.MaxHP, m.X, m.Y)
	}
}

// Only a player killer earns exp.
func TestMonsterKillerGetsNoExp(t *testing.T) {
	w := testWorld()
	a := addTestEntity(w, 1, "monster", 500, 500, monsterBase)
	b := addTestEntity(w, 2, "monster", 540, 500, monsterBase)
	b.Tmpl = &config.Template{Respawn: 2, Exp: 30}
	w.Combat.Kill(b, a)
	if a.Exp != 0 {
		t.Fatalf("monster got exp %v", a.Exp)
	}
}
