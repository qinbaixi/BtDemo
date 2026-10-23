package game

import (
	"fmt"
	"math/rand"
	"slices"
	"testing"

	"google.golang.org/protobuf/encoding/prototext"
	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/session"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// simClient 是模拟的客户端：只吃会话收到的消息，按 Enter / Leave / EntityState 增量
// 维护自己看到的实体状态，收到 Welcome 时清空（重连后服务端会重新发全量）。
type simClient struct {
	session  *Session
	entities map[int32]*pb.EntityState
}

func newSimClient(client *Session) *simClient {
	return &simClient{session: client, entities: map[int32]*pb.EntityState{}}
}

// receive 取走会话发送队列里的全部消息，按顺序应用到本地状态。
func (sim *simClient) receive(t *testing.T) {
	t.Helper()
	if sim.session.Link() == nil {
		return // 断线中，没有连接可收
	}
	for _, msg := range sentMessages(t, sim.session) {
		switch body := msg.Msg.(type) {
		case *pb.ServerMsg_Welcome:
			sim.entities = map[int32]*pb.EntityState{}
		case *pb.ServerMsg_Enter:
			for _, info := range body.Enter.Ents {
				sim.entities[info.GetId()] = proto.Clone(info.GetState()).(*pb.EntityState)
			}
		case *pb.ServerMsg_Leave:
			for _, id := range body.Leave.Ids {
				delete(sim.entities, id)
			}
		case *pb.ServerMsg_State:
			known := sim.entities[body.State.GetId()]
			if known == nil {
				continue // 没见过的实体的增量：真正的客户端也会忽略
			}
			proto.Merge(known, body.State)
		}
	}
}

// compare 把模拟客户端的状态和服务端比较：可见集合要等于玩家九宫格里的实体，
// 每个可见实体的状态要等于服务端当前的完整状态。返回每一处不一致的描述。
func (sim *simClient) compare(world *World) []string {
	player := sim.session.Player
	var problems []string
	expected := map[int32]*core.Entity{}
	world.Grid.Neighbors(world.Grid.CellOf(player.X, player.Y), func(entity *core.Entity) {
		expected[int32(entity.ID)] = entity
	})
	for id, entity := range expected {
		known := sim.entities[id]
		if known == nil {
			problems = append(problems, fmt.Sprintf("实体 %d (%s) 在九宫格里但客户端没有", id, entity.Name))
			continue
		}
		want := session.FullState(entity)
		if !proto.Equal(known, want) {
			problems = append(problems, fmt.Sprintf(
				"实体 %d (%s) 状态不一致\n  客户端: %s\n  服务端: %s",
				id, entity.Name, prototext.MarshalOptions{}.Format(known), prototext.MarshalOptions{}.Format(want),
			))
		}
	}
	for id := range sim.entities {
		if expected[id] == nil {
			problems = append(problems, fmt.Sprintf("实体 %d 客户端还看得到但已不在九宫格里", id))
		}
	}
	slices.Sort(problems)
	return problems
}

// syncChecker 每个同步帧后检查所有模拟客户端，累计不一致的次数。
type syncChecker struct {
	t         *testing.T
	world     *World
	clients   []*simClient
	failures  int // 有不一致的 (同步帧, 客户端) 数
	syncs     int
	reported  int
	maxReport int
}

// step 推进世界一个 tick；刚好是同步帧时让所有模拟客户端收消息并检查。
func (checker *syncChecker) step() {
	checker.t.Helper()
	cfg := checker.world.State.Cfg.World
	checker.world.Step()
	if checker.world.State.Clock.Tick%max(1, cfg.TickRate/cfg.SyncRate) != 0 {
		return
	}
	checker.syncs++
	for index, sim := range checker.clients {
		sim.receive(checker.t)
		if sim.session.Link() == nil || checker.world.Get(sim.session.Player.ID) == nil {
			continue
		}
		problems := sim.compare(checker.world)
		if len(problems) == 0 {
			continue
		}
		checker.failures++
		if checker.reported < checker.maxReport {
			checker.reported++
			shown := problems[:min(len(problems), 3)]
			checker.t.Errorf(
				"t=%.1fs 玩家 %d 与服务端不同步（共 %d 处）:\n%s",
				checker.world.State.Now(), index, len(problems), joinLines(shown),
			)
		}
	}
}

func joinLines(lines []string) string {
	var text string
	for _, line := range lines {
		text += "- " + line + "\n"
	}
	return text
}

// finish 汇总结果。
func (checker *syncChecker) finish() {
	checker.t.Helper()
	if checker.failures > 0 {
		checker.t.Errorf("%d 个同步帧里共 %d 次检查发现客户端与服务端不一致", checker.syncs, checker.failures)
	}
}

// moveInput 是随机改变方向的移动输入（偶尔停下）。
func moveInput(random *rand.Rand) *pb.ClientMsg {
	dx, dy := random.Float32()*2-1, random.Float32()*2-1
	if random.Intn(5) == 0 {
		dx, dy = 0, 0
	}
	return &pb.ClientMsg{Msg: &pb.ClientMsg_Move{Move: &pb.Move{Dx: proto.Float32(dx), Dy: proto.Float32(dy)}}}
}

func castInput(slot int32, random *rand.Rand) *pb.ClientMsg {
	cast := &pb.Cast{
		Slot: proto.Int32(slot),
		Dx:   proto.Float32(random.Float32()*2 - 1),
		Dy:   proto.Float32(random.Float32()*2 - 1),
	}
	return &pb.ClientMsg{Msg: &pb.ClientMsg_Cast{Cast: cast}}
}

// syncScenario 把几个玩家放在怪物出生点附近和地图各处，返回模拟客户端。
func syncScenario(world *World) []*simClient {
	spots := [][2]float64{{1000, 900}, {1060, 940}, {2000, 1300}, {400, 300}}
	var clients []*simClient
	for _, spot := range spots {
		client := world.Join()
		client.Player.X, client.Player.Y = spot[0], spot[1]
		world.Grid.Moved(client.Player)
		clients = append(clients, newSimClient(client))
	}
	return clients
}

// randomInputs 每隔 1~3 秒让每个玩家换一次方向，偶尔放技能。
func randomInputs(world *World, clients []*simClient, random *rand.Rand, nextAct []int, tick int) {
	tickRate := world.State.Cfg.World.TickRate
	for index, sim := range clients {
		if tick < nextAct[index] || sim.session.Link() == nil {
			continue
		}
		nextAct[index] = tick + tickRate + random.Intn(2*tickRate)
		world.Input(sim.session, moveInput(random))
		if random.Intn(3) == 0 {
			world.Input(sim.session, castInput(1, random))
		}
		if random.Intn(6) == 0 {
			world.Input(sim.session, castInput(int32(2+random.Intn(3)), random))
		}
	}
}

// 玩家在世界里乱跑 30 秒，每个同步帧后模拟客户端按增量重建出的可见集合和实体状态，
// 必须和服务端九宫格里的实体及其完整状态一致。
func TestIncrementalSyncStaysConsistent(t *testing.T) {
	world := shippedWorld(t)
	clients := syncScenario(world)
	checker := &syncChecker{t: t, world: world, clients: clients, maxReport: 5}
	random := rand.New(rand.NewSource(20240607))
	nextAct := make([]int, len(clients))
	tickRate := world.State.Cfg.World.TickRate
	for tick := 0; tick < 30*tickRate; tick++ {
		randomInputs(world, clients, random, nextAct, tick)
		checker.step()
	}
	checker.finish()
}

// 玩家断线几秒后用 token 重连：模拟客户端从 Welcome{resumed} 之后的全量重建出的状态，
// 以及之后的增量，都要和服务端一致。
func TestReconnectRebuildsConsistentState(t *testing.T) {
	world := shippedWorld(t)
	clients := syncScenario(world)
	checker := &syncChecker{t: t, world: world, clients: clients, maxReport: 5}
	random := rand.New(rand.NewSource(7))
	nextAct := make([]int, len(clients))
	tickRate := world.State.Cfg.World.TickRate
	dropped := clients[0]
	for tick := 0; tick < 20*tickRate; tick++ {
		randomInputs(world, clients, random, nextAct, tick)
		checker.step()
		switch tick {
		case 6 * tickRate:
			world.Detach(dropped.session, dropped.session.Link())
		case 11 * tickRate:
			newLink := session.NewLink()
			if back := world.Attach(newLink, dropped.session.Token()); back != dropped.session {
				t.Fatal("重连应当接回同一个角色")
			}
		}
	}
	if len(dropped.entities) == 0 {
		t.Fatal("重连后模拟客户端没有收到任何实体")
	}
	checker.finish()
}
