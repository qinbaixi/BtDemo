package ai

import (
	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/game/core"
)

// noTargetDistance 是没有目标时 TargetDistance 的值：足够远，任何 Max 都会归一到 1。
const noTargetDistance = 100000

// registerUtilityInputs 注册效用 AI 的 Consideration 装饰器能读的计算型输入。
// 这些名字在 bt/owl-bt.json 的 blackboard 里也声明了，编辑器里可以选，运行模式里可以手动改值；
// 游戏里它们每次打分时现算，不写进黑板。
func (sys *System) registerUtilityInputs() {
	reg := sys.reg

	// TargetDistance：到当前目标的距离（像素，边缘到边缘）。
	reg.Input("TargetDistance", func(ctx *bt.Ctx) float64 {
		agent := ctx.Agent.(*Agent)
		target := agent.target()
		if target == nil {
			return noTargetDistance
		}
		return core.EdgeDist(agent.Entity, target)
	})

	// HpPercent：自身生命百分比 0–100。
	reg.Input("HpPercent", func(ctx *bt.Ctx) float64 {
		return hpPercent(ctx.Agent.(*Agent).Entity)
	})

	// TargetHpPercent：目标生命百分比 0–100，没有目标时为 100。
	reg.Input("TargetHpPercent", func(ctx *bt.Ctx) float64 {
		target := ctx.Agent.(*Agent).target()
		if target == nil {
			return 100
		}
		return hpPercent(target)
	})
}

func hpPercent(entity *core.Entity) float64 {
	if entity.Attr.MaxHP <= 0 {
		return 0
	}
	return float64(entity.HP) * 100 / float64(entity.Attr.MaxHP)
}
