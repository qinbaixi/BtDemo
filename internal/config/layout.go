package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// MapFile 是地图文件名：用 Tiled 编辑器（https://www.mapeditor.org）编辑的 JSON 地图。
// 服务端从里面读碰撞，前端通过 /map.tmj 读同一个文件来画场景。
const MapFile = "map.tmj"

// Layout 是从 map.tmj 读出的、服务端关心的部分：场景物件的摆放，以及每种物件的碰撞形状。
// 地表区域（zones）和道路（roads）只有前端用，服务端不解析。
type Layout struct {
	Width, Height int              // 地图像素尺寸（格子数 × 格子边长），必须和 world.yaml 一致
	Shapes        map[string]Shape // 物件种类 -> 碰撞形状
	Props         []Prop
	Portals       []Portal
	Rooms         []RoomArea // 关卡的房间（rooms 图层），只有副本地图有
	Gates         []Gate     // 关卡的门（gates 图层），只有副本地图有
	Water         []RoomArea // 积水（water 图层的矩形），站在里面走得慢
	Source        []byte     // map.tmj 原文，原样提供给浏览器
}

// Shape 是相对于场景物件落脚点（缩放前）的碰撞形状。
// 至多设置其中一个字段；若都不设置，则该类型不阻挡移动。
type Shape struct {
	Circle  []float64 // cx, cy, r
	Rect    []float64 // x0, y0, x1, y1
	Capsule float64   // 沿场景物件 dx/dy 线段方向的半径
}

// Prop 是放置的一个场景物件。
type Prop struct {
	Kind    string
	X       float64
	Y       float64
	Scale   float64
	Variant int
	Flip    bool
	DX      float64
	DY      float64
}

// Portal 是地图上通往另一个场景的传送门（portals 图层的点对象，类为 portal）。
// 玩家站进半径 Radius 的圆里一会儿就被送到场景 To，落在那个场景里通回来的传送门旁边。
type Portal struct {
	Name   string
	To     string // 目标场景 id（scenes.yaml）
	X, Y   int    // 像素；Tiled 里的小数坐标读入时向下取整
	Radius int
}

// DefaultPortalRadius 是传送门不写 r 属性时的半径。
const DefaultPortalRadius = 36

// tmjMap 是 Tiled JSON 地图格式里我们用到的字段。
type tmjMap struct {
	Orientation string     `json:"orientation"`
	Infinite    bool       `json:"infinite"`
	Width       int        `json:"width"`
	Height      int        `json:"height"`
	TileWidth   int        `json:"tilewidth"`
	TileHeight  int        `json:"tileheight"`
	Properties  []tmjProp  `json:"properties"`
	Layers      []tmjLayer `json:"layers"`
}

type tmjLayer struct {
	Name    string      `json:"name"`
	Type    string      `json:"type"`
	Objects []tmjObject `json:"objects"`
	Layers  []tmjLayer  `json:"layers"` // 图层组
}

type tmjObject struct {
	ID         int       `json:"id"`
	Name       string    `json:"name"`
	Type       string    `json:"type"`
	Class      string    `json:"class"` // Tiled 1.9 用 class，1.10 起又改回 type
	X          float64   `json:"x"`
	Y          float64   `json:"y"`
	Width      float64   `json:"width"`
	Height     float64   `json:"height"`
	Point      bool      `json:"point"`
	Polyline   []tmjPt   `json:"polyline"`
	Template   string    `json:"template"`
	Properties []tmjProp `json:"properties"`
}

type tmjPt struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type tmjProp struct {
	Name  string          `json:"name"`
	Value json.RawMessage `json:"value"`
}

// loadLayout 从 dir 读取 map.tmj。若文件不存在，则表示地图是开放的（无阻挡）。
func loadLayout(dir string) (Layout, error) {
	data, err := os.ReadFile(filepath.Join(dir, MapFile))
	if errors.Is(err, fs.ErrNotExist) {
		return Layout{}, nil
	}
	if err != nil {
		return Layout{}, err
	}
	layout, err := parseLayout(data)
	if err != nil {
		return Layout{}, fmt.Errorf("%s: %w", MapFile, err)
	}
	layout.Source = data
	return layout, nil
}

// parseLayout 解析 Tiled 地图：
//   - 地图属性 shape.<种类>：该种类的碰撞形状，见 parseShape；
//   - 对象图层 props：每个对象是一个物件，对象的“类”（class）是物件种类。
//     点对象放在脚下的位置；折线对象（两个点）是一段墙，从第一点到第二点。
//     自定义属性 s 缩放（默认 1）、v 外观变体（默认 0）、flip 水平翻转。
func parseLayout(data []byte) (Layout, error) {
	var mapData tmjMap
	if err := json.Unmarshal(data, &mapData); err != nil {
		return Layout{}, err
	}
	if mapData.Orientation != "orthogonal" || mapData.Infinite {
		return Layout{}, errors.New("map must be orthogonal and not infinite")
	}
	if mapData.Width <= 0 || mapData.Height <= 0 || mapData.TileWidth <= 0 ||
		mapData.TileHeight <= 0 {
		return Layout{}, errors.New("map width, height, tilewidth and tileheight must be positive")
	}
	layout := Layout{
		Width:  mapData.Width * mapData.TileWidth,
		Height: mapData.Height * mapData.TileHeight,
		Shapes: map[string]Shape{},
	}
	for _, raw := range mapData.Properties {
		kind, ok := strings.CutPrefix(raw.Name, "shape.")
		if !ok {
			continue
		}
		var text string
		if err := json.Unmarshal(raw.Value, &text); err != nil {
			return layout, fmt.Errorf("map property %s must be a string", raw.Name)
		}
		shape, err := parseShape(text)
		if err != nil {
			return layout, fmt.Errorf("map property %s: %w", raw.Name, err)
		}
		layout.Shapes[kind] = shape
	}
	if portals := findLayer(mapData.Layers, "portals"); portals != nil {
		for _, obj := range portals.Objects {
			portal, err := parsePortal(obj)
			if err != nil {
				return layout, fmt.Errorf("portals object %d: %w", obj.ID, err)
			}
			layout.Portals = append(layout.Portals, portal)
		}
	}
	if err := parseLevelLayers(mapData.Layers, &layout); err != nil {
		return layout, err
	}
	layer := findLayer(mapData.Layers, "props")
	if layer == nil {
		return layout, nil
	}
	for _, obj := range layer.Objects {
		prop, err := parseProp(obj)
		if err != nil {
			return layout, fmt.Errorf("props object %d: %w", obj.ID, err)
		}
		shape, ok := layout.Shapes[prop.Kind]
		if !ok {
			return layout, fmt.Errorf(
				"props object %d has class %q without a shape.%s map property (use \"none\" for decor that does not block)",
				obj.ID,
				prop.Kind,
				prop.Kind,
			)
		}
		if shape.Capsule != 0 && prop.DX == 0 && prop.DY == 0 {
			return layout, fmt.Errorf(
				"props object %d (%s) must be a two-point polyline for its capsule shape",
				obj.ID,
				prop.Kind,
			)
		}
		layout.Props = append(layout.Props, prop)
	}
	return layout, nil
}

// findLayer 按名字找对象图层，会进入图层组查找。
func findLayer(layers []tmjLayer, name string) *tmjLayer {
	for i := range layers {
		if layers[i].Type == "objectgroup" && layers[i].Name == name {
			return &layers[i]
		}
		if found := findLayer(layers[i].Layers, name); found != nil {
			return found
		}
	}
	return nil
}

// parsePortal 解析一个传送门：点对象，属性 to 是目标场景，r 是半径（默认 DefaultPortalRadius）。
// 坐标和半径向下取整成整数像素。
func parsePortal(obj tmjObject) (Portal, error) {
	portal := Portal{Name: obj.Name, Radius: DefaultPortalRadius}
	if math.IsNaN(obj.X) || math.IsNaN(obj.Y) || math.IsInf(obj.X, 0) || math.IsInf(obj.Y, 0) {
		return portal, errors.New("portal needs a finite position")
	}
	portal.X, portal.Y = int(math.Floor(obj.X)), int(math.Floor(obj.Y))
	if !obj.Point {
		return portal, errors.New("portal must be a point")
	}
	for _, raw := range obj.Properties {
		var err error
		switch raw.Name {
		case "to":
			err = json.Unmarshal(raw.Value, &portal.To)
		case "r":
			var radius float64
			err = json.Unmarshal(raw.Value, &radius)
			if math.IsNaN(radius) || math.IsInf(radius, 0) {
				radius = 0
			}
			portal.Radius = int(math.Floor(radius))
		}
		if err != nil {
			return portal, fmt.Errorf("property %s: %w", raw.Name, err)
		}
	}
	if portal.To == "" {
		return portal, errors.New("portal needs a to property (the scene it leads to)")
	}
	if portal.Radius <= 0 {
		return portal, errors.New("portal needs a positive radius")
	}
	if portal.Name == "" {
		portal.Name = "to_" + portal.To
	}
	return portal, nil
}

func parseProp(obj tmjObject) (Prop, error) {
	prop := Prop{Kind: obj.Type, X: obj.X, Y: obj.Y, Scale: 1}
	if prop.Kind == "" {
		prop.Kind = obj.Class
	}
	if obj.Template != "" {
		return prop, errors.New("object templates are not supported; detach the template in Tiled")
	}
	if prop.Kind == "" {
		return prop, errors.New("has no class (set it to the prop kind, e.g. house)")
	}
	for _, raw := range obj.Properties {
		var err error
		switch raw.Name {
		case "s":
			err = json.Unmarshal(raw.Value, &prop.Scale)
		case "v":
			err = json.Unmarshal(raw.Value, &prop.Variant)
		case "flip":
			err = json.Unmarshal(raw.Value, &prop.Flip)
		}
		if err != nil {
			return prop, fmt.Errorf("(%s) property %s: %w", prop.Kind, raw.Name, err)
		}
	}
	if !(prop.Scale > 0) || math.IsInf(prop.Scale, 0) {
		return prop, fmt.Errorf("(%s) s must be positive", prop.Kind)
	}
	switch {
	case len(obj.Polyline) == 2:
		// 墙段：起点是第一个点，dx/dy 是未缩放的偏移（随 s 缩放后等于折线的长度）
		from, to := obj.Polyline[0], obj.Polyline[1]
		prop.X, prop.Y = obj.X+from.X, obj.Y+from.Y
		prop.DX, prop.DY = (to.X-from.X)/prop.Scale, (to.Y-from.Y)/prop.Scale
	case obj.Polyline != nil:
		return prop, fmt.Errorf("(%s) polyline must have exactly two points", prop.Kind)
	case !obj.Point:
		return prop, fmt.Errorf("(%s) must be a point or a two-point polyline", prop.Kind)
	}
	for _, value := range []float64{prop.X, prop.Y, prop.DX, prop.DY} {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return prop, fmt.Errorf("(%s) has a non-finite number", prop.Kind)
		}
	}
	return prop, nil
}

// parseShape 解析碰撞形状字符串，坐标相对脚下的点，随 s 缩放，flip 时左右镜像：
//
//	circle cx cy r          圆
//	rect x0 y0 x1 y1        轴对齐矩形
//	capsule r               墙专用：沿墙段、半径为 r 的胶囊体
//	none                    不挡路的装饰
func parseShape(text string) (Shape, error) {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return Shape{}, errors.New(`empty shape (use "none" for decor)`)
	}
	nums := make([]float64, len(fields)-1)
	for i, x := range fields[1:] {
		value, err := strconv.ParseFloat(x, 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
			return Shape{}, fmt.Errorf("bad number %q", x)
		}
		nums[i] = value
	}
	switch fields[0] {
	case "none":
		if len(nums) == 0 {
			return Shape{}, nil
		}
	case "circle":
		if len(nums) == 3 && nums[2] > 0 {
			return Shape{Circle: nums}, nil
		}
		return Shape{}, errors.New("circle needs cx cy r with r > 0")
	case "rect":
		if len(nums) == 4 && nums[0] < nums[2] && nums[1] < nums[3] {
			return Shape{Rect: nums}, nil
		}
		return Shape{}, errors.New("rect needs x0 y0 x1 y1 with x0 < x1 and y0 < y1")
	case "capsule":
		if len(nums) == 1 && nums[0] > 0 {
			return Shape{Capsule: nums[0]}, nil
		}
		return Shape{}, errors.New("capsule needs a positive radius")
	}
	return Shape{}, fmt.Errorf("unknown shape %q (circle, rect, capsule or none)", text)
}
