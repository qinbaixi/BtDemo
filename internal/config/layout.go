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
	Width, Height float64          // 地图像素尺寸（格子数 × 格子边长），必须和 world.yaml 一致
	Shapes        map[string]Shape // 物件种类 -> 碰撞形状
	Props         []Prop
	Source        []byte // map.tmj 原文，原样提供给浏览器
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
	S       float64
	Variant int
	Flip    bool
	DX      float64
	DY      float64
}

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
	Type       string    `json:"type"`
	Class      string    `json:"class"` // Tiled 1.9 用 class，1.10 起又改回 type
	X          float64   `json:"x"`
	Y          float64   `json:"y"`
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
	l, err := parseLayout(data)
	if err != nil {
		return Layout{}, fmt.Errorf("%s: %w", MapFile, err)
	}
	l.Source = data
	return l, nil
}

// parseLayout 解析 Tiled 地图：
//   - 地图属性 shape.<种类>：该种类的碰撞形状，见 parseShape；
//   - 对象图层 props：每个对象是一个物件，对象的“类”（class）是物件种类。
//     点对象放在脚下的位置；折线对象（两个点）是一段墙，从第一点到第二点。
//     自定义属性 s 缩放（默认 1）、v 外观变体（默认 0）、flip 水平翻转。
func parseLayout(data []byte) (Layout, error) {
	var m tmjMap
	if err := json.Unmarshal(data, &m); err != nil {
		return Layout{}, err
	}
	if m.Orientation != "orthogonal" || m.Infinite {
		return Layout{}, errors.New("map must be orthogonal and not infinite")
	}
	if m.Width <= 0 || m.Height <= 0 || m.TileWidth <= 0 || m.TileHeight <= 0 {
		return Layout{}, errors.New("map width, height, tilewidth and tileheight must be positive")
	}
	l := Layout{
		Width:  float64(m.Width * m.TileWidth),
		Height: float64(m.Height * m.TileHeight),
		Shapes: map[string]Shape{},
	}
	for _, p := range m.Properties {
		kind, ok := strings.CutPrefix(p.Name, "shape.")
		if !ok {
			continue
		}
		var s string
		if err := json.Unmarshal(p.Value, &s); err != nil {
			return l, fmt.Errorf("map property %s must be a string", p.Name)
		}
		sh, err := parseShape(s)
		if err != nil {
			return l, fmt.Errorf("map property %s: %w", p.Name, err)
		}
		l.Shapes[kind] = sh
	}
	layer := findLayer(m.Layers, "props")
	if layer == nil {
		return l, nil
	}
	for _, o := range layer.Objects {
		p, err := parseProp(o)
		if err != nil {
			return l, fmt.Errorf("props object %d: %w", o.ID, err)
		}
		sh, ok := l.Shapes[p.Kind]
		if !ok {
			return l, fmt.Errorf("props object %d has class %q without a shape.%s map property (use \"none\" for decor that does not block)", o.ID, p.Kind, p.Kind)
		}
		if sh.Capsule != 0 && p.DX == 0 && p.DY == 0 {
			return l, fmt.Errorf("props object %d (%s) must be a two-point polyline for its capsule shape", o.ID, p.Kind)
		}
		l.Props = append(l.Props, p)
	}
	return l, nil
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

func parseProp(o tmjObject) (Prop, error) {
	p := Prop{Kind: o.Type, X: o.X, Y: o.Y, S: 1}
	if p.Kind == "" {
		p.Kind = o.Class
	}
	if o.Template != "" {
		return p, errors.New("object templates are not supported; detach the template in Tiled")
	}
	if p.Kind == "" {
		return p, errors.New("has no class (set it to the prop kind, e.g. house)")
	}
	for _, pr := range o.Properties {
		var err error
		switch pr.Name {
		case "s":
			err = json.Unmarshal(pr.Value, &p.S)
		case "v":
			err = json.Unmarshal(pr.Value, &p.Variant)
		case "flip":
			err = json.Unmarshal(pr.Value, &p.Flip)
		}
		if err != nil {
			return p, fmt.Errorf("(%s) property %s: %w", p.Kind, pr.Name, err)
		}
	}
	if !(p.S > 0) || math.IsInf(p.S, 0) {
		return p, fmt.Errorf("(%s) s must be positive", p.Kind)
	}
	switch {
	case len(o.Polyline) == 2:
		// 墙段：起点是第一个点，dx/dy 是未缩放的偏移（随 s 缩放后等于折线的长度）
		a, b := o.Polyline[0], o.Polyline[1]
		p.X, p.Y = o.X+a.X, o.Y+a.Y
		p.DX, p.DY = (b.X-a.X)/p.S, (b.Y-a.Y)/p.S
	case o.Polyline != nil:
		return p, fmt.Errorf("(%s) polyline must have exactly two points", p.Kind)
	case !o.Point:
		return p, fmt.Errorf("(%s) must be a point or a two-point polyline", p.Kind)
	}
	for _, v := range []float64{p.X, p.Y, p.DX, p.DY} {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return p, fmt.Errorf("(%s) has a non-finite number", p.Kind)
		}
	}
	return p, nil
}

// parseShape 解析碰撞形状字符串，坐标相对脚下的点，随 s 缩放，flip 时左右镜像：
//
//	circle cx cy r          圆
//	rect x0 y0 x1 y1        轴对齐矩形
//	capsule r               墙专用：沿墙段、半径为 r 的胶囊体
//	none                    不挡路的装饰
func parseShape(s string) (Shape, error) {
	f := strings.Fields(s)
	if len(f) == 0 {
		return Shape{}, errors.New(`empty shape (use "none" for decor)`)
	}
	nums := make([]float64, len(f)-1)
	for i, x := range f[1:] {
		v, err := strconv.ParseFloat(x, 64)
		if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
			return Shape{}, fmt.Errorf("bad number %q", x)
		}
		nums[i] = v
	}
	switch f[0] {
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
	return Shape{}, fmt.Errorf("unknown shape %q (circle, rect, capsule or none)", s)
}
