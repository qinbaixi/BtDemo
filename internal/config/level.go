package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
)

// 关卡（副本）：scenes.yaml 里 kind: dungeon 的场景。每个进来的玩家单独开一份，不分线。
// 地图上的 rooms 图层是房间的范围，gates 图层是房间之间的门；scenes.yaml 的 rooms 写每个房间刷什么怪、
// 清完给什么奖励。玩法见 docs/modules/level.md。

// SceneDungeon 是副本场景的 kind。
const SceneDungeon = "dungeon"

// 房间奖励（LevelRoom.Reward）。
const (
	RewardHeal = "heal" // 回满血
	RewardGear = "gear" // 一件装备
	RewardBoon = "boon" // 一个关内祝福（从 boons 里随机抽，出副本清掉）
)

// RoomArea 是地图 rooms 图层里的一个房间：矩形对象，名字是房间 id，属性 title 是显示给玩家的名字。
type RoomArea struct {
	ID         string
	Title      string
	X, Y, W, H int // 像素，左上角和宽高
}

// Contains 报告 (x, y) 是否在房间里、离边至少 inset 像素。
func (area *RoomArea) Contains(x, y, inset float64) bool {
	return x >= float64(area.X)+inset && x <= float64(area.X+area.W)-inset &&
		y >= float64(area.Y)+inset && y <= float64(area.Y+area.H)-inset
}

// Gate 是地图 gates 图层里的一扇门：矩形对象，关着时挡路。
//   - after：这个房间清完之后才开（不写 = 一开始就开着）；
//   - to：门通往的房间。那个房间打起来时门关上（把玩家关在里面），那个房间被岔路排除后门永远关着。
type Gate struct {
	ID         string
	X, Y, W, H int
	After      string
	To         string
	// Breakable 是挡在门里的东西的怪物模板（比如灌木）：砍掉它门才开（秘密房的入口）
	Breakable string
	// Key 是开这扇门要的钥匙名（LevelRoom.Key），不写不要钥匙
	Key string
}

// Bare 报告门是不是只是个挡路的东西（献祭坑的石柱）：不跟着哪个房间开关，只等里面的东西碎掉。
// 客户端不给它画栅栏，门里的实体本身就是它的样子。
func (gate *Gate) Bare() bool {
	return gate.After == "" && gate.To == "" && gate.Breakable != ""
}

// Center 是门的中心。
func (gate *Gate) Center() (float64, float64) {
	return float64(gate.X) + float64(gate.W)/2, float64(gate.Y) + float64(gate.H)/2
}

// Wave 是一波怪里的一种：模板和数量。写了 x、y 就刷在那附近（spread 以内），不写就在房间里离玩家远的地方随便刷。
type Wave struct {
	Template string `yaml:"template"`
	Count    int    `yaml:"count"`
	X        int    `yaml:"x"`
	Y        int    `yaml:"y"`
	Spread   int    `yaml:"spread"`
}

// At 报告这一种怪有没有指定刷怪点。
func (wave *Wave) At() bool { return wave.X != 0 || wave.Y != 0 }

// LevelRoom 是副本里一个房间的玩法（scenes.yaml 场景的 rooms）。
type LevelRoom struct {
	ID string `yaml:"id"` // 地图 rooms 图层里的房间名
	// Waves 是一波一波的怪，上一波全死了才刷下一波；没有波次的房间是安全屋，走进去就算清完
	Waves [][]Wave `yaml:"waves"`
	// Reward 是清完这个房间给房间里每个玩家的奖励：heal | gear | boon，不写没有。
	// 通往这个房间的门上会画出奖励的图标，玩家在岔路口能看见再选。
	Reward string `yaml:"reward"`
	// Excludes 是走进这个房间以后再也去不了的房间（岔路的另一边），通往它们的门永远关上
	Excludes []string `yaml:"excludes"`
	// Allies 是第一次有人走进来时刷出的友方 NPC（比如被狼围住的猎人）或机关（骨箭雕像），
	// 和普通 NPC 一样会复活，房间重置也不移走
	Allies []Wave `yaml:"allies"`
	// Dark 是暗房：客户端只照亮玩家身边一小圈和点着的灵火
	Dark bool `yaml:"dark"`
	// Key 是清完这个房间拿到的钥匙名（比如 守墓人钥匙），开地图上 key 属性相同的门
	Key string `yaml:"key"`
	// Skins 是清完这个房间解锁的皮肤（首次通关奖励，world.yaml 职业皮肤里写了 unlock 的），
	// 发给房间里的每个玩家，已经解锁过的不再提示
	Skins []string `yaml:"skins"`

	Area *RoomArea `yaml:"-"` // 地图上的范围，由 validateLevel 填上
}

// Dungeon 报告这个场景是不是副本。
func (scene *Scene) Dungeon() bool { return scene.Kind == SceneDungeon }

// Room 按 id 找房间的玩法配置，没配置的房间（只在地图里画了）返回 nil。
func (scene *Scene) Room(id string) *LevelRoom {
	for _, room := range scene.Rooms {
		if room.ID == id {
			return room
		}
	}
	return nil
}

// parseLevelLayers 读地图的 rooms、gates 和 water 图层（没有就跳过）。
func parseLevelLayers(layers []tmjLayer, layout *Layout) error {
	if rooms := findLayer(layers, "rooms"); rooms != nil {
		for _, obj := range rooms.Objects {
			x, y, w, h, err := objectRect(obj)
			if err != nil {
				return fmt.Errorf("rooms object %d: %w", obj.ID, err)
			}
			area := RoomArea{ID: obj.Name, X: x, Y: y, W: w, H: h}
			if area.ID == "" {
				return fmt.Errorf("rooms object %d needs a name (the room id)", obj.ID)
			}
			if err := stringProps(obj, map[string]*string{"title": &area.Title}); err != nil {
				return fmt.Errorf("rooms object %d: %w", obj.ID, err)
			}
			if area.Title == "" {
				area.Title = area.ID
			}
			layout.Rooms = append(layout.Rooms, area)
		}
	}
	if water := findLayer(layers, "water"); water != nil {
		for _, obj := range water.Objects {
			x, y, w, h, err := objectRect(obj)
			if err != nil {
				return fmt.Errorf("water object %d: %w", obj.ID, err)
			}
			layout.Water = append(layout.Water, RoomArea{ID: obj.Name, X: x, Y: y, W: w, H: h})
		}
	}
	if gates := findLayer(layers, "gates"); gates != nil {
		for _, obj := range gates.Objects {
			x, y, w, h, err := objectRect(obj)
			if err != nil {
				return fmt.Errorf("gates object %d: %w", obj.ID, err)
			}
			gate := Gate{ID: obj.Name, X: x, Y: y, W: w, H: h}
			if gate.ID == "" {
				gate.ID = fmt.Sprintf("gate%d", obj.ID)
			}
			props := map[string]*string{
				"after":     &gate.After,
				"to":        &gate.To,
				"breakable": &gate.Breakable,
				"key":       &gate.Key,
			}
			if err := stringProps(obj, props); err != nil {
				return fmt.Errorf("gates object %d: %w", obj.ID, err)
			}
			layout.Gates = append(layout.Gates, gate)
		}
	}
	return nil
}

// objectRect 把矩形对象的位置和大小向下取整成整数像素。
func objectRect(obj tmjObject) (x, y, w, h int, err error) {
	values := []float64{obj.X, obj.Y, obj.Width, obj.Height}
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return 0, 0, 0, 0, errors.New("needs a finite position and size")
		}
	}
	if obj.Point || len(obj.Polyline) > 0 || obj.Width < 1 || obj.Height < 1 {
		return 0, 0, 0, 0, errors.New("must be a rectangle")
	}
	x, y = int(math.Floor(obj.X)), int(math.Floor(obj.Y))
	w, h = int(math.Floor(obj.Width)), int(math.Floor(obj.Height))
	return x, y, w, h, nil
}

// stringProps 读对象的字符串属性，只认 targets 里列出的名字。
func stringProps(obj tmjObject, targets map[string]*string) error {
	for _, raw := range obj.Properties {
		target, ok := targets[raw.Name]
		if !ok {
			continue
		}
		if err := json.Unmarshal(raw.Value, target); err != nil {
			return fmt.Errorf("property %s must be a string", raw.Name)
		}
	}
	return nil
}

// validateLevel 检查副本场景的房间、门、波次和祝福；不是副本的场景不能有这些。
func (cfg *Config) validateLevel(scene *Scene, label string) error {
	layout := &scene.Layout
	if !scene.Dungeon() {
		if scene.Kind != "" {
			return fmt.Errorf("%s: unknown kind %q (only %q)", label, scene.Kind, SceneDungeon)
		}
		levelParts := len(scene.Rooms) + len(scene.Boons) + len(layout.Rooms) + len(layout.Gates)
		if levelParts > 0 {
			return fmt.Errorf(
				"%s: rooms, gates and boons are only for kind: %s",
				label,
				SceneDungeon,
			)
		}
		return nil
	}
	areas := map[string]*RoomArea{}
	for i := range layout.Rooms {
		area := &layout.Rooms[i]
		if areas[area.ID] != nil {
			return fmt.Errorf("%s: map room %q appears twice", label, area.ID)
		}
		offMap := area.X < 0 || area.Y < 0 ||
			area.X+area.W > layout.Width || area.Y+area.H > layout.Height
		if offMap {
			return fmt.Errorf("%s: map room %q is off the map", label, area.ID)
		}
		areas[area.ID] = area
	}
	for _, gate := range layout.Gates {
		for _, ref := range []string{gate.After, gate.To} {
			if ref != "" && areas[ref] == nil {
				return fmt.Errorf("%s: gate %s refers to unknown room %q", label, gate.ID, ref)
			}
		}
		if gate.Breakable != "" && cfg.Templates[gate.Breakable] == nil {
			return fmt.Errorf(
				"%s: gate %s has unknown breakable template %q",
				label,
				gate.ID,
				gate.Breakable,
			)
		}
	}
	needBoons := false
	seen := map[string]bool{}
	for _, room := range scene.Rooms {
		owner := fmt.Sprintf("%s: room %s", label, room.ID)
		if room.Area = areas[room.ID]; room.Area == nil {
			return fmt.Errorf("%s is not in the map's rooms layer", owner)
		}
		if seen[room.ID] {
			return fmt.Errorf("%s is listed twice", owner)
		}
		seen[room.ID] = true
		if !slices.Contains([]string{"", RewardHeal, RewardGear, RewardBoon}, room.Reward) {
			return fmt.Errorf("%s has unknown reward %q", owner, room.Reward)
		}
		needBoons = needBoons || room.Reward == RewardBoon
		for _, excluded := range room.Excludes {
			if areas[excluded] == nil || excluded == room.ID {
				return fmt.Errorf("%s excludes unknown room %q", owner, excluded)
			}
		}
		for _, skinID := range room.Skins {
			if skin := cfg.World.Player.FindSkin(skinID); skin == nil || skin.Unlock == "" {
				return fmt.Errorf("%s gives skin %q, which is not a locked class skin", owner, skinID)
			}
		}
		for _, ally := range room.Allies {
			if cfg.Templates[ally.Template] == nil || ally.Count <= 0 {
				return fmt.Errorf(
					"%s: ally has unknown template %q or count <= 0",
					owner,
					ally.Template,
				)
			}
		}
		for i, wave := range room.Waves {
			if len(wave) == 0 {
				return fmt.Errorf("%s: wave %d is empty", owner, i+1)
			}
			for _, group := range wave {
				if cfg.Templates[group.Template] == nil || group.Count <= 0 {
					return fmt.Errorf(
						"%s: wave %d has unknown template %q or count <= 0",
						owner,
						i+1,
						group.Template,
					)
				}
			}
		}
	}
	keys := map[string]bool{}
	for _, room := range scene.Rooms {
		if room.Key != "" {
			keys[room.Key] = true
		}
	}
	for _, gate := range layout.Gates {
		if gate.Key != "" && !keys[gate.Key] {
			return fmt.Errorf("%s: gate %s needs key %q but no room gives it", label, gate.ID, gate.Key)
		}
	}
	if needBoons && len(scene.Boons) == 0 {
		return fmt.Errorf("%s: a room rewards a boon but the scene has no boons", label)
	}
	for i, boon := range scene.Boons {
		if boon.Name == "" || boon.Duration <= 0 {
			return fmt.Errorf("%s: boons[%d] needs a name and a positive duration", label, i)
		}
		boon.Keep = true // 祝福死了也不掉，出副本才清掉
		if boon.Look != "" && Looks[boon.Look] == 0 {
			return fmt.Errorf("%s: boons[%d] has unknown look %q", label, i, boon.Look)
		}
	}
	return nil
}
