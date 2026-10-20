// Package trees holds the behavior trees exported from the owl-bt project in
// bt/ (one Go file per tree, written by BtTree's "Export: Go"), plus
// registry.go, which lists them by name.
//
// To update after editing a tree in BtTree:
//
//	owlbt export bt --format go   # or "Export: Go" in the editor
//	go generate ./internal/ai/trees
package trees

//go:generate go run ../../../tools/btregistry

// Exported is the data owl-bt generates for one tree.
type Exported struct {
	RootID int
	Nodes  map[int]map[string]any
}
