// 调试面板“AI 决策”页的行为树视图：画出整棵树（可折叠），叠加某一帧的执行结果——
// 每个节点访问顺序、结果、条件装饰器的判断依据、服务做了什么、任务看到了什么。
// 最近若干帧留在历史里，可以暂停后逐帧回看；点节点看详情和它最近的结果走势。

import type { AiCheck, AiNode, AiTick, AiTrace, AiTreeDef, AiTreeNode } from '../net/types';

const HIST_CAP = 200;          // 留多少帧（20 帧/秒时约 10 秒）
const LOG_CAP = 300;
const STATUS_TEXT: Record<string, string> = { success: '成功', failure: '失败', running: '运行中' };

// 子类型的中文名；没列出的直接显示代码名
const SUB_TEXT: Record<string, string> = {
  selector: '选择', sequence: '序列', parallel: '并行', random_selector: '随机选择',
  find_target: '索敌', clear_target: '清除目标', chase_target: '追击目标', cast_skill: '施放技能',
  wander: '闲逛', return_home: '回家', flee: '逃跑', wait: '等待', say: '说话',
  has_target: '有目标', target_in_range: '目标在范围内', hp_below: '生命低于', far_from_home: '离家太远',
  was_attacked: '刚被攻击', update_target: '刷新目标', cooldown: '冷却', invert: '结果取反', force_success: '强制成功',
};
const COMPOSITE_HINT: Record<string, string> = {
  selector: '按顺序尝试子节点，第一个不失败的就是结果',
  sequence: '按顺序执行子节点，有一个不成功就停',
  parallel: '同时执行所有子节点',
  random_selector: '打乱顺序后像选择节点一样尝试',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string | null): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const subText = (s: string) => SUB_TEXT[s] || s;

// nodeTitle 是节点在树里的名字：有编辑器起的名字就用它，否则用子类型。
function nodeTitle(n: AiTreeNode): string {
  return n.label || subText(n.subType);
}

const propsText = (n: AiTreeNode) => n.props.map((p) => `${p.key}=${p.value}`).join(' ');

interface Entry { tick: AiTick; bb: { key: string; value: string }[]; tree: string }

// 一帧里某个节点的访问记录
interface Visit { order: number; n: AiNode }

// visits 把一帧的访问列表按节点 id 索引（同一帧里同一节点只取第一次）。
function visits(tick: AiTick): Map<number, Visit> {
  const m = new Map<number, Visit>();
  tick.nodes.forEach((n, i) => { if (!m.has(n.node)) m.set(n.node, { order: i + 1, n }); });
  return m;
}

// serviceNote 找出某个服务这一帧的触发记录："service:<名字>[ 说明]"。
function serviceNote(v: Visit | undefined, sub: string): string | null {
  if (!v) return null;
  for (const x of v.n.notes) {
    if (x === `service:${sub}`) return '';
    if (x.startsWith(`service:${sub} `)) return x.slice(9 + sub.length);
  }
  return null;
}

// decision 挑出一帧“决定做什么”：最后一个没失败的任务，以及它上面的组合节点链。
function decision(nodes: AiNode[]) {
  let leaf = -1;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].kind === 'task' && nodes[i].status !== 'failure') { leaf = i; break; }
  }
  if (leaf < 0) return null;
  const path = [nodes[leaf]];
  let depth = nodes[leaf].depth;
  for (let i = leaf - 1; i >= 0 && depth > 0; i--) {
    if (nodes[i].depth === depth - 1) { path.unshift(nodes[i]); depth--; }
  }
  return { leaf: nodes[leaf], path };
}

export interface AiPanel {
  trace(t: AiTrace): void;      // 每次同步带来的追踪
  clear(): void;                // 换了观察对象
  stale(): void;                // 实体离开视野或死亡，暂无数据
  setSub(text: string): void;
}

/**
 * createAiPanel 在 host 里建出行为树视图。sub 是头部的副标题（显示树名和时间），
 * needDef 在缺少某棵树的结构时调用（让上层重新请求一次）。
 */
export function createAiPanel(host: HTMLElement, sub: HTMLElement, needDef: () => void): AiPanel {
  const defs = new Map<string, AiTreeDef>();     // 树名 -> 结构，换观察对象也保留
  const collapsed = new Map<string, Set<number>>(); // 树名 -> 折叠的节点
  let hist: Entry[] = [];
  let view = -1;          // 正在看的历史下标；-1 = 实时跟随最新一帧
  let paused = false;
  let selected = 0;       // 选中的节点 id
  let lastSig = '';

  // ---- 布局 ----
  const bar = el('div', 'bt-bar');
  const pauseBtn = el('button', 'dbg-btn', '暂停');
  const prevBtn = el('button', 'dbg-btn', '◀');
  const nextBtn = el('button', 'dbg-btn', '▶');
  const liveBtn = el('button', 'dbg-btn', '回到实时');
  const frameText = el('span', 'bt-frame', '');
  prevBtn.title = '上一帧（暂停后逐帧看）';
  nextBtn.title = '下一帧';
  bar.append(pauseBtn, prevBtn, nextBtn, liveBtn, frameText);

  const bar2 = el('div', 'bt-bar');
  const expandBtn = el('button', 'dbg-btn', '全部展开');
  const collapseBtn = el('button', 'dbg-btn', '全部折叠');
  const pathBtn = el('button', 'dbg-btn', '只展开执行到的');
  const legend = el('span', 'bt-legend');
  legend.innerHTML = '<i class="st-success"></i>成功 <i class="st-failure"></i>失败 <i class="st-running"></i>运行中 <i class="st-none"></i>未执行';
  bar2.append(expandBtn, collapseBtn, pathBtn, legend);

  const treeBox = el('div', 'bt-tree');
  const detail = el('div', 'dbg-section bt-detail');
  const bbBox = el('div', 'dbg-section');
  const bb = el('div', 'dbg-bb');
  bbBox.append(el('h5', null, '黑板与状态'), bb);
  const logBox = el('div', 'dbg-section dbg-logbox');
  const logBar = el('div', 'dbg-logbar');
  const clearBtn = el('button', 'dbg-btn', '清空');
  logBar.append(el('h5', null, '决策日志（点一行跳到那一帧）'), clearBtn);
  const log = el('div', 'dbg-log');
  logBox.append(logBar, log);
  host.append(bar, bar2, treeBox, detail, bbBox, logBox);

  const current = (): Entry | undefined => (view >= 0 ? hist[view] : hist[hist.length - 1]);

  function setPaused(v: boolean) {
    paused = v;
    pauseBtn.textContent = paused ? '继续' : '暂停';
    view = paused ? hist.length - 1 : -1;
    render();
  }
  pauseBtn.addEventListener('click', () => setPaused(!paused));
  liveBtn.addEventListener('click', () => setPaused(false));
  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  function step(d: number) {
    if (!hist.length) return;
    if (!paused) setPaused(true);
    const at = view >= 0 ? view : hist.length - 1;
    view = Math.max(0, Math.min(hist.length - 1, at + d));
    render();
  }
  clearBtn.addEventListener('click', () => { log.replaceChildren(); lastSig = ''; });

  const foldSet = (tree: string) => {
    let s = collapsed.get(tree);
    if (!s) collapsed.set(tree, (s = new Set()));
    return s;
  };
  expandBtn.addEventListener('click', () => { const e = current(); if (e) { foldSet(e.tree).clear(); render(); } });
  collapseBtn.addEventListener('click', () => {
    const e = current();
    const def = e && defs.get(e.tree);
    if (!def) return;
    const s = foldSet(e.tree);
    for (const n of def.nodes.values()) if (n.children.length && n.id !== def.root) s.add(n.id);
    render();
  });
  pathBtn.addEventListener('click', () => {
    const e = current();
    const def = e && defs.get(e.tree);
    if (!def) return;
    const vis = visits(e.tick);
    const s = foldSet(e.tree);
    s.clear();
    for (const n of def.nodes.values()) if (n.children.length && !vis.has(n.id)) s.add(n.id);
    render();
  });

  // 点树：箭头折叠/展开，其余位置选中节点。树每次同步都重画，用 pointerdown
  // 而不是 click，免得按下和松开之间行被换掉导致点击丢失。
  treeBox.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const t = ev.target as HTMLElement;
    const row = t.closest<HTMLElement>('[data-id]');
    if (!row) return;
    const id = Number(row.dataset.id);
    const e = current();
    if (t.classList.contains('bt-caret') && e) {
      const s = foldSet(e.tree);
      if (s.has(id)) s.delete(id); else s.add(id);
    } else {
      selected = selected === id ? 0 : id;
    }
    render();
  });

  log.addEventListener('click', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-time]');
    if (!row) return;
    const t = Number(row.dataset.time);
    const i = hist.findIndex((h) => h.tick.time === t);
    if (i < 0) { row.classList.add('gone'); return; }
    if (!paused) setPaused(true);
    view = i;
    render();
  });

  // ---- 绘制 ----
  function render() {
    const e = current();
    const def = e && defs.get(e.tree);
    prevBtn.disabled = !hist.length || view === 0;
    nextBtn.disabled = view < 0 || view >= hist.length - 1;
    liveBtn.classList.toggle('hidden', !paused);
    if (!e) {
      frameText.textContent = '';
      treeBox.replaceChildren(el('div', 'bt-empty', '还没有决策数据'));
      detail.replaceChildren();
      bb.replaceChildren();
      return;
    }
    const idx = view >= 0 ? view : hist.length - 1;
    frameText.textContent = `${paused ? '已暂停 · ' : ''}第 ${idx + 1}/${hist.length} 帧 · ${e.tick.time.toFixed(2)}s`;
    sub.textContent = `行为树 ${e.tree} · 本帧访问 ${e.tick.nodes.length} 个节点`;
    bb.replaceChildren(...e.bb.flatMap((kv) => [el('span', 'k', kv.key), el('span', 'v', kv.value)]));
    if (!def) {
      treeBox.replaceChildren(el('div', 'bt-empty', '正在获取树的结构…'));
      detail.replaceChildren();
      return;
    }
    const vis = visits(e.tick);
    const folds = foldSet(e.tree);
    const rows: HTMLElement[] = [];
    const walk = (id: number, depth: number) => {
      const n = def.nodes.get(id);
      if (!n) return;
      const folded = folds.has(id);
      rows.push(...nodeRows(def, n, depth, vis, folded));
      if (!folded) for (const c of n.children) walk(c, depth + 1);
    };
    walk(def.root, 0);
    const top = treeBox.scrollTop;
    treeBox.replaceChildren(...rows);
    treeBox.scrollTop = top;
    renderDetail(def, vis);
  }

  // nodeRows 是一个节点的行：节点本身，下面跟着它的条件、服务和说明。
  function nodeRows(def: AiTreeDef, n: AiTreeNode, depth: number, vis: Map<number, Visit>, folded: boolean): HTMLElement[] {
    const v = vis.get(n.id);
    const pad = 4 + depth * 16;
    const row = el('div', `bt-row ${v ? `st-${v.n.status}` : 'st-none'}${selected === n.id ? ' sel' : ''}`);
    row.dataset.id = String(n.id);
    row.style.paddingLeft = `${pad}px`;
    row.append(el('span', 'bt-caret', n.children.length ? (folded ? '▸' : '▾') : ''));
    row.append(el('span', 'bt-ord', v ? String(v.order) : ''));
    row.append(el('span', 'bt-dot'));
    row.append(el('span', `bt-kind k-${n.kind}`, n.kind === 'composite' ? subText(n.subType) : '任务'));
    if (n.kind !== 'composite' || n.label) row.append(el('span', 'bt-name', n.kind === 'composite' ? n.label : nodeTitle(n)));
    if (n.props.length) row.append(el('span', 'bt-props', propsText(n)));
    const res = v ? STATUS_TEXT[v.n.status] + (v.n.fresh ? '' : ' · 接着上一帧') : '未执行';
    row.append(el('span', 'bt-res', res));
    row.title = `#${n.id} ${n.subType}${COMPOSITE_HINT[n.subType] ? '：' + COMPOSITE_HINT[n.subType] : ''}`;
    const out = [row];
    const subPad = `${pad + 34}px`;
    const subRow = (cls: string, parts: (HTMLElement | string)[]) => {
      const r = el('div', `bt-sub ${cls}`);
      r.dataset.id = String(n.id);
      r.style.paddingLeft = subPad;
      r.append(...parts.map((p) => (typeof p === 'string' ? el('span', null, p) : p)));
      out.push(r);
    };
    // 条件装饰器：本帧检查了没有、过没过、依据是什么
    for (const did of n.decorators) {
      const d = def.nodes.get(did);
      if (!d) continue;
      const ck = v?.n.checks.find((c) => c.node === did);
      const flags = [d.inverse ? '取反' : '', d.periodic ? '运行中也复查' : ''].filter(Boolean).join('、');
      const name = el('span', 'bt-dname', `◆ ${d.label || subText(d.subType)}`);
      name.title = d.subType;
      const parts: (HTMLElement | string)[] = [name];
      if (d.props.length) parts.push(el('span', 'bt-props', propsText(d)));
      if (flags) parts.push(el('span', 'bt-flag', flags));
      parts.push(checkBadge(d, ck, v));
      if (ck?.why) parts.push(el('span', 'bt-why', ck.why));
      subRow('bt-deco', parts);
    }
    // 服务：本帧有没有触发、做了什么
    for (const sid of n.services) {
      const s = def.nodes.get(sid);
      if (!s) continue;
      const note = serviceNote(v, s.subType);
      const name = el('span', 'bt-dname', `⟳ ${s.label || subText(s.subType)}`);
      name.title = s.subType;
      const parts: (HTMLElement | string)[] = [name];
      if (s.props.length) parts.push(el('span', 'bt-props', propsText(s)));
      parts.push(el('span', 'bt-flag', `每 ${s.interval}s`));
      parts.push(el('span', `bt-badge ${note != null ? 'on' : 'off'}`, note != null ? '本帧触发' : '本帧未触发'));
      if (note) parts.push(el('span', 'bt-why', note));
      subRow('bt-svc', parts);
    }
    // 任务的说明
    for (const w of v?.n.why || []) subRow('bt-task', [el('span', 'bt-why', `→ ${w}`)]);
    // 折叠时提示里面正在运行什么
    if (folded) {
      const inner = deepestRunning(def, n, vis);
      if (inner) subRow('bt-inner', [el('span', 'bt-why', `… 里面正在运行：${nodeTitle(inner)}`)]);
    }
    return out;
  }

  // checkBadge 说明一个条件装饰器在本帧的状态。
  function checkBadge(d: AiTreeNode, ck: AiCheck | undefined, v: Visit | undefined): HTMLElement {
    if (ck) return el('span', `bt-badge ${ck.pass ? 'pass' : 'fail'}`, ck.pass ? '✓ 通过' : '✗ 未通过');
    if (d.subType === 'invert' || d.subType === 'force_success') {
      const changed = v?.n.notes.includes(d.subType);
      return el('span', `bt-badge ${changed ? 'on' : 'off'}`, changed ? '改变了结果' : v ? '没改变结果' : '未执行');
    }
    if (v && !v.n.fresh) return el('span', 'bt-badge off', '运行中不复查');
    return el('span', 'bt-badge off', '未检查');
  }

  function deepestRunning(def: AiTreeDef, n: AiTreeNode, vis: Map<number, Visit>): AiTreeNode | null {
    for (const c of n.children) {
      const cn = def.nodes.get(c);
      const cv = vis.get(c);
      if (!cn || !cv || cv.n.status !== 'running') continue;
      return deepestRunning(def, cn, vis) || cn;
    }
    return null;
  }

  // renderDetail 显示选中节点的完整信息和最近每一帧的结果。
  function renderDetail(def: AiTreeDef, vis: Map<number, Visit>) {
    const n = selected ? def.nodes.get(selected) : null;
    if (!n) {
      detail.replaceChildren(el('div', 'bt-hint', '点树里的节点看详情；▸ 折叠/展开。'));
      return;
    }
    const v = vis.get(n.id);
    const grid = el('div', 'dbg-bb');
    const kv = (k: string, val: string) => grid.append(el('span', 'k', k), el('span', 'v', val));
    kv('节点', `#${n.id} ${n.label ? n.label + ' · ' : ''}${n.subType}（${n.kind === 'composite' ? '组合' : '任务'}）`);
    if (COMPOSITE_HINT[n.subType]) kv('规则', COMPOSITE_HINT[n.subType]);
    for (const p of n.props) kv(`参数 ${p.key}`, p.value);
    for (const did of n.decorators) {
      const d = def.nodes.get(did);
      if (d) kv('条件', `${d.subType}${d.props.length ? ' ' + propsText(d) : ''}${d.inverse ? '（取反）' : ''}${d.periodic ? '（运行中也复查）' : ''}`);
    }
    for (const sid of n.services) {
      const s = def.nodes.get(sid);
      if (s) kv('服务', `${s.subType}${s.props.length ? ' ' + propsText(s) : ''}，每 ${s.interval}s`);
    }
    kv('本帧', v ? `第 ${v.order} 个访问 · ${STATUS_TEXT[v.n.status]}${v.n.fresh ? ' · 新进入' : ' · 接着上一帧运行'}` : '未执行');
    for (const x of v?.n.notes || []) kv('备注', noteText(x));
    for (const w of v?.n.why || []) kv('说明', w);
    // 最近各帧的结果：一格一帧，当前看的那帧加框
    const strip = el('div', 'bt-strip');
    const at = view >= 0 ? view : hist.length - 1;
    hist.forEach((h, i) => {
      const hv = h.tick.nodes.find((x) => x.node === n.id);
      const c = el('i', hv ? `st-${hv.status}` : 'st-none');
      if (i === at) c.classList.add('cur');
      c.title = `${h.tick.time.toFixed(2)}s ${hv ? STATUS_TEXT[hv.status] : '未执行'}`;
      c.dataset.i = String(i);
      strip.append(c);
    });
    strip.addEventListener('pointerdown', (ev) => {
      const i = (ev.target as HTMLElement).dataset.i;
      if (i == null) return;
      if (!paused) setPaused(true);
      view = Number(i);
      render();
    });
    detail.replaceChildren(el('h5', null, '节点详情'), grid, el('h5', 'bt-strip-title', '最近各帧的结果（点一格跳过去）'), strip);
  }

  function noteText(n: string) {
    if (n.startsWith('blocked:')) return `被条件 ${n.slice(8)} 拦下`;
    if (n.startsWith('service:')) return `服务 ${n.slice(8)}`;
    return `装饰器 ${n} 改变了结果`;
  }

  function appendLog(tick: AiTick, tree: string) {
    const d = decision(tick.nodes);
    if (!d) return;
    // 任务每帧都会再跑一次（运行中、成功、再来），换了分支才记
    const sig = d.path.map((n) => n.node).join('/');
    if (sig === lastSig) return;
    lastSig = sig;
    const def = defs.get(tree);
    const title = (n: AiNode) => {
      const dn = def?.nodes.get(n.node);
      return dn ? nodeTitle(dn) : n.name.split(' ')[0];
    };
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    const row = el('div', `dbg-line st-${d.leaf.status}`);
    row.dataset.time = String(tick.time);
    row.append(
      el('span', 't', tick.time.toFixed(1)),
      el('span', 'p', d.path.map(title).join(' › ')),
      el('span', 's', STATUS_TEXT[d.leaf.status] || d.leaf.status),
    );
    if (d.leaf.why.length) row.append(el('div', 'args', d.leaf.why.join('；')));
    // 前面试过但被条件拦下的分支，带上原因
    const skipped: string[] = [];
    for (const n of tick.nodes) {
      if (n === d.leaf) break;
      const fail = n.checks.find((c) => !c.pass);
      if (n.status === 'failure' && fail) {
        const dn = def?.nodes.get(fail.node);
        skipped.push(`${title(n)}（${dn ? dn.label || subText(dn.subType) : '条件'}：${fail.why || '未通过'}）`);
      }
    }
    if (skipped.length) row.append(el('div', 'skip', '跳过：' + skipped.join('，')));
    log.append(row);
    while (log.childElementCount > LOG_CAP) log.firstElementChild!.remove();
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  render();

  return {
    trace(t) {
      if (t.def) defs.set(t.tree, t.def);
      else if (!defs.has(t.tree)) needDef();
      // 暂停时历史冻结（新帧不进历史、不刷新画面），方便慢慢逐帧看；日志照记
      if (!t.ticks.length) return;
      for (const tick of t.ticks) {
        appendLog(tick, t.tree);
        if (!paused) hist.push({ tick, bb: t.bb, tree: t.tree });
      }
      if (paused) return;
      if (hist.length > HIST_CAP) hist = hist.slice(hist.length - HIST_CAP);
      render();
    },
    clear() {
      hist = [];
      view = -1;
      paused = false;
      pauseBtn.textContent = '暂停';
      selected = 0;
      lastSig = '';
      log.replaceChildren();
      render();
    },
    stale() {
      if (!paused) sub.textContent = '不在视野内或已阵亡，暂无决策数据';
    },
    setSub(text) { sub.textContent = text; },
  };
}
