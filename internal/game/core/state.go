package core

import (
	"math"
	"math/rand"
	"slices"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// State 是共享的世界状态，会传给每个系统：包括配置、时钟、随机数、实体表和事件队列。
type State struct {
	Cfg    *config.Config
	Rand   *rand.Rand
	Clock  Clock
	Ents   Entities
	Events Events
	Zones  Zones
}

// NewState 创建一个空的世界状态。
func NewState(cfg *config.Config, seed int64) *State {
	return &State{
		Cfg:   cfg,
		Rand:  rand.New(rand.NewSource(seed)),
		Clock: Clock{Dt: 1 / float64(cfg.World.TickRate)},
		Ents:  Entities{byID: map[int]*Entity{}},
	}
}

// Now 返回当前的游戏时间（秒）。
func (state *State) Now() float64 { return state.Clock.Now }

// Hostile 报告 a 是否会攻击 b。
func (state *State) Hostile(a, b *Entity) bool {
	return a != b && state.Cfg.Hostile(a.Faction, b.Faction)
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
	ids    []int // 已排序，用于保证 Each 的确定性
	nextID int
}

// New 创建一个带有新 ID 的实体。在调用 Add 之前，它不在表中。
func (entities *Entities) New() *Entity {
	entities.nextID++
	return &Entity{
		Identity: Identity{ID: entities.nextID},
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
	entities.nextID = max(entities.nextID, entity.ID)
}

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
func (entities *Entities) Each(fn func(*Entity)) {
	for _, id := range slices.Clone(entities.ids) { // fn 中可能会添加或移除实体
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
