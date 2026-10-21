// Package trees 存放从 owl-bt 项目 bt/ 目录导出的行为树（每棵树对应一个 Go 文件，
// 由 BtTree 的 "Export: Go" 写出），以及按名称列出这些树的 registry.go。
//
// 在 BtTree 中编辑某棵树后，按以下步骤更新：
//
//	owlbt export bt --format go   # 或在编辑器里点 "Export: Go"
//	go generate ./internal/ai/trees
package trees

//go:generate go run ../../../tools/btregistry

// Exported 是 owl-bt 为一棵树生成的数据。
type Exported struct {
	RootID int
	Nodes  map[int]map[string]any
}
