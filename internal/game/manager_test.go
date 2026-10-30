package game

import (
	"context"
	"math"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/session"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// shippedManager 用随附的配置（晨曦村、亡者墓园两个场景）建一个不启动 goroutine 的管理器：
// 测试里用 pump 手动推进每条线。
func shippedManager(t *testing.T) *Manager {
	t.Helper()
	cfg, err := config.Load("../../config", TreeNames())
	if err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(cfg, 1)
	if err != nil {
		t.Fatal(err)
	}
	return manager
}

// pump 让每条线跑 ticks 个 tick（执行排队的命令、处理输入、推进）。
func pump(manager *Manager, ticks int) {
	for i := 0; i < ticks; i++ {
		manager.mutex.Lock()
		var scenes []*Scene
		for _, template := range manager.cfg.Scenes.List {
			for _, open := range manager.lines[template.ID] {
				scenes = append(scenes, open.scene)
			}
		}
		manager.mutex.Unlock()
		for _, scene := range scenes {
			scene.tick()
		}
	}
}

// attachNow 是不起 goroutine 时的 Attach：交给场景，推进一个 tick，取回结果。
func attachNow(t *testing.T, manager *Manager, link *session.Link, token string) *Session {
	t.Helper()
	reply := make(chan *Session, 1)
	manager.attach(link, token, reply)
	for i := 0; i < 3; i++ {
		select {
		case client := <-reply:
			return client
		default:
			pump(manager, 1)
		}
	}
	t.Fatal("attach did not finish")
	return nil
}

// sceneOf 返回角色现在所在的线（迁移途中返回 nil）。
func sceneOf(manager *Manager, client *Session) *Scene {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	found := manager.routes[client.Token()]
	if found == nil || found.moving {
		return nil
	}
	return found.line.scene
}

// line 返回场景模板 templateID 的第 number 线。
func lineScene(t *testing.T, manager *Manager, templateID string, number int) *Scene {
	t.Helper()
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	for _, open := range manager.lines[templateID] {
		if open.scene.Line == number {
			return open.scene
		}
	}
	t.Fatalf("no line %d in %s", number, templateID)
	return nil
}

// lastWelcome 返回 msgs 里最后一个 Welcome。
func lastWelcome(msgs []*pb.ServerMsg) *pb.Welcome {
	var welcome *pb.Welcome
	for _, msg := range msgs {
		if msg.GetWelcome() != nil {
			welcome = msg.GetWelcome()
		}
	}
	return welcome
}

// 新角色进默认场景的第 1 线，欢迎消息里带场景、线号、地图地址和传送门。
func TestJoinEntersDefaultScene(t *testing.T) {
	manager := shippedManager(t)
	client := attachNow(t, manager, session.NewLink(), "")
	village := lineScene(t, manager, "village", 1)
	if sceneOf(manager, client) != village {
		t.Fatal("new player should be in village line 1")
	}
	welcome := lastWelcome(sentMessages(t, client))
	scene := welcome.GetScene()
	if scene.GetId() != "village" || scene.GetLine() != 1 || scene.GetMap() != "/maps/village.tmj" {
		t.Fatalf("welcome scene = %v", scene)
	}
	if len(scene.GetPortals()) != 2 || scene.GetPortals()[0].GetToName() != "亡者墓园" {
		t.Fatalf("portals = %v", scene.GetPortals())
	}
	if welcome.GetMapW() != 1280 {
		t.Fatalf("map width %v, want the village map's 1280", welcome.GetMapW())
	}
}

// 站进传送门一会儿就到了另一个场景：还是同一个角色（ID、等级、背包不变），Buff 清掉，
// 冷却按剩余时间带过去，落在通回来的传送门旁边；原来周围的玩家看到他离开。
func TestPortalMovesPlayerToAnotherScene(t *testing.T) {
	manager := shippedManager(t)
	village := lineScene(t, manager, "village", 1)
	graveyard := lineScene(t, manager, "graveyard", 1)
	client := attachNow(t, manager, session.NewLink(), "")
	watcher := attachNow(t, manager, session.NewLink(), "")
	player := client.Player
	playerID := player.ID
	pump(manager, 20) // 宠物召唤出来、背包发过
	if player.PetEntity == 0 {
		t.Fatal("the player should have a pet before travelling")
	}
	oldPet := player.PetEntity
	player.Level, player.Exp = 3, 7
	player.Cooldowns["fireball"] = village.State.Now() + 4000
	player.Buffs = append(player.Buffs, &core.Buff{
		Cfg:   village.State.Cfg.Skills["warcry"].Buff,
		Until: village.State.Now() + 30,
	})
	items := len(player.Items)

	portal := village.Portals.List()[0]
	watcher.Player.X, watcher.Player.Y = float64(portal.X-60), float64(portal.Y)
	village.Grid.Moved(watcher.Player)
	player.X, player.Y = float64(portal.X), float64(portal.Y)
	village.Grid.Moved(player)
	pump(manager, 10)
	sentMessages(t, watcher)
	pump(manager, 20) // 站够 Dwell 秒，出发、到达

	if sceneOf(manager, client) != graveyard {
		t.Fatal("player should now be in the graveyard")
	}
	if village.Get(playerID) != nil || village.Get(oldPet) != nil {
		t.Fatal("player and pet should be gone from the village")
	}
	if graveyard.Get(playerID) != player || player.Level != 3 || player.Exp != 7 || len(player.Items) != items {
		t.Fatal("the same character (id, level, items) should be in the graveyard")
	}
	if len(player.Buffs) != 0 {
		t.Fatal("buffs should be cleared on travel")
	}
	left := player.Cooldowns["fireball"] - graveyard.State.Now()
	if left < 2000 || left > 3000 { // 设的时候还剩 4 秒，之后过了 1.5 秒（30 个 tick）
		t.Fatalf("fireball cooldown left %dms, want about 2500ms", left)
	}
	back := graveyard.Portals.List()[0]
	if distance := math.Hypot(player.X-float64(back.X), player.Y-float64(back.Y)); distance <= float64(back.Radius) || distance > 200 {
		t.Fatalf("arrived %.0fpx from the return portal, want just outside it", distance)
	}
	msgs := sentMessages(t, client)
	var sawTravel bool
	for _, msg := range msgs {
		sawTravel = sawTravel || msg.GetTravel().GetScene() == "亡者墓园"
	}
	welcome := lastWelcome(msgs)
	if !sawTravel || welcome == nil || !welcome.GetResumed() || welcome.GetScene().GetId() != "graveyard" ||
		welcome.GetId() != int32(playerID) {
		t.Fatalf("travel %v, welcome %v", sawTravel, welcome)
	}
	var watcherSawLeave bool
	for _, msg := range sentMessages(t, watcher) {
		for _, id := range msg.GetLeave().GetIds() {
			watcherSawLeave = watcherSawLeave || id == int32(playerID)
		}
	}
	if !watcherSawLeave {
		t.Fatal("players near the portal should see the traveller leave")
	}
	pump(manager, 40)
	if pet := graveyard.Get(player.PetEntity); pet == nil || pet.Owner != playerID {
		t.Fatal("the pet should be summoned again in the graveyard")
	}
}

// 人数超过 soft 时新玩家去新开的线；切线落在同一个位置；战斗中、去不存在的线都会被拒绝。
func TestLinesOpenWhenBusyAndPlayersCanSwitch(t *testing.T) {
	manager := shippedManager(t)
	village := manager.cfg.Scenes.Scene("village")
	village.Lines.Soft, village.Lines.Hard = 2, 3
	first := attachNow(t, manager, session.NewLink(), "")
	attachNow(t, manager, session.NewLink(), "")
	third := attachNow(t, manager, session.NewLink(), "")
	line1 := lineScene(t, manager, "village", 1)
	line2 := lineScene(t, manager, "village", 2)
	if sceneOf(manager, first) != line1 || sceneOf(manager, third) != line2 {
		t.Fatal("the third player should go to the new line 2")
	}

	switchTo := func(client *Session, line int) {
		client.Inbox.Push(&pb.ClientMsg{
			Msg: &pb.ClientMsg_SwitchLine{SwitchLine: &pb.SwitchLine{Line: proto.Int32(int32(line))}},
		})
		pump(manager, 2)
	}
	toastOf := func(client *Session) string {
		text := ""
		for _, msg := range sentMessages(t, client) {
			if msg.GetToast() != nil {
				text = msg.GetToast().GetText()
			}
		}
		return text
	}
	sentMessages(t, first)
	switchTo(first, 9)
	if toastOf(first) != reasonNoSuchLine {
		t.Fatal("switching to a missing line should be refused")
	}
	first.Player.LastHitAt = line1.State.Now()
	switchTo(first, 2)
	if toastOf(first) != reasonInCombat || sceneOf(manager, first) != line1 {
		t.Fatal("switching lines in combat should be refused")
	}
	first.Player.LastHitAt = 0
	x, y := first.Player.X, first.Player.Y
	switchTo(first, 2)
	if sceneOf(manager, first) != line2 {
		t.Fatal("the player should be on line 2")
	}
	if math.Hypot(first.Player.X-x, first.Player.Y-y) > 40 {
		t.Fatal("switching lines should keep the position")
	}
	if welcome := lastWelcome(sentMessages(t, first)); welcome.GetScene().GetLine() != 2 {
		t.Fatalf("welcome after switching = %v", welcome.GetScene())
	}

	first.Inbox.Push(&pb.ClientMsg{Msg: &pb.ClientMsg_Lines{Lines: &pb.Lines{}}})
	pump(manager, 1)
	var list *pb.LineList
	for _, msg := range sentMessages(t, first) {
		if msg.GetLines() != nil {
			list = msg.GetLines()
		}
	}
	if list.GetCurrent() != 2 || len(list.GetLines()) != 2 ||
		list.GetLines()[0].GetPlayers() != 1 || list.GetLines()[1].GetPlayers() != 2 {
		t.Fatalf("line list = %v", list)
	}
}

// 多出来的线空了 idle_close 秒就关；常驻的第 1 线不关。
func TestIdleLinesClose(t *testing.T) {
	manager := shippedManager(t)
	village := manager.cfg.Scenes.Scene("village")
	village.Lines.Soft = 1
	attachNow(t, manager, session.NewLink(), "")
	second := attachNow(t, manager, session.NewLink(), "")
	if sceneOf(manager, second).Line != 2 {
		t.Fatal("second player should open line 2")
	}
	second.Inbox.Push(&pb.ClientMsg{
		Msg: &pb.ClientMsg_SwitchLine{SwitchLine: &pb.SwitchLine{Line: proto.Int32(1)}},
	})
	village.Lines.Hard = 5
	pump(manager, 3)
	manager.closeIdle(time.Now())
	if len(manager.lines["village"]) != 2 {
		t.Fatal("a line that just emptied should stay open for a while")
	}
	manager.closeIdle(time.Now().Add(time.Duration(village.Lines.IdleClose+1) * time.Second))
	if len(manager.lines["village"]) != 1 || len(manager.lines["graveyard"]) != 1 {
		t.Fatalf("idle line 2 should close, lines: %d village, %d graveyard",
			len(manager.lines["village"]), len(manager.lines["graveyard"]))
	}
}

// 迁移途中断线、重连：重连拿到的是同一个角色，到了新场景按新连接发全量；
// 途中断了没回来，就按断线保留处理。
func TestReconnectAndDisconnectWhileTravelling(t *testing.T) {
	manager := shippedManager(t)
	village := lineScene(t, manager, "village", 1)
	graveyard := lineScene(t, manager, "graveyard", 1)
	oldLink := session.NewLink()
	client := attachNow(t, manager, oldLink, "")
	pump(manager, 2)

	village.travel(client, "graveyard", 0) // 出发了，目标场景还没处理
	if sceneOf(manager, client) != nil {
		t.Fatal("the player should be in transit")
	}
	newLink := session.NewLink()
	reply := make(chan *Session, 1)
	manager.attach(newLink, client.Token(), reply)
	if <-reply != client {
		t.Fatal("reconnecting in transit should give back the same character")
	}
	if _, closed := oldLink.Take(); !closed {
		t.Fatal("the old connection should be closed")
	}
	pump(manager, 2)
	if sceneOf(manager, client) != graveyard || client.Link() != newLink {
		t.Fatal("the player should arrive on the new connection")
	}
	if welcome := lastWelcome(sentMessages(t, client)); welcome.GetScene().GetId() != "graveyard" {
		t.Fatal("the new connection should get the graveyard welcome")
	}

	graveyard.travel(client, "village", 0)
	manager.Detach(client, newLink)
	pump(manager, 2)
	if sceneOf(manager, client) != village || client.Link() != nil || village.Get(client.Player.ID) == nil {
		t.Fatal("a player who disconnected in transit should arrive detached")
	}
	keep := village.State.Cfg.World.Session.Keep
	pump(manager, int((keep+1)*20))
	if village.Get(client.Player.ID) != nil {
		t.Fatal("the detached traveller should expire like any detached player")
	}
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if manager.routes[client.Token()] != nil {
		t.Fatal("the expired character should be forgotten")
	}
	for _, open := range manager.lines["village"] {
		if open.residents != 0 {
			t.Fatalf("village line %d still counts %d residents", open.scene.Line, open.residents)
		}
	}
}

// 所有线一起跑（各自的 goroutine），一批玩家同时进出、来回切线、断线重连：用 -race 跑时不能有数据竞争，
// 停服时 Run 正常返回。
func TestManagerRunsLinesConcurrently(t *testing.T) {
	manager := shippedManager(t)
	village := manager.cfg.Scenes.Scene("village")
	village.Lines.Soft, village.Lines.Hard = 3, 50
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		manager.Run(ctx)
		close(done)
	}()
	var workers sync.WaitGroup
	for i := 0; i < 12; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			link := session.NewLink()
			client := manager.Attach(link, "")
			if client == nil {
				t.Error("attach failed")
				return
			}
			for round := 0; round < 6; round++ {
				client.Inbox.Push(&pb.ClientMsg{Msg: &pb.ClientMsg_SwitchLine{
					SwitchLine: &pb.SwitchLine{Line: proto.Int32(int32(1 + round%3))},
				}})
				client.Inbox.Push(&pb.ClientMsg{Msg: &pb.ClientMsg_Lines{Lines: &pb.Lines{}}})
				time.Sleep(60 * time.Millisecond)
				link.Take()
				if round == 3 {
					manager.Detach(client, link)
					link = session.NewLink()
					if manager.Attach(link, client.Token()) != client {
						t.Error("reconnect should return the same character")
					}
				}
			}
		}()
	}
	workers.Wait()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("manager did not stop")
	}
}
