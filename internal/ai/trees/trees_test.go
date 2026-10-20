package trees

import (
	"path/filepath"
	"strings"
	"testing"
)

// Every tree in the owl-bt project must have been exported and registered.
func TestEveryTreeIsExported(t *testing.T) {
	files, err := filepath.Glob("../../../bt/trees/*.json")
	if err != nil || len(files) == 0 {
		t.Fatalf("no trees found: %v", err)
	}
	for _, f := range files {
		name := strings.TrimSuffix(filepath.Base(f), ".json")
		if _, ok := All[name]; !ok {
			t.Errorf("%s is not exported; run the owl-bt Go export and go generate ./internal/ai/trees", f)
		}
	}
	if len(All) != len(files) {
		t.Errorf("registry has %d trees, bt/trees has %d", len(All), len(files))
	}
}
