package config

import "fmt"

// 没配的格挡参数用这些默认值（world.yaml player.block）
var defaultBlock = Block{
	Reduce:         0.8,
	Speed:          0.5,
	Arc:            140,
	Guard:          100,
	GuardDelay:     1,
	GuardRegen:     40,
	GuardRegenHeld: 10,
	BreakStun:      0.8,
	BreakKnock:     30,
	Parry:          0.18,
	ParryRearm:     0.4,
	ParryStun:      0.6,
	ParryKnock:     18,
}

// validate 给没配的格挡参数填上默认值，并检查取值范围。
func (block *Block) validate() error {
	fill := func(value *float64, fallback float64) {
		if *value == 0 {
			*value = fallback
		}
	}
	fill(&block.Reduce, defaultBlock.Reduce)
	fill(&block.Speed, defaultBlock.Speed)
	fill(&block.Arc, defaultBlock.Arc)
	fill(&block.Guard, defaultBlock.Guard)
	fill(&block.GuardDelay, defaultBlock.GuardDelay)
	fill(&block.GuardRegen, defaultBlock.GuardRegen)
	fill(&block.GuardRegenHeld, defaultBlock.GuardRegenHeld)
	fill(&block.BreakStun, defaultBlock.BreakStun)
	fill(&block.BreakKnock, defaultBlock.BreakKnock)
	fill(&block.Parry, defaultBlock.Parry)
	fill(&block.ParryRearm, defaultBlock.ParryRearm)
	fill(&block.ParryStun, defaultBlock.ParryStun)
	fill(&block.ParryKnock, defaultBlock.ParryKnock)
	if block.Reduce < 0 || block.Reduce > 1 || block.Speed < 0 {
		return fmt.Errorf("world.yaml: player.block.reduce must be 0..1 and speed >= 0")
	}
	if block.Arc < 0 || block.Arc > 360 {
		return fmt.Errorf("world.yaml: player.block.arc must be 0..360 degrees")
	}
	values := []float64{
		block.Guard,
		block.GuardDelay,
		block.GuardRegen,
		block.GuardRegenHeld,
		block.BreakStun,
		block.BreakKnock,
		block.Parry,
		block.ParryRearm,
		block.ParryStun,
		block.ParryKnock,
	}
	for _, value := range values {
		if value < 0 {
			return fmt.Errorf("world.yaml: player.block values must be >= 0")
		}
	}
	return nil
}
