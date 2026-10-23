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

// 游侠职业：穿透射击、箭雨、换职业和不能格挡的测试。

func pierceSkill() *config.Skill {
	return &config.Skill{
		ID:     "pierce_shot",
		Name:   "穿云箭",
		Kind:   "line",
		Pierce: true,
		Range:  380,
		Damage: "physical",
		Ratio:  1,
		Base:   5,
		FX:     "pierce",
	}
}

func rainSkill() *config.Skill {
	return &config.Skill{
		ID:       "arrow_rain",
		Name:     "箭雨",
		Kind:     "rain",
		Range:    260,
		Radius:   90,
		Distance: 180,
		Damage:   "physical",
		Ratio:    1,
		Base:     5,
		FX:       "rain",
	}
}

// damagedIDs 按事件顺序返回受到伤害的实体 id。
func damagedIDs(world *World) []int {
	var ids []int
	for _, pending := range world.State.Events.List() {
		if pending.Event.GetKind() == pb.EventKind_DAMAGE {
			ids = append(ids, int(pending.Event.GetDst()))
		}
	}
	return ids
}

func TestPierceHitsEveryEnemyInOrder(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 100, 500, playerBase)
	// 故意让 id 和沿线顺序不一致
	far := addTestEntity(world, 2, "monster", 350, 500, monsterBase)
	near := addTestEntity(world, 3, "monster", 200, 505, monsterBase)
	middle := addTestEntity(world, 4, "monster", 280, 495, monsterBase)
	aside := addTestEntity(world, 5, "monster", 250, 600, monsterBase)
	behind := addTestEntity(world, 6, "monster", 20, 500, monsterBase)
	if err := world.Combat.CastAimed(player, pierceSkill(), 0, 1, 0); err != nil {
		t.Fatalf("pierce: %v", err)
	}
	got := damagedIDs(world)
	want := []int{near.ID, middle.ID, far.ID}
	if len(got) != len(want) {
		t.Fatalf("damaged %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("damaged %v, want %v", got, want)
		}
	}
	if aside.HP != aside.Attr.MaxHP || behind.HP != behind.Attr.MaxHP {
		t.Fatal("pierce hit an enemy off the line")
	}
	event := lastCast(world)
	if int(event.GetDst()) != near.ID {
		t.Fatalf("cast dst = %d, want the first hit %d", event.GetDst(), near.ID)
	}
	// 不因命中停下：终点在射程尽头（身体边缘出手，所以是 range + 半径）
	if math.Abs(float64(event.GetTx())-(100+380+player.Radius)) > 1 {
		t.Fatalf("pierce ended at x = %v", event.GetTx())
	}
}

func TestPierceMissHasNoDst(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 500, 500, playerBase)
	if err := world.Combat.CastAimed(player, pierceSkill(), 0, 0, 1); err != nil {
		t.Fatalf("pierce: %v", err)
	}
	if event := lastCast(world); event.Dst != nil || len(damagedIDs(world)) != 0 {
		t.Fatalf("missed pierce: dst %v", event.GetDst())
	}
	if err := world.Combat.CastAimed(player, pierceSkill(), 0, 0, 0); err != combat.ErrNoAim {
		t.Fatalf("pierce without aim: %v, want ErrNoAim", err)
	}
}

func TestPierceStoppedByWall(t *testing.T) {
	wall := nav.Shape{Kind: nav.Rect, A: nav.Vec{X: 250, Y: 0}, B: nav.Vec{X: 270, Y: 1000}}
	world := testWorld(wall)
	player := addTestEntity(world, 1, "player", 100, 500, playerBase)
	before := addTestEntity(world, 2, "monster", 190, 500, monsterBase)
	behind := addTestEntity(world, 3, "monster", 330, 500, monsterBase)
	if err := world.Combat.CastAimed(player, pierceSkill(), 0, 1, 0); err != nil {
		t.Fatalf("pierce: %v", err)
	}
	if before.HP == before.Attr.MaxHP {
		t.Fatal("enemy before the wall was not hit")
	}
	if behind.HP != behind.Attr.MaxHP {
		t.Fatal("pierce went through the wall")
	}
	if event := lastCast(world); event.GetTx() > 250 {
		t.Fatalf("pierce ended at x = %v, inside the wall", event.GetTx())
	}
}

func TestRainCenteredOnTarget(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 100, 500, playerBase)
	target := addTestEntity(world, 2, "monster", 300, 500, monsterBase)
	neighbor := addTestEntity(world, 3, "monster", 300, 560, monsterBase)
	outside := addTestEntity(world, 4, "monster", 300, 700, monsterBase)
	if err := world.Combat.CastAimed(player, rainSkill(), target.ID, 0, 0); err != nil {
		t.Fatalf("rain: %v", err)
	}
	event := lastCast(world)
	if event.GetX() != 300 || event.GetY() != 500 || event.GetRadius() != 90 ||
		int(event.GetDst()) != target.ID || int(event.GetSrc()) != player.ID {
		t.Fatalf("rain cast = %v", event)
	}
	if target.HP == target.Attr.MaxHP || neighbor.HP == neighbor.Attr.MaxHP {
		t.Fatal("rain missed an enemy in the circle")
	}
	if outside.HP != outside.Attr.MaxHP {
		t.Fatal("rain hit an enemy outside the circle")
	}
	// 目标太远：退回到沿瞄准方向落点
	world.State.Events.Clear()
	player.Cooldowns = map[string]float64{}
	far := addTestEntity(world, 5, "monster", 600, 500, monsterBase)
	if err := world.Combat.CastAimed(player, rainSkill(), far.ID, 0, 1); err != nil {
		t.Fatalf("rain with far target: %v", err)
	}
	if event := lastCast(world); event.Dst != nil || event.GetX() != 100 || event.GetY() != 680 {
		t.Fatalf("rain with far target landed at (%v, %v), dst %v", event.GetX(), event.GetY(), event.GetDst())
	}
}

func TestRainOnAimPointAndNoAim(t *testing.T) {
	world := testWorld()
	player := addTestEntity(world, 1, "player", 100, 500, playerBase)
	victim := addTestEntity(world, 2, "monster", 260, 500, monsterBase)
	if err := world.Combat.CastAimed(player, rainSkill(), 0, 5, 0); err != nil {
		t.Fatalf("rain: %v", err)
	}
	event := lastCast(world)
	if event.GetX() != 280 || event.GetY() != 500 || event.Dst != nil {
		t.Fatalf("rain landed at (%v, %v), dst %v", event.GetX(), event.GetY(), event.GetDst())
	}
	if victim.HP == victim.Attr.MaxHP {
		t.Fatal("rain missed the enemy near the aim point")
	}
	// 落点夹在地图内（地图宽 1000）
	player.X = 900
	world.Grid.Moved(player)
	player.Cooldowns = map[string]float64{}
	if err := world.Combat.CastAimed(player, rainSkill(), 0, 1, 0); err != nil {
		t.Fatalf("rain at edge: %v", err)
	}
	if event := lastCast(world); event.GetX() != 1000 {
		t.Fatalf("rain landed at x = %v, want clamped to 1000", event.GetX())
	}
	player.Cooldowns = map[string]float64{}
	if err := world.Combat.CastAimed(player, rainSkill(), 0, 0, 0); err != combat.ErrNoAim {
		t.Fatalf("rain without target or aim: %v, want ErrNoAim", err)
	}
	if player.Cooldowns["arrow_rain"] != 0 {
		t.Fatal("failed rain went on cooldown")
	}
}

// rangerWorld 是有骑士和游侠两个职业的世界。
func rangerWorld() *World {
	world := testWorld()
	cfg := world.State.Cfg
	for _, id := range []string{"slash", "fireball", "heal", "shot", "pierce_shot", "arrow_rain", "roll"} {
		cfg.Skills[id] = &config.Skill{ID: id, Name: id, Kind: "self"}
	}
	cfg.Skills["pierce_shot"] = pierceSkill()
	cfg.Skills["arrow_rain"] = rainSkill()
	knight := cfg.World.Player.DefaultClass()
	knight.Color = "#4da3ff"
	knight.Attrs = config.Attrs{Str: 10, Agi: 8, Int: 8, Vit: 12}
	knight.Growth = config.Attrs{Str: 2, Agi: 1.5, Int: 1.5, Vit: 2}
	knight.Skills = []string{"slash", "fireball", "heal"}
	knight.SkillPool = []string{"fireball", "heal"}
	cfg.World.Player.Classes = append(cfg.World.Player.Classes, &config.Class{
		ID:        "ranger",
		Name:      "游侠",
		Model:     "ranger",
		Color:     "#8fd17a",
		CanBlock:  false,
		Attrs:     config.Attrs{Str: 6, Agi: 14, Int: 8, Vit: 9},
		Growth:    config.Attrs{Str: 1, Agi: 2.4, Int: 1.2, Vit: 1.6},
		Speed:     180,
		Radius:    15,
		Skills:    []string{"shot", "pierce_shot", "arrow_rain"},
		SkillPool: []string{"pierce_shot", "arrow_rain", "roll"},
	})
	cfg.World.Player.Block = config.Block{Reduce: 0.8, Speed: 0.5}
	return world
}

func sendLoadout(world *World, session *Session, class string, skills ...string) {
	loadout := &pb.Loadout{Skills: skills}
	if class != "" {
		loadout.Class = proto.String(class)
	}
	world.Input(session, &pb.ClientMsg{Msg: &pb.ClientMsg_Loadout{Loadout: loadout}})
}

func skillIDs(skills []*config.Skill) []string {
	var ids []string
	for _, skill := range skills {
		ids = append(ids, skill.ID)
	}
	return ids
}

// readMessages 取出会话 Out 里排着的所有消息。
func readMessages(t *testing.T, session *Session) []*pb.ServerMsg {
	t.Helper()
	return sentMessages(t, session)
}

func TestWelcomeIncludesClasses(t *testing.T) {
	world := rangerWorld()
	session := world.Join()
	welcome := readMessages(t, session)[0].GetWelcome()
	if welcome.GetClass() != "knight" || len(welcome.Classes) != 2 {
		t.Fatalf("class %q, %d classes", welcome.GetClass(), len(welcome.Classes))
	}
	knight, ranger := welcome.Classes[0], welcome.Classes[1]
	if knight.GetId() != "knight" || !knight.GetCanBlock() || knight.GetPick() != 2 {
		t.Fatalf("knight = %v", knight)
	}
	if ranger.GetId() != "ranger" || ranger.GetCanBlock() || ranger.GetModel() != "ranger" ||
		ranger.GetPick() != 2 || len(ranger.Skills) != 3 || len(ranger.Pool) != 3 {
		t.Fatalf("ranger = %v", ranger)
	}
	if ranger.Skills[0].GetSlot() != 1 || ranger.Pool[0].GetSlot() != 0 {
		t.Fatal("class skill slots wrong")
	}
	rain := ranger.Pool[1]
	if rain.GetId() != "arrow_rain" || rain.GetDistance() != 180 {
		t.Fatalf("rain info = %v", rain)
	}
	if len(welcome.Pool) != 2 || welcome.GetPick() != 2 {
		t.Fatalf("welcome pool %d, pick %d: want the current class's", len(welcome.Pool), welcome.GetPick())
	}
}

func TestLoadoutSwitchesClass(t *testing.T) {
	world := rangerWorld()
	session := world.Join()
	player := session.Player
	player.Level = 3
	player.Base = config.Attrs{Str: 14, Agi: 11, Int: 11, Vit: 16}
	player.Blocking = true
	world.Sessions.Flush()
	observer := world.Join()
	world.Sessions.Flush()
	if !canSee(world, observer, player.ID) {
		t.Fatal("observer cannot see the player")
	}
	readMessages(t, observer)
	player.HP = player.Attr.MaxHP / 2
	sendLoadout(world, session, "ranger", "arrow_rain", "pierce_shot")
	if player.Class != "ranger" || player.Model != "ranger" || player.Color != "#8fd17a" ||
		player.Radius != 15 || player.Speed != 180 || player.Attr.Speed != 180 {
		t.Fatalf("class not applied: %+v %+v", player.Identity, player.Transform)
	}
	// 等级保留，属性按游侠的成长重算：初始 + 2 级成长
	if player.Level != 3 || math.Abs(player.Base.Agi-(14+2*2.4)) > 1e-9 || math.Abs(player.Base.Str-8) > 1e-9 {
		t.Fatalf("level %d, base %+v", player.Level, player.Base)
	}
	if got := skillIDs(player.Skills); len(got) != 3 || got[0] != "shot" ||
		got[1] != "arrow_rain" || got[2] != "pierce_shot" {
		t.Fatalf("skills = %v", got)
	}
	if math.Abs(player.HPRatio()-0.5) > 1e-9 {
		t.Fatalf("HP ratio = %v, want 0.5", player.HPRatio())
	}
	if player.Blocking {
		t.Fatal("ranger kept blocking")
	}
	// 能看到它的会话都会收到新的 Enter（带新模型）
	readMessages(t, session)
	world.Sessions.Flush()
	var model string
	for _, msg := range readMessages(t, observer) {
		for _, info := range msg.GetEnter().GetEnts() {
			if int(info.GetId()) == player.ID {
				model = info.GetModel()
			}
		}
	}
	if model != "ranger" {
		t.Fatalf("re-entered with model %q", model)
	}
	// SkillBar 带职业
	sendLoadout(world, session, "", "pierce_shot", "roll")
	var bar *pb.SkillBar
	for _, msg := range readMessages(t, session) {
		if msg.GetSkillBar() != nil {
			bar = msg.GetSkillBar()
		}
	}
	if bar == nil || bar.GetClass() != "ranger" || len(bar.Skills) != 3 {
		t.Fatalf("skill bar = %v", bar)
	}
}

func TestLoadoutClassRefused(t *testing.T) {
	world := rangerWorld()
	session := world.Join()
	player := session.Player
	readMessages(t, session)
	// 技能不在新职业的池子里（火球是骑士的）：整个换职业被拒绝，什么都不变
	sendLoadout(world, session, "ranger", "fireball", "pierce_shot")
	sendLoadout(world, session, "mage", "pierce_shot", "arrow_rain")
	if player.Class != "knight" || player.Model != "knight" || skillIDs(player.Skills)[0] != "slash" {
		t.Fatalf("bad class switch applied: %v", player.Class)
	}
	// 放过技能之后不能换
	player.CanPick = false
	sendLoadout(world, session, "ranger", "pierce_shot", "arrow_rain")
	if player.Class != "knight" || player.Radius != 16 {
		t.Fatal("class switched while !CanPick")
	}
	toasts := 0
	for _, msg := range readMessages(t, session) {
		if msg.GetToast() != nil {
			toasts++
		}
	}
	if toasts != 3 {
		t.Fatalf("%d toasts, want 3", toasts)
	}
	// 死亡后可以换
	world.Combat.Kill(player, nil)
	sendLoadout(world, session, "ranger", "pierce_shot", "arrow_rain")
	if player.Class != "ranger" {
		t.Fatal("class not switched while dead")
	}
}

func TestBlockIgnoredForRanger(t *testing.T) {
	world := rangerWorld()
	session := world.Join()
	player := session.Player
	block := func(on bool) {
		world.Input(session, &pb.ClientMsg{Msg: &pb.ClientMsg_Block{Block: &pb.Block{On: proto.Bool(on)}}})
	}
	block(true)
	if !player.Blocking {
		t.Fatal("knight cannot block")
	}
	block(false)
	sendLoadout(world, session, "ranger", "pierce_shot", "arrow_rain")
	block(true)
	if player.Blocking {
		t.Fatal("ranger is blocking")
	}
}
