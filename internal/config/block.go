package config

import "fmt"

// 没配的格挡参数用这些默认值（world.yaml player.block）
var defaultBlock = Block{
	Reduce:         8000,
	Speed:          5000,
	Arc:            140,
	Guard:          100,
	GuardDelay:     1000,
	GuardRegen:     40,
	GuardRegenHeld: 10,
	BreakStun:      800,
	BreakKnock:     30,
	Parry:          180,
	ParryRearm:     400,
	ParryStun:      600,
	ParryKnock:     18,
}

// validate 给没配的格挡参数填上默认值，并检查取值范围。
func (block *Block) validate() error {
	fill := func(value *int, fallback int) {
		if *value == 0 {
			*value = fallback
		}
	}
	fillMillis := func(value *Millis, fallback Millis) {
		if *value == 0 {
			*value = fallback
		}
	}
	fill(&block.Reduce, defaultBlock.Reduce)
	fill(&block.Speed, defaultBlock.Speed)
	fill(&block.Arc, defaultBlock.Arc)
	fill(&block.Guard, defaultBlock.Guard)
	fillMillis(&block.GuardDelay, defaultBlock.GuardDelay)
	fill(&block.GuardRegen, defaultBlock.GuardRegen)
	fill(&block.GuardRegenHeld, defaultBlock.GuardRegenHeld)
	fillMillis(&block.BreakStun, defaultBlock.BreakStun)
	fill(&block.BreakKnock, defaultBlock.BreakKnock)
	fillMillis(&block.Parry, defaultBlock.Parry)
	fillMillis(&block.ParryRearm, defaultBlock.ParryRearm)
	fillMillis(&block.ParryStun, defaultBlock.ParryStun)
	fill(&block.ParryKnock, defaultBlock.ParryKnock)
	if block.Reduce < 0 || block.Reduce > OneHundredPercent || block.Speed < 0 {
		return fmt.Errorf("world.yaml: player.block.reduce must be 0..10000 and speed >= 0")
	}
	if block.Arc < 0 || block.Arc > 360 {
		return fmt.Errorf("world.yaml: player.block.arc must be 0..360 degrees")
	}
	values := []int64{
		int64(block.Guard),
		block.GuardDelay,
		int64(block.GuardRegen),
		int64(block.GuardRegenHeld),
		block.BreakStun,
		int64(block.BreakKnock),
		block.Parry,
		block.ParryRearm,
		block.ParryStun,
		int64(block.ParryKnock),
	}
	for _, value := range values {
		if value < 0 {
			return fmt.Errorf("world.yaml: player.block values must be >= 0")
		}
	}
	return nil
}
