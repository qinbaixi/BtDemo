package game

import (
	"testing"

	"github.com/qinbaixi/BtDemo/internal/config"
)

// benchWorld 用正式配置（config/，含怪物、NPC 和行为树）建一个单独运行的场景。
func benchWorld(b *testing.B) *World {
	b.Helper()
	cfg, err := config.Load("../../config", TreeNames())
	if err != nil {
		b.Fatal(err)
	}
	world, err := NewWorld(cfg, 1)
	if err != nil {
		b.Fatal(err)
	}
	return world
}

// BenchmarkTick 量推进一个逻辑 tick（各系统 Step，含行为树与移动）的开销。
// 世界里是正式配置的怪物和 NPC，怪物在游荡或战斗，每 tick 都有位置变化。
// 基准不经过写协程，每轮把发送队列清空，免得积压触发全量重发干扰测量。
func BenchmarkTick(b *testing.B) {
	world := benchWorld(b)
	player := world.Join() // 有玩家在场，怪物会找目标、追击
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		world.Step()
		player.Link().Take()
	}
	b.StopTimer()
	world.Leave(player)
}

// BenchmarkSyncFrame 量一个同步帧（Step 到同步节拍时把脏状态广播、合成 Frame）
// 的开销。每个迭代推两个 tick，正好触发一次 Step 内的 Flush。
func BenchmarkSyncFrame(b *testing.B) {
	world := benchWorld(b)
	const players = 8
	clients := make([]*Session, players)
	for i := range clients {
		clients[i] = world.Join()
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		world.Step() // tick_rate/sync_rate = 2：两次 Step 触发一次 Flush
		world.Step()
		for _, client := range clients {
			client.Link().Take()
		}
	}
}
