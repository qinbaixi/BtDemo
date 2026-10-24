package core

import (
	"math"
	"math/rand"
	"slices"
	"sync/atomic"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// State 是共享的世界状态，会传给每个系统：包括配置、时钟、随机数、实体表和事件队列。
type State struct {
	Cfg  *config.Config
	Rand *rand.Rand
	// Luck 是物品特效触发和装备掉落用的随机数。和 Rand 分开，加了装备不会打乱原来的战斗随机序列；
	// 测试可以换成固定的来源，强制特效触发或不触发。
	Luck   *rand.Rand
	Clock  Clock
	Ents   Entities
	Events Events
	Zones  Zones
}

// NewState 创建一个空的世界状态，实体 ID 自己从 1 开始数。
func NewState(cfg *config.Config, seed int64) *State {
	return NewSceneState(cfg, seed, &IDSource{}, 0)
}

// NewSceneState 创建一个场景的世界状态：实体 ID 从所有场景共用的 ids 里分配，
// 这样玩家换场景后 ID 不变；时钟从 start 秒开始，让各个场景的游戏时间对得上
// （客户端按帧里的时间换算冷却，换了场景时钟不能跳）。
func NewSceneState(cfg *config.Config, seed int64, ids *IDSource, start float64) *State {
	dt := 1 / float64(cfg.World.TickRate)
	ticks := int(start / dt)
	return &State{
		Cfg:   cfg,
		Rand:  rand.New(rand.NewSource(seed)),
		Luck:  rand.New(rand.NewSource(seed + 1)),
		Clock: Clock{Dt: dt, Tick: ticks, Now: float64(ticks) * dt},
		Ents:  Entities{byID: map[int]*Entity{}, source: ids},
	}
}

// IDSource 分配实体 ID。所有场景共用一个，多个 goroutine 同时分配也不会重复。
type IDSource struct {
	last atomic.Int64
}

// Next 返回一个新的 ID。
func (source *IDSource) Next() int { return int(source.last.Add(1)) }

// Reserve 保证以后分配的 ID 都比 id 大（测试里直接用指定 ID 建实体时用）。
func (source *IDSource) Reserve(id int) {
	for {
		last := source.last.Load()
		if int64(id) <= last || source.last.CompareAndSwap(last, int64(id)) {
			return
		}
	}
}

// Now 返回当前的游戏时间（秒）。
func (state *State) Now() float64 { return state.Clock.Now }

// Hostile 报告 a 是否会攻击 b。
func (state *State) Hostile(a, b *Entity) bool {
	return a != b && state.Cfg.Hostile(a.Faction, b.Faction)
}

// Lucky 用 Luck 掷一次概率为 chance 的骰子。
func (state *State) Lucky(chance float64) bool {
	return state.Luck.Float64() < chance
}

// Scatter 返回 (x, y) 周围 spread 范围内的一个随机点。
func (state *State) Scatter(x, y, spread float64) (float64, float64) {
	angle := state.Rand.Float64() * 2 * math.Pi
	radius := math.Sqrt(state.Rand.Float64()) * spread
	return x + math.Cos(angle)*radius, y + math.Sin(angle)*radius
}

// Clock 是游戏时间，每次按固定的一个 tick 推进。
type Clock struct {
	Now  float64 // 自开始以来的秒数
	Dt   float64 // 每个 tick 的秒数
	Tick int     // 自开始以来的 tick 数
}

// Advance 将时钟向前推进一个 tick。
func (clock *Clock) Advance() {
	clock.Tick++
	clock.Now += clock.Dt
}

// Entities 是世界中所有实体的表。
type Entities struct {
	byID   map[int]*Entity
	ids    []int     // 已排序，用于保证 Each 的确定性
	source *IDSource // 新实体的 ID 从这里分配
	// snapshot 是 Each 遍历用的 id 快照，在多次调用间复用（世界单 goroutine，
	// 各系统串行调用 Each，正常情况下同时只有一层遍历）
	snapshot []int
	// iterating 为 true 表示快照正被某层 Each 使用，此时嵌套的 Each 另行分配。
	iterating bool
}

// New 创建一个带有新 ID 的实体。在调用 Add 之前，它不在表中。
func (entities *Entities) New() *Entity {
	return &Entity{
		Identity: Identity{ID: entities.source.Next()},
		Combat:   Combat{Cooldowns: map[string]float64{}},
	}
}

// Add 将 entity 放入表中。
func (entities *Entities) Add(entity *Entity) {
	if _, ok := entities.byID[entity.ID]; !ok {
		i, _ := slices.BinarySearch(entities.ids, entity.ID)
		entities.ids = slices.Insert(entities.ids, i, entity.ID)
	}
	entities.byID[entity.ID] = entity
	entities.source.Reserve(entity.ID)
}

// Count 是表里的实体数。
func (entities *Entities) Count() int { return len(entities.ids) }

// Remove 将 entity 从表中移除。
func (entities *Entities) Remove(entity *Entity) {
	if _, ok := entities.byID[entity.ID]; !ok {
		return
	}
	delete(entities.byID, entity.ID)
	if i, found := slices.BinarySearch(entities.ids, entity.ID); found {
		entities.ids = slices.Delete(entities.ids, i, i+1)
	}
}

// Get 返回具有给定 ID 的实体，不存在则返回 nil。
func (entities *Entities) Get(id int) *Entity { return entities.byID[id] }

// Each 按 ID 顺序对每个实体调用 fn，因此在给定种子下，tick 的执行是确定性的。
// fn 中可能会添加或移除实体，所以先对 id 列表做一份快照再遍历；快照的缓冲
// 复用上一次的（见 snapshot），嵌套调用 Each 时才另行分配。
func (entities *Entities) Each(fn func(*Entity)) {
	ids := &entities.snapshot
	if entities.iterating {
		ids = new([]int) // 嵌套的 Each 不能覆盖外层正在用的快照
	}
	*ids = append((*ids)[:0], entities.ids...)
	if ids == &entities.snapshot {
		entities.iterating = true
		defer func() { entities.iterating = false }()
	}
	for _, id := range *ids {
		if entity := entities.byID[id]; entity != nil {
			fn(entity)
		}
	}
}

// Event 是已经发生的事件，会随下一次同步发送给每个能看到事件发生位置的玩家。
type Event = pb.Event

// PendingEvent 是排队中的事件及其发生位置。
type PendingEvent struct {
	X, Y  float64
	Event *Event
}

// Events 是自上次同步以来的事件队列。
type Events struct {
	list []PendingEvent
}

// Emit 将 event 加入队列，位置为 entity 所在位置。
func (events *Events) Emit(entity *Entity, event *Event) {
	events.list = append(events.list, PendingEvent{X: entity.X, Y: entity.Y, Event: event})
}

// List 返回队列中的事件。
func (events *Events) List() []PendingEvent { return events.list }

// Clear 清空队列。
func (events *Events) Clear() { events.list = events.list[:0] }
