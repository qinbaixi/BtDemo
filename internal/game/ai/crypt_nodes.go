package ai

import (
	"math"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/bt"
	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 骷髅兵和骨堆用的节点（第二关「亡者地穴」）：
//   - raise_shield / lower_shield 举盾、放盾：和玩家的格挡是同一套规则（只挡正面、扣架势、能被打破）；
//   - facing_shield 目标举着盾、盾正对着我（从正面打会被挡住）；
//   - flank_shield 绕到目标的盾侧面去，从盾挡不住的方向打；
//   - skill_ready 第 Slot 个技能冷却好了（先确认能出手再放盾，不然盾放下又举起来）；
//   - reassemble 骨堆重新站起来变回骷髅兵，由场景接到关卡系统上；
//   - raise_bones 首领敲地，让坑边 (X, Y) 的骨堆台子站起一只 Template（血槌叫骷髅弓手），由场景接到关卡系统上；
//   - warn_line / fire_line 骨箭雕像：沿一条直线（往两头）先画预警，再射一排穿透的骨箭。
//     机关本身就是一棵树（等待 → 预警 → 射击），行为树不只是给怪用的。

// FXLineWarn 是骨箭雕像射击前的预警（CAST 事件）：从 (x, y) 到 (tx, ty) 的一条带子，hit_at 时射出，radius 是半宽。
const FXLineWarn = "line_warn"

// lineWarnWidth 是骨箭预警带的半宽（像素）。
const lineWarnWidth = 16

// 绕盾用的常量。
const (
	flankShieldArrive  = 12.0 // 离侧面站位这么近就算到了
	flankShieldTimeout = 2.5  // 秒：绕太久（目标一直转身）就算了，硬打
)

// ReassembleFunc 让骨堆 pile 重新站起来，站起来的怪盯着 target；返回站起来的怪，站不起来返回 nil。由场景设置。
type ReassembleFunc func(pile *core.Entity, target int) *core.Entity

// SetReassemble 设置 reassemble 节点用的函数（场景把关卡系统的 Reassemble 接进来）。
func (sys *System) SetReassemble(reassemble ReassembleFunc) { sys.reassemble = reassemble }

// RaiseFunc 在 (x, y) 刷出一只模板 template 的怪，和 owner 同一个房间、盯着 owner 的目标；
// 返回刷出来的怪，那里站不下返回 nil。由场景设置。
type RaiseFunc func(owner *core.Entity, template string, x, y float64) *core.Entity

// SetRaise 设置 raise_bones 节点用的函数（场景把关卡系统的 SummonAt 接进来）。
func (sys *System) SetRaise(raise RaiseFunc) { sys.raise = raise }

// registerCrypt 注册骷髅兵和骨堆的节点。
func (sys *System) registerCrypt() {
	reg := sys.reg

	reg.Task("raise_shield", func(ctx *bt.Ctx) bt.Status {
		entity := ctx.Agent.(*Agent).Entity
		if entity.Blocking {
			ctx.Explain("盾已经举着")
			return bt.Success
		}
		if !sys.combat.RaiseBlock(entity, true, 0) {
			ctx.Explain("举不起盾（破防了，架势还没回来）")
			return bt.Failure
		}
		ctx.Explain("举盾")
		return bt.Success
	})

	reg.Task("lower_shield", func(ctx *bt.Ctx) bt.Status {
		entity := ctx.Agent.(*Agent).Entity
		if entity.Blocking {
			sys.combat.RaiseBlock(entity, false, 0)
			ctx.Explain("放下盾，准备出手")
		}
		return bt.Success
	})

	reg.Condition("facing_shield", func(ctx *bt.Ctx) bool {
		agent := ctx.Agent.(*Agent)
		target := agent.target()
		if target == nil {
			ctx.Explain("没有目标")
			return false
		}
		if !target.Blocking {
			ctx.Explain("%s 没举盾", who(target))
			return false
		}
		if !sys.combat.ShieldCovers(target, agent.Entity) {
			ctx.Explain("%s 举着盾，但盾没朝着我", who(target))
			return false
		}
		ctx.Explain("%s 的盾正对着我", who(target))
		return true
	})

	reg.Task("flank_shield", func(ctx *bt.Ctx) bt.Status {
		agent := ctx.Agent.(*Agent)
		entity := agent.Entity
		target := agent.target()
		if target == nil {
			ctx.Explain("没有目标")
			return bt.Failure
		}
		if !target.Blocking || !sys.combat.ShieldCovers(target, entity) {
			ctx.Explain("已经在 %s 的盾挡不到的地方", who(target))
			return bt.Success
		}
		if ctx.Fresh {
			ctx.Mem["until"] = ctx.Now + flankShieldTimeout
		}
		if ctx.Now > memFloat(ctx, "until") {
			ctx.Explain("绕了 %.1f 秒绕不过去，硬打", flankShieldTimeout)
			return bt.Success
		}
		// 盾朝向的垂直方向，挑离自己近的那一侧
		facing := sys.combat.ShieldFacing(target)
		sideX, sideY := -facing.Y, facing.X
		if (entity.X-target.X)*sideX+(entity.Y-target.Y)*sideY < 0 {
			sideX, sideY = -sideX, -sideY
		}
		distance := ctx.Node.Num("Distance", 50) + entity.Radius + target.Radius
		// 稍微偏到盾的后面一点，盾转过来时也还在挡不到的地方
		goalX := target.X + (sideX-facing.X*0.4)*distance
		goalY := target.Y + (sideY-facing.Y*0.4)*distance
		if math.Hypot(entity.X-goalX, entity.Y-goalY) <= flankShieldArrive {
			ctx.Explain("绕到 %s 的盾侧面了", who(target))
			return bt.Success
		}
		sys.move.Toward(entity, goalX, goalY, agent.step(1.2))
		ctx.Explain("%s 举着盾，绕到侧面去", who(target))
		return bt.Running
	})

	reg.Condition("skill_ready", func(ctx *bt.Ctx) bool {
		entity := ctx.Agent.(*Agent).Entity
		slot := int(ctx.Node.Num("Slot", 1))
		if slot < 1 || slot > len(entity.Skills) {
			ctx.Explain("没有第 %d 个技能", slot)
			return false
		}
		skill := entity.Skills[slot-1]
		if left := entity.Cooldowns[skill.ID] - sys.state.Now(); left > 0 {
			ctx.Explain("%s 还在冷却（%d 毫秒）", skill.Name, left)
			return false
		}
		ctx.Explain("%s 可以用了", skill.Name)
		return true
	})

	reg.Task("reassemble", func(ctx *bt.Ctx) bt.Status {
		agent := ctx.Agent.(*Agent)
		if sys.reassemble == nil {
			ctx.Explain("这个场景不能重组")
			return bt.Failure
		}
		target := sys.combat.NearestHostile(agent.Entity, ctx.Node.Num("Range", 400))
		targetID := 0
		if target != nil {
			targetID = target.ID
		}
		risen := sys.reassemble(agent.Entity, targetID)
		if risen == nil {
			ctx.Explain("重组不了")
			return bt.Failure
		}
		ctx.Explain("骨头拼回去了，站起来的是 %s", who(risen))
		return bt.Success
	})

	reg.Task("raise_bones", func(ctx *bt.Ctx) bt.Status {
		entity := ctx.Agent.(*Agent).Entity
		template := ctx.Node.Str("Template", "")
		if sys.raise == nil || sys.state.Cfg.Templates[template] == nil {
			ctx.Explain("叫不起 %q", template)
			return bt.Failure
		}
		x, y := ctx.Node.Num("X", entity.X), ctx.Node.Num("Y", entity.Y)
		risen := sys.raise(entity, template, x, y)
		if risen == nil {
			ctx.Explain("(%.0f, %.0f) 站不下", x, y)
			return bt.Failure
		}
		ctx.Explain("(%.0f, %.0f) 的骨堆站起来了：%s", x, y, who(risen))
		return bt.Success
	})

	reg.Task("warn_line", func(ctx *bt.Ctx) bt.Status {
		entity := ctx.Agent.(*Agent).Entity
		if ctx.Fresh {
			from, to := sys.lineEnds(entity, ctx.Node.Num("Angle", 0), ctx.Node.Num("Length", 600))
			warn := config.Millis(ctx.Node.Num("Seconds", 0.9) * 1000)
			sys.state.Events.Emit(
				entity,
				&core.Event{
					Kind:   pb.EventKind_CAST.Enum(),
					Src:    core.I32(entity.ID),
					Fx:     proto.String(FXLineWarn),
					Color:  proto.String(entity.Color),
					X:      core.FloorI32(from.X),
					Y:      core.FloorI32(from.Y),
					Tx:     core.FloorI32(to.X),
					Ty:     core.FloorI32(to.Y),
					Radius: core.I32(lineWarnWidth),
					HitAt:  core.I64(sys.state.Now() + warn),
				},
			)
			ctx.Mem["until"] = ctx.Now + float64(warn)/1000
		}
		if left := memFloat(ctx, "until") - ctx.Now; left > 0 {
			ctx.Explain("预警中，%.1f 秒后射击", left)
			return bt.Running
		}
		return bt.Success
	})

	reg.Task("fire_line", func(ctx *bt.Ctx) bt.Status {
		entity := ctx.Agent.(*Agent).Entity
		slot := int(ctx.Node.Num("Slot", 1))
		if slot < 1 || slot > len(entity.Skills) {
			ctx.Explain("没有第 %d 个技能", slot)
			return bt.Failure
		}
		skill := entity.Skills[slot-1]
		radians := ctx.Node.Num("Angle", 0) * math.Pi / 180
		directionX, directionY := math.Cos(radians), math.Sin(radians)
		// 往两头各射一次：雕像站在线的中间
		for _, sign := range []float64{1, -1} {
			delete(entity.Cooldowns, skill.ID)
			if err := sys.combat.CastAimed(entity, skill, 0, sign*directionX, sign*directionY); err != nil {
				ctx.Explain("%s 射不出：%v", skill.Name, err)
				return bt.Failure
			}
		}
		ctx.Explain("沿 %.0f° 射出 %s", ctx.Node.Num("Angle", 0), skill.Name)
		return bt.Success
	})
}

// lineEnds 是从 entity 出发、沿 angle 度方向往两头各 length 像素的直线的两个端点（被墙挡住的地方截断）。
func (sys *System) lineEnds(entity *core.Entity, angle, length float64) (nav.Vec, nav.Vec) {
	radians := angle * math.Pi / 180
	direction := nav.Vec{X: math.Cos(radians), Y: math.Sin(radians)}
	center := nav.Vec{X: entity.X, Y: entity.Y}
	navMap := sys.move.Nav()
	return navMap.Reach(center, direction.Scale(-1), length, 4), navMap.Reach(center, direction, length, 4)
}
