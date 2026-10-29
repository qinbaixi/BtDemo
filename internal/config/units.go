package config

// 数值的单位约定：配置、战斗结算和协议里都没有浮点数。
//   - 时间（时长、冷却、时刻）：毫秒，Millis
//   - 比例、概率、倍率：万分比，BasisPoints（10000 = 100%）
//   - 属性、生命、伤害、护盾、坐标、距离、半径：整数；速度是像素 / 秒
// 公式中间算出小数时，得到最终结果后一律向下取整。

// Millis 是毫秒数：一段时长，或者游戏时钟上的一个时刻。
type Millis = int64

// BasisPoints 是万分比：10000 = 100%，500 = 5%，12000 = 1.2 倍。
type BasisPoints = int

// OneHundredPercent 是万分比里的 100%。
const OneHundredPercent = 10000

// ScaleBasisPoints 返回 ⌊value × points / 10000⌋（向下取整，负数也往小的方向取）。
func ScaleBasisPoints(value int, points BasisPoints) int {
	return FloorDiv(value*points, OneHundredPercent)
}

// FloorDiv 返回 ⌊numerator / denominator⌋（denominator > 0）。Go 的整数除法是向零取整，负数时会往大的方向取。
func FloorDiv(numerator, denominator int) int {
	quotient := numerator / denominator
	if numerator%denominator != 0 && numerator < 0 {
		quotient--
	}
	return quotient
}

// FloorDiv64 是 int64 版本的 FloorDiv。
func FloorDiv64(numerator, denominator int64) int64 {
	quotient := numerator / denominator
	if numerator%denominator != 0 && numerator < 0 {
		quotient--
	}
	return quotient
}
