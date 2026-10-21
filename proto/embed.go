// Package btproto 嵌入协议定义，使服务器能将其交给浏览器；浏览器会在运行时用 protobuf.js 解析它。
package btproto

import _ "embed"

// Source 是 btdemo.proto 的内容。
//
//go:embed btdemo.proto
var Source []byte
