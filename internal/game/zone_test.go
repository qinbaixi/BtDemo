package game

import (
	"testing"


	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 回血区的测试：技能放的法阵给友方回血、到点消失、重放替换旧的；常驻泉水；同步给客户端。

func healingSpring() *config.Skill {
	return &config.Skill{
		ID:       "healing_spring",
		Kind:     "zone",
		Cooldown: 40,
		FX:       "zone",
		Zone:     &config.Zone{Name: "治愈之泉", Radius: 100, Heal: 0.1, Interval: 1, Duration: 60},
	}
}

// stepSeconds 让世界跑 seconds 秒。
func stepSeconds(world *World, seconds float64) {
	for range int(seconds * float64(world.State.Cfg.World.TickRate)) {
		world.Step()
	}
}

func TestZoneSkillHealsFriendsOnly(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 500, 500, playerBase)
	inside := addTestEntity(world, 2, "player", 560, 500, playerBase)
	outside := addTestEntity(world, 3, "player", 700, 500, playerBase)
	// 区域是压扁的椭圆：正下方 70 像素已经在外面了（纵向半径 100 × 0.6 = 60）
	below := addTestEntity(world, 5, "player", 500, 570, playerBase)
	monster := addTestEntity(world, 4, "monster", 520, 520, monsterBase)
	player.HP, inside.HP, outside.HP, below.HP, monster.HP = 10, 10, 10, 10, 10
	if err := world.Combat.Cast(player, healingSpring(), 0); err != nil {
		t.Fatalf("cast: %v", err)
	}
	if cast := lastCast(world); cast.GetRadius() != 100 || cast.GetX() != 500 {
		t.Fatalf("cast event radius %v at x %v", cast.GetRadius(), cast.GetX())
	}
	if zones := world.State.Zones.List(); len(zones) != 1 || zones[0].Owner != player.ID {
		t.Fatalf("zones after cast: %+v", zones)
	}
	stepSeconds(world, 1.01)
	wantHP := 10 + float64(int(player.Attr.MaxHP*0.1+0.5))
	if player.HP != wantHP || inside.HP != wantHP {
		t.Fatalf("after 1s HP player %v inside %v, want %v", player.HP, inside.HP, wantHP)
	}
	if outside.HP != 10 || below.HP != 10 || monster.HP != 10 {
		t.Fatalf("outside %v below %v monster %v should not heal", outside.HP, below.HP, monster.HP)
	}
	// 回满之后不再回，也不超过上限
	stepSeconds(world, 20)
	if player.HP != player.Attr.MaxHP {
		t.Fatalf("after 20s HP %v, want full %v", player.HP, player.Attr.MaxHP)
	}
	// 60 秒到了就消失
	stepSeconds(world, 40)
	if len(world.State.Zones.List()) != 0 {
		t.Fatalf("zone still there after 61s")
	}
}

func TestZoneRecastReplacesOld(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 300, 300, playerBase)
	other := addTestEntity(world, 2, "player", 700, 700, playerBase)
	skill := healingSpring()
	for _, caster := range []int{player.ID, other.ID, player.ID} {
		entity := world.Get(caster)
		entity.Cooldowns = map[string]float64{}
		if err := world.Combat.Cast(entity, skill, 0); err != nil {
			t.Fatalf("cast: %v", err)
		}
	}
	zones := world.State.Zones.List()
	if len(zones) != 2 || zones[0].Owner != other.ID || zones[1].Owner != player.ID {
		t.Fatalf("zones: %+v", zones)
	}
}

func TestSpawnSpringAndSync(t *testing.T) {
	cfg := testWorld().State.Cfg
	cfg.World.HealZones = []*config.Zone{
		{Name: "生命之泉", X: 200, Y: 200, Radius: 120, Heal: 0.05, Interval: 1, Faction: "player", Look: "spring"},
	}
	world, err := newWorld(cfg, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	player := addTestEntity(world, 100, "player", 210, 200, playerBase)
	player.HP = 1
	stepSeconds(world, 1.01)
	if player.HP <= 1 {
		t.Fatalf("spawn spring did not heal: HP %v", player.HP)
	}
	// 客户端连上来先拿到整份列表，之后没变化就不再重发
	client := world.Join()
	world.Sessions.Flush()
	first := lastZones(t, client)
	if first == nil || len(first.GetZones()) != 1 || first.GetZones()[0].GetLook() != "spring" {
		t.Fatalf("first sync zones: %v", first)
	}
	world.Sessions.Flush()
	if again := lastZones(t, client); again != nil {
		t.Fatalf("zones resent without a change")
	}
}

// lastZones 取出会话收到的最后一份回血区列表，没收到返回 nil。
func lastZones(t *testing.T, client *Session) *pb.ZoneList {
	t.Helper()
	var zones *pb.ZoneList
	for _, msg := range sentMessages(t, client) {
		if msg.GetZones() != nil {
			zones = msg.GetZones()
		}
	}
	return zones
}
