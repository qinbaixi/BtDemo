package config

import (
	"strings"
	"testing"
)

// tmj 拼出一张 64x64 的最小地图，shapes 是地图属性，objects 是 props 图层里的对象。
func tmj(shapes, objects string) []byte {
	return []byte(`{"orientation":"orthogonal","width":2,"height":2,"tilewidth":32,"tileheight":32,
"properties":[` + shapes + `],
"layers":[{"type":"objectgroup","name":"props","objects":[` + objects + `]}]}`)
}

func TestLayoutRejectsBadMaps(t *testing.T) {
	rock := `{"name":"shape.rock","type":"string","value":"circle 0 0 5"}`
	for name, body := range map[string][]byte{
		"unknown kind":  tmj(rock, `{"id":1,"type":"rokc","x":10,"y":10,"point":true}`),
		"no class":      tmj(rock, `{"id":1,"x":10,"y":10,"point":true}`),
		"zero scale":    tmj(rock, `{"id":1,"type":"rock","x":10,"y":10,"point":true,"properties":[{"name":"s","type":"float","value":0}]}`),
		"bad shape":     tmj(`{"name":"shape.rock","value":"circle 0 0"}`, ``),
		"nan shape":     tmj(`{"name":"shape.rock","value":"circle 0 0 NaN"}`, ``),
		"rectangle obj": tmj(rock, `{"id":1,"type":"rock","x":10,"y":10,"width":4,"height":4}`),
		"wall as point": tmj(`{"name":"shape.wall","value":"capsule 8"}`, `{"id":1,"type":"wall","x":10,"y":10,"point":true}`),
		"long polyline": tmj(`{"name":"shape.wall","value":"capsule 8"}`, `{"id":1,"type":"wall","x":10,"y":10,"polyline":[{"x":0,"y":0},{"x":5,"y":0},{"x":5,"y":5}]}`),
		"infinite":      []byte(`{"orientation":"orthogonal","infinite":true}`),
	} {
		if _, err := parseLayout(body); err == nil {
			t.Errorf("%s: parsed without error", name)
		}
	}
}

func TestLayoutReadsPropsAndWalls(t *testing.T) {
	shapes := `{"name":"shape.bush","value":"none"},{"name":"shape.wall","value":"capsule 8"},{"name":"shape.rock","value":"rect -2 -2 2 2"}`
	objects := `{"id":1,"class":"bush","x":10,"y":12,"point":true},
{"id":2,"type":"wall","x":20,"y":20,"polyline":[{"x":2,"y":0},{"x":12,"y":10}],"properties":[{"name":"s","type":"float","value":2}]},
{"id":3,"type":"rock","x":30,"y":30,"point":true,"properties":[{"name":"v","type":"int","value":2},{"name":"flip","type":"bool","value":true}]}`
	l, err := parseLayout(tmj(shapes, objects))
	if err != nil {
		t.Fatal(err)
	}
	if l.Width != 64 || l.Height != 64 || len(l.Props) != 3 {
		t.Fatalf("got %vx%v with %d props", l.Width, l.Height, len(l.Props))
	}
	if p := l.Props[0]; p.Kind != "bush" || p.X != 10 || p.Y != 12 || p.S != 1 {
		t.Errorf("bush (Tiled 1.9 class field): %+v", p)
	}
	// 墙从折线第一点开始，dx/dy 是除以 s 之后的偏移
	if p := l.Props[1]; p.X != 22 || p.Y != 20 || p.DX != 5 || p.DY != 5 || p.S != 2 {
		t.Errorf("wall: %+v", p)
	}
	if p := l.Props[2]; p.Variant != 2 || !p.Flip {
		t.Errorf("rock: %+v", p)
	}
	if sh := l.Shapes["bush"]; sh.Circle != nil || sh.Rect != nil || sh.Capsule != 0 {
		t.Errorf("none shape: %+v", sh)
	}
}

func TestLayoutMissingFileIsOpenMap(t *testing.T) {
	l, err := loadLayout(t.TempDir())
	if err != nil || len(l.Props) != 0 || l.Source != nil {
		t.Fatalf("got %+v, %v", l, err)
	}
	if _, err := parseLayout([]byte(`{`)); err == nil || !strings.Contains(err.Error(), "JSON") {
		t.Errorf("bad JSON: %v", err)
	}
}
