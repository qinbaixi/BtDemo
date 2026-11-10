// 把 web/src/render/knightActions.ts 里骑士的技能动作导出成 JSON，给 knight.py 摆姿势用。
// 两边共用同一套关键帧：改了动作以后重新导出、重新渲染即可。
//   node tools/blender/export-actions.mjs > tools/blender/knight-actions.json     （需要 Node 22.18 或更新）
import { ACTIONS, actionPose } from '../../web/src/render/knightActions.ts';

const UPPER = 7.2;
const FORE = 6.8;
const SHOULDER_X = 6.5;
const SAMPLES = 48;

// 手相对自己那一侧肩关节的位置（x 朝前，y 朝下）
function hand(arm) {
  return [
    Math.sin(arm[0]) * UPPER + Math.sin(arm[0] + arm[1]) * FORE,
    Math.cos(arm[0]) * UPPER + Math.cos(arm[0] + arm[1]) * FORE,
  ];
}

const round = (value) => Math.round(value * 1000) / 1000;
const out = {};
for (const [name, info] of Object.entries(ACTIONS)) {
  if (name.startsWith('ranger:')) continue;
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const pose = actionPose(name, i / SAMPLES);
    const weapon = pose.swap ? pose.far : pose.near;
    const other = pose.swap ? pose.near : pose.far;
    samples.push({
      weapon: hand(weapon).map(round),
      other: hand(other).map(round),
      blade: round(pose.blade),
      lean: round(pose.lean),
      drop: round(pose.drop),
      lift: round(pose.lift),
      jitter: round(pose.jitter),
      stretch: round(pose.stretch),
      spin: round(pose.spin),
      // 脚：[远侧, 近侧] 相对站立落脚点的偏移（y 负数是抬脚），weight 是和平常站姿的混合比例
      feet: pose.feet ? pose.feet.map((foot) => foot.map(round)) : null,
      feetWeight: round(pose.feetWeight),
    });
  }
  const first = actionPose(name, 0);
  out[name] = { ms: info.ms, lead: info.lead, slung: first.slung, samples };
}
process.stdout.write(JSON.stringify(out));
