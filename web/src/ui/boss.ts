// 首领血条：附近有活着的首领（feel/profiles.ts 的 BOSS_MODELS）时，屏幕上方挂一条又宽又长的血条，
// 写着首领的名字。血条上两道刻线是阶段的分界（BOSS_PHASES，和行为树里进阶段的血量一致），
// 掉下去的血先留一截白色的残影，过一会儿才缩回去，能看清这一下打了多少。

import { BOSS_MODELS } from '../feel/profiles';
import { gameNow } from '../game/clock';
import { posOf, state, type ClientEntity } from '../game/state';

// BOSS_RANGE 以内的首领才显示血条（像素）
const BOSS_RANGE = 620;
// 每个首领模型的阶段分界（剩余血量的比例），见 bt/trees 里首领的行为树
const BOSS_PHASES: Record<string, number[]> = {
  wolf_king: [0.6, 0.25],
};
const GHOST_DELAY = 450;   // 残影停多久再开始缩（毫秒）
const GHOST_SPEED = 0.6;   // 残影每秒缩掉最大血量的多少

let box: HTMLElement;
let nameEl: HTMLElement;
let fillEl: HTMLElement;
let ghostEl: HTMLElement;
let marksEl: HTMLElement;
let shownId = 0;
let ghost = 1;
let holdUntil = 0;   // 残影在这之前不缩
let lastFrac = 1;

export function initBossBar(): void {
  box = document.createElement('div');
  box.className = 'boss-bar hidden';
  box.innerHTML = `
    <div class="boss-bar-name"></div>
    <div class="boss-bar-track"><div class="boss-bar-ghost"></div><div class="boss-bar-fill"></div><div class="boss-bar-marks"></div></div>`;
  nameEl = box.querySelector('.boss-bar-name')!;
  fillEl = box.querySelector('.boss-bar-fill')!;
  ghostEl = box.querySelector('.boss-bar-ghost')!;
  marksEl = box.querySelector('.boss-bar-marks')!;
  document.getElementById('hud')!.append(box);
}

// renderBossBar 每帧找离自己最近的首领更新血条，没有就藏起来。dt 是这一帧的毫秒数。
export function renderBossBar(dt: number): void {
  const boss = nearestBoss();
  if (!boss) {
    box.classList.add('hidden');
    shownId = 0;
    return;
  }
  const now = gameNow();
  const frac = boss.maxHp > 0 ? Math.max(0, boss.hp / boss.maxHp) : 0;
  if (boss.id !== shownId) {
    shownId = boss.id;
    ghost = frac;
    lastFrac = frac;
    nameEl.textContent = boss.name;
    marksEl.innerHTML = (BOSS_PHASES[boss.model] ?? [])
      .map((at) => `<span style="left:${(at * 100).toFixed(1)}%"></span>`)
      .join('');
  }
  // 残影追上血条以后再挨打才重新计时：一直挨打时残影照样会缩，不会一直挂着
  if (frac < lastFrac && ghost <= lastFrac + 0.001) holdUntil = now + GHOST_DELAY;
  lastFrac = frac;
  if (frac > ghost) ghost = frac;
  else if (now > holdUntil) ghost = Math.max(frac, ghost - (GHOST_SPEED * dt) / 1000);
  fillEl.style.width = `${(frac * 100).toFixed(2)}%`;
  ghostEl.style.width = `${(ghost * 100).toFixed(2)}%`;
  box.classList.toggle('low', frac <= (BOSS_PHASES[boss.model]?.at(-1) ?? 0.25));
  box.classList.remove('hidden');
}

function nearestBoss(): ClientEntity | undefined {
  const me = state.ents.get(state.myId);
  if (!me) return undefined;
  const now = gameNow();
  const mine = posOf(me, now);
  let best: ClientEntity | undefined;
  let bestDist = BOSS_RANGE;
  for (const e of state.ents.values()) {
    if (e.dead || !BOSS_MODELS.has(e.model)) continue;
    const p = posOf(e, now);
    const dist = Math.hypot(p.x - mine.x, p.y - mine.y);
    if (dist < bestDist) {
      best = e;
      bestDist = dist;
    }
  }
  return best;
}
