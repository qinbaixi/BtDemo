package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLayoutRejectsUnknownKindAndNaN(t *testing.T) {
	for name, body := range map[string]string{
		"unknown kind": "shapes:\n  rock: { circle: [0, 0, 5] }\nprops:\n  - { kind: rokc, x: 10, y: 10 }\n",
		"nan scale":    "shapes:\n  rock: { circle: [0, 0, 5] }\nprops:\n  - { kind: rock, x: 10, y: 10, s: .nan }\n",
		"two shapes":   "shapes:\n  rock: { circle: [0, 0, 5], capsule: 3 }\nprops: []\n",
	} {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "map.yaml"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := loadLayout(dir); err == nil {
			t.Errorf("%s: loaded without error", name)
		}
	}
	dir := t.TempDir()
	ok := "shapes:\n  rock: { circle: [0, 0, 5] }\n  bush: {}\nprops:\n  - { kind: bush, x: 10, y: 10 }\n"
	if err := os.WriteFile(filepath.Join(dir, "map.yaml"), []byte(ok), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadLayout(dir); err != nil {
		t.Errorf("decor kind with {} shape: %v", err)
	}
}
