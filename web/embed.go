// Package web 嵌入浏览器客户端。
package web

import (
	"embed"
	"io/fs"
)

//go:embed static
var files embed.FS

// FS 是客户端的静态文件（index.html、main.js 等）。
var FS, _ = fs.Sub(files, "static")
