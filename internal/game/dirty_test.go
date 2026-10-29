package game

import (
	"github.com/qinbaixi/BtDemo/internal/config"
	"testing"

	"github.com/qinbaixi/BtDemo/internal/pb"
)

// selfStates 取走会话队列里的消息，返回其中属于 entityID 的增量状态。
func selfStates(t *testing.T, session *Session, entityID int) []*pb.EntityState {
	t.Helper()
	var states []*pb.EntityState
	for _, msg := range sentMessages(t, session) {
		if state := msg.GetState(); state != nil && int(state.GetId()) == entityID {
			states = append(states, state)
		}
	}
	return states
}

// 移动后位置增量被发出，伤害后 HP 增量被发出。
func TestDirtyDeltasAreSent(t *testing.T) {
	world := shippedWorld(t)
	session := world.Join()
	player := session.Player
	sentMessages(t, session) // 丢掉进入时的全量
	startX := player.X

	player.MoveX = 1
	stepMillis(world, 2000)
	player.MoveX = 0
	movedSent := false
	for _, state := range selfStates(t, session, player.ID) {
		if state.X != nil && float64(state.GetX()) > startX {
			movedSent = true
		}
	}
	if !movedSent {
		t.Fatalf("no position delta sent after moving from x=%v to x=%v", startX, player.X)
	}

	// 让一只怪物贴在玩家身上打一下
	monster := world.Combat.NearestMonster(player, 100000)
	if monster == nil {
		t.Fatal("no monster in the world")
	}
	monster.SetPos(player.X+30, player.Y)
	world.Grid.Moved(monster)
	monster.Cooldowns = map[string]config.Millis{}
	sentMessages(t, session)
	hpBefore := player.HP
	if err := world.Combat.Cast(monster, slashSkill(), player.ID); err != nil {
		t.Fatalf("monster cast: %v", err)
	}
	if player.HP >= hpBefore {
		t.Fatalf("player HP %v not reduced from %v", player.HP, hpBefore)
	}
	world.Sessions.Flush()
	hpSent := false
	for _, state := range selfStates(t, session, player.ID) {
		if state.Hp != nil && int(state.GetHp()) == player.HP {
			hpSent = true
		}
	}
	if !hpSent {
		t.Fatal("no HP delta sent after taking damage")
	}
}
