package combat

import (
	"math"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 这个文件是格挡 2.0：盾只挡正面；挡一下扣架势，架势扣空就破防；
// 刚举盾的一小段时间里挡住近战是完美格挡，攻击者被弹开。参数在 world.yaml 的 player.block。

// shieldFacing 是 entity 的盾朝着的方向：选了敌对目标时朝着目标（和客户端格挡时转身的规则一样），
// 否则朝着举盾时面向的那一侧。
func (sys *System) shieldFacing(entity *core.Entity) nav.Vec {
	target := sys.state.Ents.Get(entity.Target)
	if target.Alive() && sys.state.Hostile(entity, target) {
		if direction, ok := unit(target.X-entity.X, target.Y-entity.Y); ok {
			return direction
		}
	}
	if entity.BlockFace < 0 {
		return nav.Vec{X: -1}
	}
	return nav.Vec{X: 1}
}

// shieldCovers 报告举着盾的 dst 挡不挡得住从 src 那边来的攻击：在盾正面 block.arc 度以内才挡得住。
// 贴在一起分不出方向时算挡住。
func (sys *System) shieldCovers(dst, src *core.Entity) bool {
	toward, ok := unit(src.X-dst.X, src.Y-dst.Y)
	if !ok {
		return true
	}
	facing := sys.shieldFacing(dst)
	halfArc := sys.state.Cfg.World.Player.Block.Arc / 2 * math.Pi / 180
	return toward.X*facing.X+toward.Y*facing.Y >= math.Cos(halfArc)-1e-9
}

// guard 结算举盾挡住的一下：完美格挡窗口里挡住近战技能是 PARRY（不扣架势）；
// 否则按命中档位扣架势，扣空是 GUARD_BREAK，没扣空是 BLOCK。
// skill 为 nil（不是技能打的）或 proc 不空（装备特效打的）时按轻击算，也不能完美格挡。
func (sys *System) guard(dst *core.Entity, skill *config.Skill, proc string) pb.HitResult {
	now := sys.state.Now()
	if skill != nil && proc == "" && !skill.Ranged() && now < dst.ParryUntil {
		return pb.HitResult_PARRY
	}
	weight := config.WeightLight
	if skill != nil && proc == "" {
		weight = skill.Weight
	}
	block := &sys.state.Cfg.World.Player.Block
	cost := sys.state.Cfg.World.Hit.Weights[weight].Guard / math.Max(1, block.Guard)
	dst.GuardHitAt = now
	dst.SetGuardSpent(dst.GuardSpent + cost)
	if dst.GuardSpent >= 1 {
		return pb.HitResult_GUARD_BREAK
	}
	return pb.HitResult_BLOCK
}

// recoil 是完美格挡的奖励：攻击者 attacker 被从 blocker 身前弹开、硬直（打断它的前摇），
// 不管它有多少韧性。event 是这次命中的 DAMAGE 事件，击退和硬直写在里面，说的是攻击者。
func (sys *System) recoil(attacker, blocker *core.Entity, event *core.Event) {
	if !attacker.Alive() || attacker == blocker {
		return
	}
	block := &sys.state.Cfg.World.Player.Block
	_, mass := sys.poise(attacker)
	sys.push(attacker, blocker, block.ParryKnock/math.Max(0.1, mass), event)
	sys.stagger(attacker, block.ParryStun, event)
}

// breakGuard 是架势被打空：盾被打开放下，人被从 attacker 那边推开、硬直（撞墙再多硬直一下）。
// 硬直期间不能再举盾（见 session 的 Block 处理），架势过 block.guard_delay 秒开始回。
func (sys *System) breakGuard(entity, attacker *core.Entity, event *core.Event) {
	block := &sys.state.Cfg.World.Player.Block
	entity.SetBlocking(false)
	entity.BlockLoweredAt = sys.state.Now()
	entity.ParryUntil = 0
	entity.PoiseTaken = 0
	_, mass := sys.poise(entity)
	stun := block.BreakStun
	if sys.push(entity, attacker, block.BreakKnock/math.Max(0.1, mass), event) {
		stun += sys.state.Cfg.World.Hit.WallStun
	}
	sys.stagger(entity, stun, event)
}

// regenGuard 回复 entity 的架势：最近 block.guard_delay 秒没挡到东西才回，放下盾比举着回得快。
func (sys *System) regenGuard(entity *core.Entity) {
	if entity.GuardSpent <= 0 {
		return
	}
	block := &sys.state.Cfg.World.Player.Block
	if sys.state.Now()-entity.GuardHitAt < block.GuardDelay {
		return
	}
	rate := block.GuardRegen
	if entity.Blocking {
		rate = block.GuardRegenHeld
	}
	entity.SetGuardSpent(entity.GuardSpent - rate/math.Max(1, block.Guard)*sys.state.Clock.Dt)
}

// RaiseBlock 处理举盾或放下盾（session 收到 Block 消息时调用，职业能不能格挡由调用方检查）：
// 举盾时收掉前摇中的那一招，盾朝 face 那一侧（-1 左，1 右）；放下够久再举起会打开完美格挡窗口。
// 硬直和被击退途中举不起盾，返回 false。
func (sys *System) RaiseBlock(entity *core.Entity, on bool, face float64) bool {
	now := sys.state.Now()
	block := &sys.state.Cfg.World.Player.Block
	if !on {
		if entity.Blocking {
			entity.BlockLoweredAt = now
		}
		entity.ParryUntil = 0
		entity.SetBlocking(false)
		return true
	}
	if entity.Stunned(now) || entity.Knock != nil {
		return false
	}
	if face != 0 {
		entity.BlockFace = face
	}
	if !entity.Blocking {
		sys.CancelWindup(entity) // 举盾就收招：前摇中的那一下不再落下
		if now-entity.BlockLoweredAt >= block.ParryRearm {
			entity.ParryUntil = now + block.Parry
		}
	}
	entity.SetBlocking(true)
	return true
}
