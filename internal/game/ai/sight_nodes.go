package ai

import (
	"math"

	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
)

// 视线相关的节点（第二关「亡者地穴」）：
//   - has_sight 看不看得见目标（墓碑、墙会挡住箭）；
//   - find_shot_spot 看不见时横着挪，找一个能看见目标、又在射程内的位置。

// 找射击位用的常量。
const (
	shotSpotArrive  = 10.0 // 离射击位这么近就算到了
	shotSpotRecheck = 0.6  // 秒：隔这么久重新挑一次射击位（目标在动）
)

// registerSight 注册视线节点。
func (sys *System) registerSight() {
	reg := sys.reg

	reg.Condition("has_sight", func(ctx *bt.Ctx) bool {
		agent := ctx.Agent.(*Agent)
		target := agent.target()
		if target == nil {
			ctx.Explain("没有目标")
			return false
		}
		if sys.combat.HasSight(agent.Entity, target) {
			ctx.Explain("看得见 %s", who(target))
			return true
		}
		ctx.Explain("视线被挡住，看不见 %s", who(target))
		return false
	})

	reg.Task("find_shot_spot", func(ctx *bt.Ctx) bt.Status {
		agent := ctx.Agent.(*Agent)
		entity := agent.Entity
		target := agent.target()
		if target == nil {
			ctx.Explain("没有目标")
			return bt.Failure
		}
		shotRange := ctx.Node.Num("Range", 240)
		inRange := core.EdgeDist(entity, target) <= shotRange
		if inRange && sys.combat.HasSight(entity, target) {
			ctx.Explain("站在这里看得见 %s，可以射了", who(target))
			return bt.Success
		}
		goalX, haveX := ctx.Mem["x"].(float64)
		goalY, _ := ctx.Mem["y"].(float64)
		pickedAt, _ := ctx.Mem["at"].(float64)
		if ctx.Fresh || !haveX || ctx.Now-pickedAt > shotSpotRecheck {
			spotX, spotY, found := sys.shotSpot(entity, target, shotRange)
			if !found {
				ctx.Explain("附近找不到能看见 %s 的位置", who(target))
				return bt.Failure
			}
			goalX, goalY = spotX, spotY
			ctx.Mem["x"], ctx.Mem["y"], ctx.Mem["at"] = goalX, goalY, ctx.Now
		}
		if math.Hypot(entity.X-goalX, entity.Y-goalY) <= shotSpotArrive {
			ctx.Explain("到了射击位，但 %s 又躲起来了", who(target))
			ctx.Mem["at"] = -math.MaxFloat64 // 下一次重新挑
			return bt.Running
		}
		sys.move.Toward(entity, goalX, goalY, agent.step(1))
		ctx.Explain("视线被挡住，横移到 (%.0f, %.0f) 找射击位", goalX, goalY)
		return bt.Running
	})
}

// shotSpot 在 entity 附近找一个射击位：站得下、看得见 target、到 target 的边缘距离在射程内，
// 挑离 entity 最近的。候选点是沿着和目标连线垂直的方向左右挪，以及射程圈上 entity 两侧的点。
func (sys *System) shotSpot(entity, target *core.Entity, shotRange float64) (float64, float64, bool) {
	navMap := sys.move.Nav()
	toX, toY := target.X-entity.X, target.Y-entity.Y
	length := math.Hypot(toX, toY)
	if length < 1 {
		return 0, 0, false
	}
	sideX, sideY := -toY/length, toX/length
	var candidates []nav.Vec
	for _, offset := range []float64{40, 80, 120, 160, 200} {
		for _, sign := range []float64{-1, 1} {
			candidates = append(candidates, nav.Vec{
				X: entity.X + sideX*offset*sign,
				Y: entity.Y + sideY*offset*sign,
			})
		}
	}
	ring := (shotRange + target.Radius + entity.Radius) * 0.8
	base := math.Atan2(entity.Y-target.Y, entity.X-target.X)
	for _, degrees := range []float64{0, 20, -20, 40, -40, 65, -65, 90, -90} {
		angle := base + degrees*math.Pi/180
		candidates = append(candidates, nav.Vec{
			X: target.X + math.Cos(angle)*ring,
			Y: target.Y + math.Sin(angle)*ring,
		})
	}
	bestX, bestY, bestDist := 0.0, 0.0, math.MaxFloat64
	for _, spot := range candidates {
		if !navMap.Free(spot, entity.Radius) || !sys.combat.SightFrom(spot.X, spot.Y, target) {
			continue
		}
		edge := math.Hypot(target.X-spot.X, target.Y-spot.Y) - target.Radius - entity.Radius
		if edge > shotRange {
			continue
		}
		if dist := math.Hypot(spot.X-entity.X, spot.Y-entity.Y); dist < bestDist {
			bestX, bestY, bestDist = spot.X, spot.Y, dist
		}
	}
	return bestX, bestY, bestDist < math.MaxFloat64
}
