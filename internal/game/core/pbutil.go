package core

import (
	"math"

	"google.golang.org/protobuf/proto"
)

// I32 和 F32 用于构造可选的 proto2 字段。
func I32(v int) *int32       { return proto.Int32(int32(v)) }
func F32(v float64) *float32 { return proto.Float32(float32(v)) }

// Round1 四舍五入到一位小数，客户端只需要这个精度。
func Round1(v float64) float64 { return math.Round(v*10) / 10 }
