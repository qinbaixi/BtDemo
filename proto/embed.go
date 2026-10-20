// Package btproto embeds the protocol definition so the server can hand it to
// the browser, which parses it at runtime with protobuf.js.
package btproto

import _ "embed"

// Source is the contents of btdemo.proto.
//
//go:embed btdemo.proto
var Source []byte
