// Package web 嵌入浏览器客户端。
//
// 前端源码在 web/src（TypeScript + Vite），`npm run build` 把构建产物输出到 web/dist，
// 这里把 dist 嵌进服务端二进制。dist 里只提交了一个占位文件 .gitkeep（由 web/public
// 每次构建时复制回去），所以没构建前端也能编译服务端，只是首页会提示先构建。
package web

import (
	"embed"
	"io/fs"
	"testing/fstest"
)

//go:embed all:dist
var files embed.FS

// FS 是客户端的静态文件（index.html、assets/*）。
var FS = load()

// Built 表示是否嵌入了构建好的前端。
var Built bool

const notBuilt = `<!doctype html><meta charset="utf-8"><title>BtDemo</title>
<body style="font:16px sans-serif;background:#111;color:#eee;padding:40px">
<h2>前端还没有构建</h2>
<p>在 web 目录运行 <code>npm ci</code> 和 <code>npm run build</code>，再重新编译服务端。</p>
<p>Windows 直接运行 start.bat 会自动完成这些步骤。</p>`

func load() fs.FS {
	sub, err := fs.Sub(files, "dist")
	if err == nil {
		if _, err = fs.Stat(sub, "index.html"); err == nil {
			Built = true
			return sub
		}
	}
	return fstest.MapFS{"index.html": {Data: []byte(notBuilt)}}
}
