// 副本的门（Welcome.scene.gates）：一排削尖的木桩。门关着时木桩立起来、桩上的符文发红光；
// 开着时木桩沉进土里，只剩一截桩头。开关时用 GATE_MS 毫秒升降。
//
// 每根木桩是一张自己的小画布，放进角色和物件的深度层（按桩脚的 y 排序），竖着的门也能和人正确遮挡。
// 只在升降的时候重画。门通往的房间有奖励时，门上方浮一个奖励图标（drawGateRewards，画在叠加层）。

import type { Container } from 'pixi.js';
import type { GateInfo, RoomInfo } from '../net/types';
import type { ClientLevel } from '../ui/level';
import { CanvasSprite } from './pixi/canvasSprite';

const GATE_MS = 380;      // 木桩升起 / 沉下用多久
const STAKE_GAP = 13;     // 木桩间距
const STAKE_H = 50;       // 立起来时露出地面的高度
const STUMP_H = 7;        // 沉下去以后剩的桩头
const STAKE_W = 9;
const TAU = Math.PI * 2;

interface Stake { sprite: CanvasSprite; x: number; y: number; seed: number; painted: number }

export class GateLayer {
  private stakes = new Map<string, Stake[]>();
  private sceneKey = '';

  constructor(private readonly depth: Container) {}

  // update 按副本进度画每扇门。gates 换了（换了场景）就全部重建；level 为 null（还没收到进度）时门都当开着。
  update(gates: GateInfo[], level: ClientLevel | null, now: number, res: number): void {
    const key = gates.map((gate) => gate.id).join(',');
    if (key !== this.sceneKey) this.rebuild(gates, key);
    for (const gate of gates) {
      const shut = closedness(gate, level, now);
      for (const stake of this.stakes.get(gate.id) ?? []) {
        // 量化到 1/32，静止的门不重画
        const step = Math.round(shut * 32) / 32;
        if (step === stake.painted && stake.sprite.resolution === res) continue;
        stake.painted = step;
        paintStake(stake, step, res);
      }
    }
  }

  private rebuild(gates: GateInfo[], key: string): void {
    for (const list of this.stakes.values()) for (const stake of list) stake.sprite.destroy();
    this.stakes.clear();
    this.sceneKey = key;
    for (const gate of gates) {
      const across = gate.w >= gate.h;
      const length = across ? gate.w : gate.h;
      const count = Math.max(2, Math.round(length / STAKE_GAP));
      const list: Stake[] = [];
      for (let i = 0; i < count; i++) {
        const along = (i + 0.5) * (length / count);
        const x = across ? gate.x + along : gate.x + gate.w / 2;
        const y = across ? gate.y + gate.h / 2 + 4 : gate.y + along;
        const sprite = new CanvasSprite();
        sprite.position.set(x, y);
        sprite.zIndex = y;
        this.depth.addChild(sprite);
        list.push({ sprite, x, y, seed: hash(gate.id, i), painted: -1 });
      }
      this.stakes.set(gate.id, list);
    }
  }
}

// closedness 是门关上的程度：0 开着（沉下去）… 1 关着（立起来），开关途中按时间插值。
function closedness(gate: GateInfo, level: ClientLevel | null, now: number): number {
  if (!level) return 0;
  const shut = level.open.has(gate.id) ? 0 : 1;
  const since = now - (level.gateAt.get(gate.id) ?? -1e9);
  if (since >= GATE_MS) return shut;
  const t = easeOut(since / GATE_MS);
  return shut ? t : 1 - t;
}

function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

// paintStake 画一根木桩：shut 为 1 时整根立着，0 时只剩桩头。
function paintStake(stake: Stake, shut: number, res: number): void {
  const lean = ((stake.seed % 7) - 3) * 0.6;           // 每根略微歪一点
  const height = STUMP_H + (STAKE_H - STUMP_H) * shut * (0.86 + (stake.seed % 5) * 0.035);
  const box = [-STAKE_W - 4, -STAKE_H - 14, STAKE_W + 4, 8];
  stake.sprite.paint(box, res, (ctx) => {
    // 地上的影子和翻起来的土
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.beginPath();
    ctx.ellipse(0, 1, STAKE_W, 3.5, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#3a2a1c';
    ctx.beginPath();
    ctx.ellipse(0, 0, STAKE_W * 0.8, 2.6, 0, 0, TAU);
    ctx.fill();
    const top = -height;
    const half = STAKE_W / 2;
    const tipX = lean;
    // 桩身：暗面 + 亮面，墨线描边
    ctx.beginPath();
    ctx.moveTo(-half, 0);
    ctx.lineTo(-half + lean * 0.7, top + 6);
    ctx.lineTo(tipX, top - (shut > 0.5 ? 8 : 0));
    ctx.lineTo(half + lean * 0.7, top + 6);
    ctx.lineTo(half, 0);
    ctx.closePath();
    ctx.fillStyle = '#4a321e';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0d0805';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-half + 1.5, -1);
    ctx.lineTo(-half + 1.5 + lean * 0.7, top + 6);
    ctx.lineTo(tipX - 0.5, top - (shut > 0.5 ? 6 : 0));
    ctx.lineTo(-0.5 + lean * 0.5, top + 6);
    ctx.lineTo(-0.5, -1);
    ctx.closePath();
    ctx.fillStyle = '#7a5634';
    ctx.fill();
    if (height < 20) return;
    // 铁箍
    const band = -height * 0.55;
    ctx.fillStyle = '#2a2a30';
    ctx.fillRect(-half - 0.5 + lean * 0.35, band - 2, STAKE_W + 1, 4);
    ctx.fillStyle = '#6a6a74';
    ctx.fillRect(-half - 0.5 + lean * 0.35, band - 2, STAKE_W + 1, 1.2);
    // 符文：一道发红的刻痕，门关严了才亮
    if (shut > 0.9) {
      const runeY = -height * 0.3;
      ctx.strokeStyle = '#ff6a2a';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-2 + lean * 0.2, runeY - 4);
      ctx.lineTo(1.5 + lean * 0.2, runeY);
      ctx.lineTo(-1.5 + lean * 0.2, runeY + 4);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,120,50,0.35)';
      ctx.beginPath();
      ctx.arc(lean * 0.2, runeY, 4.5, 0, TAU);
      ctx.fill();
    }
  });
}

function hash(id: string, i: number): number {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Math.abs(Math.imul(h ^ i, 2654435761)) % 997;
}

// 奖励图标的颜色
const REWARD_COLORS: Record<string, string> = { heal: '#7dffb0', gear: '#ffd06a', boon: '#ff9a4a' };

// drawGateRewards 在叠加层（已经是世界坐标）上，给开着、通往还没去过的有奖励房间的门画奖励图标：
// 门上方一块浮动的圆牌，绿色十字是回血、金色宝剑是装备、橙色火苗是祝福。
export function drawGateRewards(
  ctx: CanvasRenderingContext2D, gates: GateInfo[], rooms: RoomInfo[], level: ClientLevel | null, now: number,
): void {
  if (!level) return;
  for (const gate of gates) {
    const room = rooms.find((candidate) => candidate.id === gate.to);
    if (!room?.reward || !level.open.has(gate.id) || level.rooms.get(room.id)?.phase !== 'idle') continue;
    const color = REWARD_COLORS[room.reward] ?? '#ffffff';
    const x = gate.x + gate.w / 2;
    const y = gate.y + gate.h / 2 - 74 + Math.sin(now / 420 + x) * 4;
    ctx.save();
    ctx.translate(x, y);
    // 底下一道光柱连到门上
    const beam = ctx.createLinearGradient(0, 0, 0, 70);
    beam.addColorStop(0, color + '66');
    beam.addColorStop(1, color + '00');
    ctx.fillStyle = beam;
    ctx.fillRect(-3, 0, 6, 70);
    // 圆牌
    ctx.beginPath();
    ctx.arc(0, 0, 15, 0, TAU);
    ctx.fillStyle = 'rgba(12,8,14,0.9)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    drawRewardGlyph(ctx, room.reward);
    ctx.restore();
  }
}

function drawRewardGlyph(ctx: CanvasRenderingContext2D, reward: string): void {
  ctx.beginPath();
  if (reward === 'heal') {
    ctx.rect(-2.5, -8, 5, 16);
    ctx.rect(-8, -2.5, 16, 5);
    ctx.fill();
  } else if (reward === 'gear') {
    ctx.lineWidth = 2.6;
    ctx.moveTo(-6, 6);
    ctx.lineTo(7, -7);
    ctx.stroke();
    ctx.beginPath();
    ctx.lineWidth = 2.2;
    ctx.moveTo(-7, 1);
    ctx.lineTo(-1, 7);
    ctx.stroke();
  } else {
    ctx.moveTo(0, -9);
    ctx.quadraticCurveTo(7, -1, 4, 6);
    ctx.quadraticCurveTo(0, 9, -4, 6);
    ctx.quadraticCurveTo(-7, -1, 0, -9);
    ctx.fill();
  }
}
