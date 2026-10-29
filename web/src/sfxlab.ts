// ?sfxlab 调音页：列出全部声音，点了就播；烘焙版和实时合成版来回对比；
// 每个声音拖音量、音高滑条（写进 audio/mix.ts 的 MIX），调好后导出 JSON 粘回 mix.ts。
// 不建游戏画面、不连服务器，手机上也能打开。

import { getVolume, initAudio, play, sampleBuffers, sampleInfo, setSampleMode, setVolume } from './audio/engine';
import { MIX } from './audio/mix';
import { MATERIALS, RECIPES, TIERS, WEAPONS } from './audio/recipes';

// 分组：按名字的第一段，组名是给人看的
const GROUPS: [string, string][] = [
  ['swing', '挥空'], ['hit', '命中附加层'], ['block', '格挡'], ['parry', '完美格挡'], ['guard', '破防'],
  ['immune', '免疫'], ['shield', '护盾'], ['wall', '撞墙'], ['interrupt', '打断'], ['proc', '装备特效'],
  ['kill', '击杀'], ['die', '倒地'], ['respawn', '复活'], ['cast', '施法'], ['heal', '回血'],
  ['levelup', '升级'], ['loot', '拾取'], ['ui', '界面'],
];

const original = new Map<string, { gain: number; pitch: number }>();   // 打开页面时 MIX 里的值，导出时只导出改过的

export function startSfxLab(): void {
  initAudio();
  for (const id of ['game', 'overlay', 'hud']) document.getElementById(id)?.remove();
  document.body.appendChild(styleSheet());
  const page = el('div', 'sfx');
  page.innerHTML = `
    <header class="sfx-head">
      <h1>音效调音</h1>
      <p class="sfx-note">先点一下页面打开声音。“烘焙”播 audio/ 图集里的素材，“实时”播配方现场合成；没有图集时两边一样。</p>
      <div class="sfx-bar">
        <span class="sfx-status" id="sfx-status">图集：检查中…</span>
        <label class="sfx-mode"><input type="radio" name="sfx-mode" value="baked" checked> 烘焙</label>
        <label class="sfx-mode"><input type="radio" name="sfx-mode" value="live"> 实时</label>
        <label class="sfx-vol">总音量 <input type="range" id="sfx-volume" min="0" max="1" step="0.05"></label>
        <input type="search" id="sfx-filter" placeholder="按名字筛选" aria-label="按名字筛选">
        <button type="button" id="sfx-export">导出混音</button>
      </div>
      <textarea id="sfx-out" class="sfx-out hidden" readonly aria-label="导出的混音 JSON"></textarea>
    </header>`;
  document.body.appendChild(page);

  const volume = page.querySelector<HTMLInputElement>('#sfx-volume')!;
  volume.value = String(getVolume());
  volume.oninput = () => setVolume(Number(volume.value));
  for (const radio of page.querySelectorAll<HTMLInputElement>('input[name="sfx-mode"]')) {
    radio.onchange = () => { setSampleMode(radio.value === 'baked'); refreshSources(); };
    // ?sfx=live 时引擎根本不加载图集，单选框要跟着显示“实时”
    if (new URLSearchParams(location.search).get('sfx') === 'live') radio.checked = radio.value === 'live';
  }
  page.querySelector<HTMLButtonElement>('#sfx-export')!.onclick = () => exportMix(page);
  const filter = page.querySelector<HTMLInputElement>('#sfx-filter')!;
  filter.oninput = () => {
    const text = filter.value.trim();
    for (const row of page.querySelectorAll<HTMLElement>('.sfx-row')) row.hidden = !!text && !row.dataset.name!.includes(text);
  };

  page.appendChild(hitMatrix());
  const named = Object.keys(RECIPES).filter((name) => !/^hit\.[a-z]+\.[a-z]+\.[a-z]+$/.test(name));
  for (const [prefix, label] of GROUPS) {
    const names = named.filter((name) => name.split('.')[0] === prefix);
    if (!names.length) continue;
    const section = el('section', 'sfx-group');
    section.appendChild(el('h2', '', label));
    for (const name of names) section.appendChild(row(name));
    page.appendChild(section);
  }
  // 图集是在第一次点击、打开声音以后才加载的：每秒看一下状态
  setInterval(() => {
    const info = sampleInfo();
    page.querySelector('#sfx-status')!.textContent = info.loaded
      ? `图集：已加载，${info.count} 个声音有素材`
      : '图集：没有（或还没点页面打开声音），全部实时合成';
    refreshSources();
  }, 1000);
}

// row 是一个声音的一行：播放、对比、音量、音高、波形。
function row(name: string, label = name): HTMLElement {
  // 拖滑条时才在 MIX 里建条目：空条目会挡住更通用名字的微调（见 engine.ts 的 mixOf）
  const current = MIX[name] ?? {};
  const mix = () => (MIX[name] ||= {});
  if (!original.has(name)) original.set(name, { gain: current.gain ?? 1, pitch: current.pitch ?? 1 });
  const line = el('div', 'sfx-row');
  line.dataset.name = name;
  const title = el('div', 'sfx-name', label);
  const source = el('span', 'sfx-src', '');
  source.dataset.for = name;
  title.appendChild(source);
  const playButton = button('▶', '播放', () => play(name, { bus: 'ui' }));
  // 对比：先烘焙版，0.9 秒后实时版
  const compare = button('A/B', '先播烘焙版，再播实时版', () => {
    setSampleMode(true);
    play(name, { bus: 'ui' });
    window.setTimeout(() => {
      setSampleMode(false);
      play(name, { bus: 'ui' });
      setSampleMode(currentMode());
    }, 900);
  });
  const gain = slider('音量', 0, 2, 0.05, current.gain ?? 1, (v) => { mix().gain = v; });
  const pitch = slider('音高', 0.5, 1.5, 0.01, current.pitch ?? 1, (v) => { mix().pitch = v; });
  const wave = document.createElement('canvas');
  wave.className = 'sfx-wave';
  wave.width = 240;
  wave.height = 36;
  line.append(title, playButton, compare, gain, pitch, wave);
  drawWave(wave, name);
  return line;
}

// hitMatrix 是命中声：武器 × 材质 × 档位 一百多个组合，挑一个出来试听和调整。
function hitMatrix(): HTMLElement {
  const section = el('section', 'sfx-group');
  section.appendChild(el('h2', '', '命中（武器 × 材质 × 档位）'));
  const pick = el('div', 'sfx-pick');
  const select = (options: readonly string[]) => {
    const s = document.createElement('select');
    for (const option of options) s.appendChild(new Option(option, option));
    return s;
  };
  const weapon = select(WEAPONS);
  const material = select(MATERIALS);
  const tier = select(TIERS);
  const holder = el('div', '');
  const update = () => {
    holder.replaceChildren(row(`hit.${weapon.value}.${material.value}.${tier.value}`));
    refreshSources();
  };
  for (const s of [weapon, material, tier]) s.onchange = update;
  pick.append(weapon, material, tier);
  section.append(pick, holder);
  update();
  return section;
}

function currentMode(): boolean {
  return document.querySelector<HTMLInputElement>('input[name="sfx-mode"]:checked')?.value !== 'live';
}

// refreshSources 更新每行后面的“素材 / 配方”标记。
function refreshSources(): void {
  for (const tag of document.querySelectorAll<HTMLElement>('.sfx-src')) {
    const source = sampleInfo(tag.dataset.for).source;
    tag.textContent = source === 'sample' ? '素材' : source === 'recipe' ? '配方' : '无';
    tag.dataset.kind = source;
  }
}

// drawWave 画波形：有烘焙素材画素材的第一个变体，没有就离线渲染一遍配方来画。
async function drawWave(canvas: HTMLCanvasElement, name: string): Promise<void> {
  let data: Float32Array | null = sampleBuffers(name)[0]?.getChannelData(0) ?? null;
  if (!data && RECIPES[name]) {
    try {
      data = await (await import('./audio/bake')).renderRecipe(name);
    } catch {
      return;
    }
  }
  if (!data) return;
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = getComputedStyle(canvas).color;
  // 横轴固定 1.5 秒，长短不同的声音放在一起比较得出来
  const seconds = 1.5;
  const rate = data.length > 0 && sampleBuffers(name)[0] ? sampleBuffers(name)[0].sampleRate : 32000;
  const perPixel = (seconds * rate) / width;
  for (let x = 0; x < width; x++) {
    const from = Math.floor(x * perPixel);
    if (from >= data.length) break;
    let peak = 0;
    for (let i = from; i < Math.min(data.length, from + perPixel); i++) peak = Math.max(peak, Math.abs(data[i]));
    // 开平方：轻的声音波形也看得清（只是显示，不是真实电平）
    const h = Math.max(1, Math.sqrt(Math.min(1, peak)) * height);
    ctx.fillRect(x, (height - h) / 2, 1, h);
  }
}

// exportMix 把改过的音量、音高导出成 JSON（粘回 audio/mix.ts 的 MIX）。
function exportMix(page: HTMLElement): void {
  const out: Record<string, { gain?: number; pitch?: number }> = {};
  for (const [name, entry] of Object.entries(MIX)) {
    const gain = entry.gain ?? 1;
    const pitch = entry.pitch ?? 1;
    if (gain === 1 && pitch === 1) continue;
    out[name] = {};
    if (gain !== 1) out[name].gain = gain;
    if (pitch !== 1) out[name].pitch = pitch;
  }
  const area = page.querySelector<HTMLTextAreaElement>('#sfx-out')!;
  area.value = Object.keys(out).length ? JSON.stringify(out, null, 2) : '{}  // 还没有改过任何声音';
  area.classList.remove('hidden');
  area.select();
  navigator.clipboard?.writeText(area.value).catch(() => {});
}

function slider(label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLElement {
  const wrap = el('label', 'sfx-slider');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const shown = el('span', 'sfx-val', value.toFixed(2));
  input.oninput = () => {
    shown.textContent = Number(input.value).toFixed(2);
    onInput(Number(input.value));
  };
  wrap.append(label, input, shown);
  return wrap;
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.onclick = onClick;
  return b;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function styleSheet(): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = `
    :root { --sfx-bg: #15110e; --sfx-panel: #201a15; --sfx-line: #3a3027; --sfx-fg: #ece4d6; --sfx-muted: #a5978a; --sfx-gold: #e0aa48; }
    @media (prefers-color-scheme: light) { :root { --sfx-bg: #f4f2ee; --sfx-panel: #ebe6dd; --sfx-line: #d4cbbd; --sfx-fg: #231c16; --sfx-muted: #6c5f52; --sfx-gold: #93620c; } }
    html, body { overflow: auto !important; height: auto !important; }
    body { background: var(--sfx-bg); color: var(--sfx-fg); margin: 0; font: 14px/1.6 "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif; }
    .sfx { max-width: 980px; margin: 0 auto; padding: 20px 16px 60px; display: flex; flex-direction: column; gap: 18px; }
    .sfx h1 { margin: 0; font-size: 26px; }
    .sfx h2 { margin: 0 0 8px; font-size: 16px; color: var(--sfx-gold); }
    .sfx-note { margin: 4px 0 10px; color: var(--sfx-muted); }
    .sfx-bar { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; }
    .sfx-status { color: var(--sfx-muted); }
    .sfx-out { width: 100%; box-sizing: border-box; min-height: 120px; margin-top: 10px; background: var(--sfx-panel); color: var(--sfx-fg); border: 1px solid var(--sfx-line); font: 12px ui-monospace, Consolas, monospace; }
    .sfx-out.hidden { display: none; }
    .sfx-group { background: var(--sfx-panel); border: 1px solid var(--sfx-line); border-radius: 8px; padding: 12px; }
    .sfx-pick { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
    .sfx-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 6px 0; border-top: 1px solid var(--sfx-line); }
    .sfx-row:first-of-type { border-top: 0; }
    .sfx-name { min-width: 190px; font-family: ui-monospace, Consolas, monospace; font-size: 13px; display: flex; gap: 6px; align-items: center; }
    .sfx-src { font-family: inherit; font-size: 11px; padding: 0 5px; border-radius: 4px; background: var(--sfx-line); color: var(--sfx-muted); }
    .sfx-src[data-kind="sample"] { color: var(--sfx-bg); background: var(--sfx-gold); }
    .sfx-slider { display: flex; align-items: center; gap: 4px; color: var(--sfx-muted); font-size: 12px; }
    .sfx-slider input { width: 90px; }
    .sfx-val { width: 32px; font-variant-numeric: tabular-nums; }
    .sfx-wave { width: 240px; max-width: 100%; height: 36px; color: var(--sfx-gold); }
    .sfx button, .sfx select, .sfx input[type="search"] { min-height: 32px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--sfx-line); background: var(--sfx-bg); color: var(--sfx-fg); font: inherit; }
    .sfx button { cursor: pointer; }
    .sfx button:hover { border-color: var(--sfx-gold); }
  `;
  return style;
}
