package core

import (
	"math"

	"google.golang.org/protobuf/proto"
)

// I32 and F32 build optional proto2 fields.
func I32(v int) *int32       { return proto.Int32(int32(v)) }
func F32(v float64) *float32 { return proto.Float32(float32(v)) }

// Round1 rounds to one decimal, which is all the client needs.
func Round1(v float64) float64 { return math.Round(v*10) / 10 }
