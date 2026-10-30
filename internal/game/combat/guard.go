package combat

import (
	"math"

	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 这个文件是格挡 2.0：盾只挡正面；挡一下扣架势，架势扣空就破防；
// 刚举盾的一小段时间里挡住近战是完美格挡，攻击者被弹开。参数在 world.yaml 的 player.block。

// ShieldFacing 是 entity 的盾朝着的方向：选了敌对目标时朝着目标（和客户端格挡时转身的规则一样），
// 否则朝着举盾时面向的那一侧。
func (sys *System) ShieldFacing(entity *core.Entity) nav.Vec {
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

// ShieldCovers 报告举着盾的 dst 挡不挡得住从 src 那边来的攻击：在盾正面 block.arc 度以内才挡得住。
// 贴在一起分不出方向时算挡住。
func (sys *System) ShieldCovers(dst, src *core.Entity) bool {
	toward, ok := unit(src.X-dst.X, src.Y-dst.Y)
	if !ok {
		return true
	}
	facing := sys.ShieldFacing(dst)
	halfArc := float64(sys.state.Cfg.World.Player.Block.Arc) / 2 * math.Pi / 180
	return toward.X*facing.X+toward.Y*facing.Y >= math.Cos(halfArc)-1e-9
}

// guard 结算举盾挡住的一下：完美格挡窗口里挡住近战技能是 PARRY（不扣架势）；
// 否则按命中档位扣架势，扣空是 GUARD_BREAK，没扣空是 BLOCK。
// skill 为 nil（不是技能打的）或 proc 不空（装备特效打的）时按轻击算，也不能完美格挡。
func (sys *System) guard(dst *core.Entity, skill *config.Skill, proc string) pb.HitResult {
	now := sys.state.Now()
	if skill != nil && proc == "" && !skill.Ranged() && now < dst.ParryUntil {
		dst.ParryUntil = 0 // 一次举盾只弹得开一下：同时砸过来的第二下按普通格挡算
		return pb.HitResult_PARRY
	}
	weight := config.WeightLight
	if skill != nil && proc == "" {
		weight = skill.Weight
	}
	// 扣掉的架势换算成上限的万分比
	cost := sys.state.Cfg.World.Hit.Weights[weight].Guard * config.OneHundredPercent / sys.guardMax(dst)
	dst.GuardHitAt = now
	dst.SetGuardSpent(dst.GuardSpent + cost)
	if dst.GuardSpent >= config.OneHundredPercent {
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
	sys.push(attacker, blocker, knockDistance(block.ParryKnock, mass), event)
	sys.stagger(attacker, block.ParryStun, event)
}

// breakGuard 是架势被打空：盾被打开放下，人被从 attacker 那边推开、硬直（撞墙再多硬直一下）。
// 架势回到一半以前举不起盾（见 RaiseBlock），不然刚站起来再挨一下又被破，一直被定住。
func (sys *System) breakGuard(entity, attacker *core.Entity, event *core.Event) {
	block := &sys.state.Cfg.World.Player.Block
	entity.SetBlocking(false)
	entity.BlockLoweredAt = sys.state.Now()
	entity.ParryUntil = 0
	entity.PoiseTaken = 0
	_, mass := sys.poise(entity)
	stun := block.BreakStun
	if entity.Tmpl != nil && entity.Tmpl.BreakStun > 0 {
		stun = entity.Tmpl.BreakStun // 精英怪破防后硬直更久，是给玩家的输出窗口
	}
	entity.GuardBroken = true
	if sys.push(entity, attacker, knockDistance(block.BreakKnock, mass), event) {
		event.Wall = proto.Bool(true)
		stun += sys.state.Cfg.World.Hit.WallStun
	}
	sys.stagger(entity, stun, event)
}

// regenGuard 回复 entity 的架势：最近 block.guard_delay 毫秒没挡到东西才回，放下盾比举着回得快。
// 每帧回 ⌊每秒回复点数 × 10000 × 帧长 / (架势上限 × 1000)⌋ 万分比，除不尽的零头存在 GuardCarry 里留到下一帧。
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
	numerator := int64(rate)*config.OneHundredPercent*sys.state.Clock.Dt + entity.GuardCarry
	denominator := int64(sys.guardMax(entity)) * 1000
	entity.GuardCarry = numerator % denominator
	entity.SetGuardSpent(entity.GuardSpent - int(numerator/denominator))
	if entity.GuardSpent == 0 {
		entity.GuardCarry = 0
	}
	if entity.GuardBroken && entity.GuardSpent <= GuardRecovered {
		entity.GuardBroken = false
	}
}

// guardMax 是 entity 的架势上限：模板配了 guard 的怪物用自己的，其余和玩家一样。
func (sys *System) guardMax(entity *core.Entity) int {
	if entity.Tmpl != nil && entity.Tmpl.Guard > 0 {
		return entity.Tmpl.Guard
	}
	return max(1, sys.state.Cfg.World.Player.Block.Guard)
}

// GuardRecovered：破防后扣掉的架势（万分比）回到这么多以下才能再举盾（客户端 input.ts 用同样的规则）
const GuardRecovered config.BasisPoints = 5000

// RaiseBlock 处理举盾或放下盾（session 收到 Block 消息时调用，职业能不能格挡由调用方检查）：
// 举盾时收掉前摇中的那一招，盾朝 face 那一侧（-1 左，1 右）；放下够久再举起会打开完美格挡窗口。
// 死了、硬直、被击退途中、破防后架势还没回到一半时举不起盾，返回 false。
func (sys *System) RaiseBlock(entity *core.Entity, on bool, face int) bool {
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
	if entity.Dead || entity.Stunned(now) || entity.Knock != nil || entity.GuardBroken {
		return false
	}
	if face != 0 {
		entity.BlockFace = max(-1, min(1, face))
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
