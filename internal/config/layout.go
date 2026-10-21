package config

import (
	"errors"
	"fmt"
	"io/fs"
	"math"
	"path/filepath"
)

// Layout is map.yaml: the props that block movement and the collision shape
// of each prop kind.
type Layout struct {
	Shapes map[string]Shape `yaml:"shapes"`
	Props  []Prop           `yaml:"props"`
}

// Shape is a collision shape relative to a prop's foot point, before scaling.
// At most one of the fields is set; none means the kind does not block.
type Shape struct {
	Circle  []float64 `yaml:"circle"`  // cx, cy, r
	Rect    []float64 `yaml:"rect"`    // x0, y0, x1, y1
	Capsule float64   `yaml:"capsule"` // radius along the prop's dx/dy segment
}

// Prop is one placed prop.
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

// loadLayout reads map.yaml from dir. A missing file means an open map.
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
