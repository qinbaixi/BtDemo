package config

import (
	"errors"
	"fmt"
	"io/fs"
	"math"
	"path/filepath"
)

// Layout 对应 map.yaml：阻挡移动的场景物件，以及每种场景物件类型的碰撞形状。
type Layout struct {
	Shapes map[string]Shape `yaml:"shapes"`
	Props  []Prop           `yaml:"props"`
}

// Shape 是相对于场景物件落脚点（缩放前）的碰撞形状。
// 至多设置其中一个字段；若都不设置，则该类型不阻挡移动。
type Shape struct {
	Circle  []float64 `yaml:"circle"`  // cx, cy, r
	Rect    []float64 `yaml:"rect"`    // x0, y0, x1, y1
	Capsule float64   `yaml:"capsule"` // 沿场景物件 dx/dy 线段方向的半径
}

// Prop 是放置的一个场景物件。
type Prop struct {
	Kind    string  `yaml:"kind"`
	X       float64 `yaml:"x"`
	Y       float64 `yaml:"y"`
	S       float64 `yaml:"s"`
	Variant int     `yaml:"v"`
	Flip    bool    `yaml:"flip"`
	DX      float64 `yaml:"dx"`
	DY      float64 `yaml:"dy"`
}

// loadLayout 从 dir 读取 map.yaml。若文件不存在，则表示地图是开放的（无阻挡）。
func loadLayout(dir string) (Layout, error) {
	var m Layout
	err := readYAML(filepath.Join(dir, "map.yaml"), &m)
	if errors.Is(err, fs.ErrNotExist) {
		return Layout{}, nil
	}
	if err != nil {
		return m, err
	}
	for name, sh := range m.Shapes {
		n := 0
		if sh.Circle != nil {
			n++
			if len(sh.Circle) != 3 || sh.Circle[2] <= 0 {
				return m, fmt.Errorf("map.yaml: shape %s: circle needs [cx, cy, r] with r > 0", name)
			}
		}
		if sh.Rect != nil {
			n++
			if len(sh.Rect) != 4 || sh.Rect[0] >= sh.Rect[2] || sh.Rect[1] >= sh.Rect[3] {
				return m, fmt.Errorf("map.yaml: shape %s: rect needs [x0, y0, x1, y1] with x0 < x1 and y0 < y1", name)
			}
		}
		if sh.Capsule != 0 {
			n++
			if sh.Capsule < 0 {
				return m, fmt.Errorf("map.yaml: shape %s: capsule radius must be positive", name)
			}
		}
		if n > 1 {
			return m, fmt.Errorf("map.yaml: shape %s must have only one of circle, rect, capsule", name)
		}
		for _, v := range append(append([]float64{sh.Capsule}, sh.Circle...), sh.Rect...) {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return m, fmt.Errorf("map.yaml: shape %s has a non-finite number", name)
			}
		}
	}
	for i := range m.Props {
		p := &m.Props[i]
		if p.S == 0 {
			p.S = 1
		}
		if !(p.S > 0) || math.IsInf(p.S, 0) {
			return m, fmt.Errorf("map.yaml: prop %d (%s): s must be positive", i+1, p.Kind)
		}
		for _, v := range []float64{p.X, p.Y, p.DX, p.DY} {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return m, fmt.Errorf("map.yaml: prop %d (%s) has a non-finite number", i+1, p.Kind)
			}
		}
		sh, ok := m.Shapes[p.Kind]
		if !ok {
			return m, fmt.Errorf("map.yaml: prop %d has kind %q missing from shapes (use {} for decor that does not block)", i+1, p.Kind)
		}
		if sh.Capsule != 0 && p.DX == 0 && p.DY == 0 {
			return m, fmt.Errorf("map.yaml: prop %d (%s) needs dx or dy for its capsule shape", i+1, p.Kind)
		}
	}
	return m, nil
}
