package game

import (
	"testing"

	"github.com/qinbaixi/BtDemo/internal/config"
)

// 玩家只接收其周围九宫格内的实体，
// 实体离开视野时会收到离开通知。
func TestFlushEnterLeave(t *testing.T) {
	world := testWorld()
	world.State.Cfg.World.Player.Respawn = 3
	session := world.Join()
	drain(session)
	session.Player.X, session.Player.Y = 100, 100
	world.Grid.Moved(session.Player)
	far := addTestEntity(world, 50, "monster", 900, 900, config.Attrs{Vit: 5})
	world.Sessions.Flush()
	if session.Visible(far.ID) || !session.Visible(session.Player.ID) {
		t.Fatalf(
			"far visible %v, self visible %v",
			session.Visible(far.ID),
			session.Visible(session.Player.ID),
		)
	}
	far.X, far.Y = 250, 250
	world.Grid.Moved(far)
	world.Sessions.Flush()
	if !session.Visible(far.ID) {
		t.Fatal("entity in view not entered")
	}
	far.X, far.Y = 900, 900
	world.Grid.Moved(far)
	world.Sessions.Flush()
	if session.Visible(far.ID) {
		t.Fatal("entity out of view not left")
	}
}

func drain(session *Session) {
	for len(session.Out) > 0 {
		<-session.Out
	}
}
