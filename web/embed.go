// Package web embeds the browser client.
package web

import (
	"embed"
	"io/fs"
)

//go:embed static
var files embed.FS

// FS is the client's static files (index.html, main.js, ...).
var FS, _ = fs.Sub(files, "static")
