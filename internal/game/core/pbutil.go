package core

import (
	"math"

	"google.golang.org/protobuf/proto"
)

// I32、I64 和 FloorI32 用于构造可选的 proto2 字段。协议里没有浮点数：
// 坐标、距离这类服务器内部用浮点算的值，下发时用 FloorI32 向下取整成整数。
func I32(v int) *int32   { return proto.Int32(int32(v)) }
func I64(v int64) *int64 { return proto.Int64(v) }

// FloorI32 把 v 向下取整成 int32（坐标、距离等）。
func FloorI32(v float64) *int32 { return proto.Int32(Floor(v)) }

// Floor 把 v 向下取整成 int32；NaN 和无穷当成 0。
func Floor(v float64) int32 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return int32(math.Floor(v))
}
