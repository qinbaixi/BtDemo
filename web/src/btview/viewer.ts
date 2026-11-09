// 行为树查看器：导出的单文件 HTML 和实时窗口共用的整页视图。
//
// 布局：左边是树（每个节点一行，下面挂它的条件装饰器和服务），右边是和树一行一行对齐的
// 时间轴热力图——每列一帧，格子颜色就是这个节点那一帧的结果，一眼看出决策什么时候切换。
// 热力图上面是时间刻度和“决策带”（每一段是这一段时间里最终在跑的任务）。侧栏是当前帧的
// 摘要、选中节点的详情、黑板和决策切换记录。
//
// 只依赖 model.ts 和 DOM，不引游戏代码：它会被单独打包塞进 HTML 文件里。

import css from './viewer.css?inline';
import type { AiNode, AiScore, AiTreeNode } from '../net/types';
import {
  COMPOSITE_HINT,
  SCORE_DECORATORS,
  STATUS_TEXT,
  decision,
  nodeTitle,
  noteText,
  propsText,
  scoreText,
  scoresOf,
  subText,
  type BtRecording,
  type KeyValue,
  type RecTick,
  type RecTreeDef,
} from './model';

const NODE_ROW_HEIGHT = 30;
const SUB_ROW_HEIGHT = 20;
const INDENT = 14;
const LANE_AXIS_HEIGHT = 16;
const LANE_HEIGHT = 40;
const MIN_COLUMN = 2;
const MAX_COLUMN = 28;
const LIVE_CAP = 5000;    // 实时窗口最多留多少帧

// 格子颜色（画布用，和 CSS 里的同名变量一致）
const COLOR = {
  success: '#45b874',
  failure: '#e0574c',
  running: '#efb540',
  pass: '#2f8f5a',
  fail: '#b8463e',
  changed: '#a678e6',
  service: '#4fa3e8',
  score: '#6fa8ff',
  skipped: '#3a4252',
  grid: '#1b2029',
  current: 'rgba(255,255,255,0.16)',
  currentEdge: '#ffffff',
  selected: 'rgba(240,200,110,0.10)',
  axis: '#8a93a6',
  gap: '#c9cfdb',
};
const GAP_SECONDS = 0.4;   // 相邻两帧隔得比这久就当作断档

interface TreeDef {
  root: number;
  nodes: Map<number, AiTreeNode>;
}

// Visit 是一帧里某个节点的访问记录（同一帧同一节点只取第一次）。
interface Visit {
  order: number;
  node: AiNode;
}

// Tick 是读入后的一帧：黑板已补齐，访问索引和决策按需算一次后缓存。
interface Tick {
  time: number;
  tree: string;
  nodes: AiNode[];
  blackboard: KeyValue[];
  visitCache?: Map<number, Visit>;
  scoreCache?: Map<number, AiScore>;
  decisionCache?: { leafId: number; pathIds: number[]; leaf: AiNode } | null;
}

// Row 是树和热力图共用的一行。
interface Row {
  kind: 'node' | 'decorator' | 'service';
  id: number;        // 这一行画的节点（装饰器行/服务行是装饰器/服务自己的 id）
  owner: number;     // 所属的树节点 id（节点行就是自己）
  depth: number;
  top: number;
  height: number;
}

export interface Viewer {
  load(recording: BtRecording): void;                   // 换成一整份录像
  append(title: string, trees: Record<string, RecTreeDef>, ticks: RecTick[]): void;   // 实时追加
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  text?: string | null,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

// tickScores 是一帧里效用选择打的分（子节点或打分装饰器 id -> 分数），算一次后缓存。
function tickScores(tick: Tick): Map<number, AiScore> {
  if (!tick.scoreCache) tick.scoreCache = scoresOf(tick.nodes);
  return tick.scoreCache;
}

// isScoreDecorator 判断装饰器是不是打分装饰器：内置的，或者这一帧有它的分数（游戏自定义的）。
function isScoreDecorator(node: AiTreeNode, scores: Map<number, AiScore>): boolean {
  return SCORE_DECORATORS.has(node.subType) || scores.has(node.id);
}

function visitsOf(tick: Tick): Map<number, Visit> {
  if (!tick.visitCache) {
    const visits = new Map<number, Visit>();
    tick.nodes.forEach((node, index) => {
      if (!visits.has(node.node)) visits.set(node.node, { order: index + 1, node });
    });
    tick.visitCache = visits;
  }
  return tick.visitCache;
}

function decisionOf(tick: Tick) {
  if (tick.decisionCache === undefined) {
    const found = decision(tick.nodes);
    tick.decisionCache = found
      ? { leafId: found.leaf.node, pathIds: found.path.map((node) => node.node), leaf: found.leaf }
      : null;
  }
  return tick.decisionCache;
}

// serviceNote 找出某个服务这一帧的触发记录："service:<名字>[ 说明]"；没触发返回 null。
function serviceNote(visit: Visit | undefined, subType: string): string | null {
  if (!visit) return null;
  for (const note of visit.node.notes) {
    if (note === `service:${subType}`) return '';
    if (note.startsWith(`service:${subType} `)) return note.slice(9 + subType.length);
  }
  return null;
}

// leafColor 给决策带上的每个任务一个固定的颜色（按节点 id 用黄金角分色相）。
function leafColor(nodeId: number, alpha = 1): string {
  const hue = (nodeId * 137.508) % 360;
  return `hsla(${hue.toFixed(0)}, 55%, 52%, ${alpha})`;
}

// pauseReason：硬直、击退、前摇时服务端只发一个根节点并写明原因，这一帧行为树没跑。
function pauseReason(tick: Tick): string | null {
  if (tick.nodes.length !== 1 || decisionOf(tick)) return null;
  return tick.nodes[0].why.join('；') || null;
}

// leafKey 是“这一帧最终在跑什么”的标识：任务节点 id；暂停为 -3；什么都没跑为 -1。
function leafKey(tick: Tick): number {
  return decisionOf(tick)?.leafId ?? (pauseReason(tick) ? -3 : -1);
}

const formatTime = (seconds: number) => `${seconds.toFixed(2)}s`;

/**
 * createViewer 在 root 里建出整页查看器。live 为 true 时是实时窗口：
 * 有“跟随最新”开关，新帧追加到末尾；否则是导出的录像。
 */
export function createViewer(root: HTMLElement, options: { live: boolean }): Viewer {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);

  let title = '';
  let exportedAt = '';
  let trees = new Map<string, TreeDef>();
  let ticks: Tick[] = [];
  let current = -1;            // 正在看的帧
  let follow = options.live;   // 实时窗口：自动跳到最新一帧
  let selected = 0;            // 选中的节点 id；0 = 跟着当前帧的决策走
  const folds = new Map<string, Set<number>>();
  let columnWidth = 8;
  let playing = false;
  let speed = 1;
  let rows: Row[] = [];
  let rowsKey = '';            // 树名 + 折叠状态，变了才重排行
  let totalHeight = 0;
  let switches: number[] = []; // 决策切换的帧下标（第一帧也算）

  // ---------- 骨架 ----------
  root.className = 'btv';
  const top = el('header', 'btv-top');
  const heading = el('h1', null, '行为树回放');
  const meta = el('div', 'btv-meta');
  top.append(heading, meta);

  const bar = el('div', 'btv-bar');
  const button = (text: string, tip: string) => {
    const element = el('button', 'btv-btn', text);
    element.title = tip;
    bar.append(element);
    return element;
  };
  const firstButton = button('⏮', '第一帧（Home）');
  const prevButton = button('◀', '上一帧（←）');
  const playButton = button('▶ 播放', '按真实速度播放（空格）');
  const nextButton = button('▶', '下一帧（→）');
  const lastButton = button('⏭', '最后一帧（End）');
  const speedSelect = el('select', 'btv-select');
  for (const value of [0.25, 0.5, 1, 2, 4]) {
    const option = el('option', null, `${value}×`);
    option.value = String(value);
    if (value === 1) option.selected = true;
    speedSelect.append(option);
  }
  speedSelect.title = '播放速度';
  bar.append(speedSelect);
  const followButton = button('跟随最新', '新帧来了自动跳过去');
  followButton.classList.toggle('hidden', !options.live);
  const frameText = el('span', 'btv-frame', '');
  bar.append(frameText);
  const bar2 = el('div', 'btv-bar');
  const zoomOut = el('button', 'btv-btn', '−');
  const zoomIn = el('button', 'btv-btn', '+');
  zoomOut.title = '时间轴缩小（Ctrl+滚轮）';
  zoomIn.title = '时间轴放大';
  const expandButton = el('button', 'btv-btn', '全部展开');
  const collapseButton = el('button', 'btv-btn', '全部折叠');
  const pathButton = el('button', 'btv-btn', '只展开执行到的');
  const legend = el('span', 'btv-legend');
  legend.innerHTML =
    '<i class="st-success"></i>成功 <i class="st-failure"></i>失败 <i class="st-running"></i>运行中 ' +
    '<i class="ck-pass"></i>条件通过 <i class="ck-fail"></i>未通过 <i class="ck-changed"></i>改了结果 <i class="ck-service"></i>服务触发 <i class="ck-score"></i>打分';
  bar2.append(el('span', 'btv-label', '时间轴'), zoomOut, zoomIn, expandButton, collapseButton, pathButton, legend);

  const main = el('div', 'btv-main');
  const board = el('div', 'btv-board');
  const laneRow = el('div', 'btv-lanerow');
  const laneLabel = el('div', 'btv-lanelabel');
  laneLabel.append(el('span', null, '时间'), el('span', null, '最终在跑'));
  const laneCanvas = el('canvas', 'btv-lane');
  laneRow.append(laneLabel, laneCanvas);
  const scroller = el('div', 'btv-scroller');
  const treePane = el('div', 'btv-tree');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('btv-links');
  const rowsBox = el('div', 'btv-rows');
  treePane.append(svg, rowsBox);
  const spacer = el('div', 'btv-spacer');
  scroller.append(treePane, spacer);
  const heatCanvas = el('canvas', 'btv-heat');
  const scrollArea = el('div', 'btv-scrollarea');
  scrollArea.append(scroller, heatCanvas);
  board.append(laneRow, scrollArea);

  const side = el('aside', 'btv-side');
  const tickBox = el('section', 'btv-card');
  const detailBox = el('section', 'btv-card');
  const blackboardBox = el('section', 'btv-card');
  const switchBox = el('section', 'btv-card btv-switches');
  side.append(tickBox, detailBox, blackboardBox, switchBox);
  main.append(board, side);

  const tip = el('div', 'btv-tip hidden');
  root.append(top, bar, bar2, main, tip);

  // ---------- 数据 ----------
  function toTreeDef(def: RecTreeDef): TreeDef {
    return { root: def.root, nodes: new Map(def.nodes.map((node) => [node.id, node])) };
  }

  function pushTicks(recTicks: RecTick[]) {
    for (const recTick of recTicks) {
      const previous = ticks[ticks.length - 1];
      const tick: Tick = {
        time: recTick.time,
        tree: recTick.tree,
        nodes: recTick.nodes,
        blackboard: recTick.bb || previous?.blackboard || [],
      };
      ticks.push(tick);
      const index = ticks.length - 1;
      const leafId = leafKey(tick);
      const lastSwitch = switches[switches.length - 1];
      const lastLeaf = lastSwitch === undefined ? -2 : leafKey(ticks[lastSwitch]);
      if (leafId !== lastLeaf || (previous && previous.tree !== tick.tree)) switches.push(index);
    }
  }

  function trimLive() {
    if (ticks.length <= LIVE_CAP) return;
    const drop = ticks.length - LIVE_CAP;
    ticks = ticks.slice(drop);
    switches = switches.map((index) => index - drop).filter((index) => index >= 0);
    if (!switches.length || switches[0] !== 0) switches.unshift(0);
    current = Math.max(0, current - drop);
  }

  const currentTick = (): Tick | undefined => ticks[current];
  const currentTree = (): TreeDef | undefined => {
    const tick = currentTick() || ticks[ticks.length - 1];
    return tick ? trees.get(tick.tree) : undefined;
  };
  const foldSet = (treeName: string) => {
    let set = folds.get(treeName);
    if (!set) folds.set(treeName, (set = new Set()));
    return set;
  };

  // ---------- 行布局 ----------
  function layoutRows() {
    const tick = currentTick() || ticks[ticks.length - 1];
    const def = currentTree();
    const treeName = tick?.tree || '';
    const folded = foldSet(treeName);
    const key = `${treeName}|${[...folded].sort().join(',')}|${def ? def.nodes.size : 0}`;
    if (key === rowsKey) return;
    rowsKey = key;
    rows = [];
    let y = 0;
    const walk = (id: number, depth: number) => {
      const node = def.nodes.get(id);
      if (!node) return;
      rows.push({ kind: 'node', id, owner: id, depth, top: y, height: NODE_ROW_HEIGHT });
      y += NODE_ROW_HEIGHT;
      for (const decoratorId of node.decorators) {
        if (!def.nodes.has(decoratorId)) continue;
        rows.push({ kind: 'decorator', id: decoratorId, owner: id, depth, top: y, height: SUB_ROW_HEIGHT });
        y += SUB_ROW_HEIGHT;
      }
      for (const serviceId of node.services) {
        if (!def.nodes.has(serviceId)) continue;
        rows.push({ kind: 'service', id: serviceId, owner: id, depth, top: y, height: SUB_ROW_HEIGHT });
        y += SUB_ROW_HEIGHT;
      }
      if (!folded.has(id)) for (const childId of node.children) walk(childId, depth + 1);
    };
    if (def) walk(def.root, 0);
    totalHeight = y;
  }

  // ---------- 树 ----------
  function renderTree() {
    const def = currentTree();
    const tick = currentTick();
    if (!def) {
      rowsBox.replaceChildren(el('div', 'btv-empty', options.live ? '等待游戏页发来数据…（在调试面板里选一个怪物）' : '录像里没有数据'));
      svg.innerHTML = '';
      treePane.style.height = '120px';
      spacer.style.height = '120px';
      return;
    }
    const visits = tick ? visitsOf(tick) : new Map<number, Visit>();
    const scores = tick ? tickScores(tick) : new Map<number, AiScore>();
    const pathIds = new Set(tick ? decisionOf(tick)?.pathIds || [] : []);
    const folded = foldSet(tick?.tree || '');
    const focus = selected || (tick && decisionOf(tick)?.leafId) || 0;
    const elements: HTMLElement[] = [];
    for (const row of rows) {
      const node = def.nodes.get(row.id);
      const visit = visits.get(row.owner);
      const line = el('div', `btv-row r-${row.kind}`);
      line.dataset.id = String(row.owner);
      line.style.top = `${row.top}px`;
      line.style.height = `${row.height}px`;
      line.style.paddingLeft = `${6 + row.depth * INDENT + (row.kind === 'node' ? 0 : 22)}px`;
      if (row.kind === 'node') {
        line.classList.add(visit ? `st-${visit.node.status}` : 'st-none');
        if (pathIds.has(row.id)) line.classList.add('on-path');
        if (row.owner === focus) line.classList.add('sel');
        const caret = el('span', 'btv-caret', node.children.length ? (folded.has(row.id) ? '▸' : '▾') : '');
        line.append(caret);
        line.append(el('span', 'btv-order', visit ? String(visit.order) : ''));
        line.append(el('span', `btv-kind k-${node.kind}`, node.kind === 'composite' ? subText(node.subType) : '任务'));
        const name = node.kind === 'composite' ? node.label : nodeTitle(node);
        if (name) line.append(el('span', 'btv-name', name));
        if (node.props.length) line.append(el('span', 'btv-props', propsText(node)));
        const childScore = scores.get(row.id);
        if (childScore) line.append(el('span', 'btv-score', `分 ${scoreText(childScore.score)}`));
        line.title = `#${node.id} ${node.subType}${COMPOSITE_HINT[node.subType] ? '：' + COMPOSITE_HINT[node.subType] : ''}`;
      } else if (row.kind === 'decorator' && isScoreDecorator(node, scores)) {
        // 打分装饰器：不当条件，显示分数和依据
        const score = scores.get(row.id);
        line.classList.add(score ? 'ck-score' : 'ck-none');
        line.append(el('span', 'btv-glyph', '★'));
        line.append(el('span', 'btv-name', node.label || subText(node.subType)));
        if (node.props.length) line.append(el('span', 'btv-props', propsText(node)));
        if (score) line.append(el('span', 'btv-score', scoreText(score.score)));
        line.title = score?.why || node.subType;
      } else if (row.kind === 'decorator') {
        const check = visit?.node.checks.find((item) => item.node === row.id);
        const changed = visit?.node.notes.includes(node.subType);
        const state = check ? (check.pass ? 'ck-pass' : 'ck-fail') : changed ? 'ck-changed' : 'ck-none';
        line.classList.add(state);
        line.append(el('span', 'btv-glyph', '◆'));
        line.append(el('span', 'btv-name', node.label || subText(node.subType)));
        if (node.props.length) line.append(el('span', 'btv-props', propsText(node)));
        if (node.inverse) line.append(el('span', 'btv-flag', '取反'));
        if (node.periodic) line.append(el('span', 'btv-flag', '复查'));
        line.title = check?.why || node.subType;
      } else {
        const note = serviceNote(visit, node.subType);
        line.classList.add(note != null ? 'ck-service' : 'ck-none');
        line.append(el('span', 'btv-glyph', '⟳'));
        line.append(el('span', 'btv-name', node.label || subText(node.subType)));
        line.append(el('span', 'btv-flag', `每 ${node.interval}s`));
        line.title = note || node.subType;
      }
      elements.push(line);
    }
    rowsBox.replaceChildren(...elements);
    treePane.style.height = `${totalHeight}px`;
    spacer.style.height = `${totalHeight}px`;
    renderLinks(def, visits, pathIds);
  }

  // renderLinks 画父子之间的连线：执行到的那一支按结果着色，最终决策的那一条加粗。
  function renderLinks(def: TreeDef, visits: Map<number, Visit>, pathIds: Set<number>) {
    const rowOf = new Map<number, Row>();
    for (const row of rows) if (row.kind === 'node') rowOf.set(row.id, row);
    const idle: string[] = [];     // 没执行到的先画
    const visited: string[] = [];  // 执行到的盖在上面
    for (const row of rows) {
      if (row.kind !== 'node') continue;
      const node = def.nodes.get(row.id);
      const parentX = 6 + row.depth * INDENT + 5;
      const parentY = row.top + NODE_ROW_HEIGHT - 6;
      for (const childId of node.children) {
        const childRow = rowOf.get(childId);
        if (!childRow) continue;
        const childY = childRow.top + NODE_ROW_HEIGHT / 2;
        const childX = 6 + childRow.depth * INDENT + 2;
        const visit = visits.get(childId);
        const status = visit ? visit.node.status : 'none';
        const onPath = pathIds.has(childId) && pathIds.has(row.id);
        (visit ? visited : idle).push(
          `<path class="lk st-${status}${onPath ? ' on-path' : ''}" ` +
            `d="M${parentX} ${parentY} V${childY - 4} Q${parentX} ${childY} ${parentX + 4} ${childY} H${childX}"/>`,
        );
      }
    }
    svg.setAttribute('width', String(treePane.clientWidth || 300));
    svg.setAttribute('height', String(totalHeight));
    svg.innerHTML = idle.join('') + visited.join('');
  }

  // ---------- 热力图 ----------
  let drawQueued = false;
  function queueDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      drawHeat();
      drawLane();
    });
  }

  function treeWidth() {
    return treePane.offsetWidth;
  }

  function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    return context;
  }

  // visibleColumns 是热力图当前看得到的帧范围 [first, last)。
  function visibleColumns(width: number) {
    const first = Math.max(0, Math.floor(scroller.scrollLeft / columnWidth));
    const last = Math.min(ticks.length, Math.ceil((scroller.scrollLeft + width) / columnWidth) + 1);
    return { first, last };
  }

  function cellColor(row: Row, tick: Tick, def: TreeDef): string | null {
    if (trees.get(tick.tree) !== def) return null;
    const visit = visitsOf(tick).get(row.owner);
    if (row.kind === 'node') {
      if (!visit) return null;
      return COLOR[visit.node.status];
    }
    const node = def.nodes.get(row.id);
    if (row.kind === 'decorator') {
      if (tickScores(tick).has(row.id)) return COLOR.score;
      const check = visit?.node.checks.find((item) => item.node === row.id);
      if (check) return check.pass ? COLOR.pass : COLOR.fail;
      if (visit?.node.notes.includes(node.subType)) return COLOR.changed;
      return visit ? COLOR.skipped : null;
    }
    return serviceNote(visit, node.subType) != null ? COLOR.service : null;
  }

  function drawHeat() {
    const left = treeWidth();
    const width = Math.max(0, scroller.clientWidth - left);
    const height = scroller.clientHeight;
    heatCanvas.style.left = `${left}px`;
    const context = sizeCanvas(heatCanvas, width, height);
    const def = currentTree();
    if (!def || !ticks.length) return;
    const offsetX = scroller.scrollLeft;
    const offsetY = scroller.scrollTop;
    const { first, last } = visibleColumns(width);
    const gap = columnWidth >= 5 ? 1 : 0;
    const focus = selected || (currentTick() && decisionOf(currentTick())?.leafId) || 0;
    for (const row of rows) {
      const y = row.top - offsetY;
      if (y + row.height < 0 || y > height) continue;
      if (row.kind === 'node' && row.owner === focus) {
        context.fillStyle = COLOR.selected;
        context.fillRect(0, y, width, row.height);
      }
      const inset = row.kind === 'node' ? 5 : 4;
      context.fillStyle = COLOR.grid;
      context.fillRect(0, y + row.height - 1, width, 1);
      for (let index = first; index < last; index++) {
        const color = cellColor(row, ticks[index], def);
        if (!color) continue;
        const tick = ticks[index];
        const visit = row.kind === 'node' ? visitsOf(tick).get(row.owner) : null;
        context.globalAlpha = visit && visit.node.status === 'running' && !visit.node.fresh ? 0.72 : 1;
        context.fillStyle = color;
        context.fillRect(index * columnWidth - offsetX, y + inset, columnWidth - gap, row.height - inset * 2);
      }
      context.globalAlpha = 1;
    }
    // 断档（实体离开视野、阵亡后复活等）：两帧之间隔得太久，画一条虚线提醒时间不连续
    context.fillStyle = COLOR.gap;
    for (let index = Math.max(1, first); index < last; index++) {
      if (ticks[index].time - ticks[index - 1].time <= GAP_SECONDS) continue;
      const x = index * columnWidth - offsetX - 1;
      for (let y = 0; y < height; y += 6) context.fillRect(x, y, 2, 3);
    }
    if (current >= 0) {
      const x = current * columnWidth - offsetX;
      context.fillStyle = COLOR.current;
      context.fillRect(x, 0, columnWidth, height);
      context.fillStyle = COLOR.currentEdge;
      context.fillRect(x - 1, 0, 1, height);
      context.fillRect(x + columnWidth, 0, 1, height);
    }
  }

  // drawLane 画时间刻度和决策带。
  function drawLane() {
    const left = treeWidth();
    laneLabel.style.width = `${left}px`;
    const width = Math.max(0, scroller.clientWidth - left);
    const context = sizeCanvas(laneCanvas, width, LANE_HEIGHT);
    if (!ticks.length) return;
    const offsetX = scroller.scrollLeft;
    const { first, last } = visibleColumns(width);
    // 刻度：标签之间至少 70px
    const span = ticks[ticks.length - 1].time - ticks[0].time || 1;
    const pixelsPerSecond = (ticks.length * columnWidth) / span;
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120];
    const step = steps.find((value) => value * pixelsPerSecond >= 70) || 300;
    context.font = '10px system-ui, sans-serif';
    context.fillStyle = COLOR.axis;
    context.textBaseline = 'top';
    let nextMark = -Infinity;
    for (let index = first; index < last; index++) {
      const time = ticks[index].time;
      if (time < nextMark) continue;
      const mark = Math.ceil(time / step - 1e-6) * step;
      if (time + 1e-6 < mark && index > first) continue;
      const x = index * columnWidth - offsetX;
      context.fillRect(x, LANE_AXIS_HEIGHT - 4, 1, 4);
      context.fillText(`${mark.toFixed(step < 1 ? 1 : 0)}s`, x + 2, 1);
      nextMark = mark + step - 1e-6;
    }
    // 决策带：连续同一个任务画成一段，宽度够就写上名字
    const bandTop = LANE_AXIS_HEIGHT + 2;
    const bandHeight = LANE_HEIGHT - bandTop - 3;
    let segmentStart = first;
    const flush = (end: number) => {
      const tick = ticks[segmentStart];
      const found = decisionOf(tick);
      const x = segmentStart * columnWidth - offsetX;
      const segmentWidth = (end - segmentStart) * columnWidth;
      const paused = !found && pauseReason(tick);
      context.fillStyle = found
        ? leafColor(found.leafId, found.leaf.status === 'running' ? 0.85 : 0.6)
        : paused
          ? '#5b5f6b'
          : '#2a2f3a';
      context.fillRect(x, bandTop, segmentWidth - (columnWidth >= 4 ? 1 : 0), bandHeight);
      const node = found && trees.get(tick.tree)?.nodes.get(found.leafId);
      const label = node ? nodeTitle(node) : found ? found.leaf.name.split(' ')[0] : paused ? '暂停' : '无';
      if (segmentWidth > 26) {
        context.save();
        context.beginPath();
        context.rect(x, bandTop, segmentWidth - 2, bandHeight);
        context.clip();
        context.fillStyle = '#0b0d12';
        context.font = '600 11px system-ui, sans-serif';
        context.textBaseline = 'middle';
        context.fillText(label, Math.max(x, 0) + 4, bandTop + bandHeight / 2 + 1);
        context.restore();
      }
    };
    const leafAt = (index: number) => `${ticks[index].tree}:${leafKey(ticks[index])}`;
    for (let index = first + 1; index <= last; index++) {
      if (index === last || leafAt(index) !== leafAt(segmentStart)) {
        flush(index);
        segmentStart = index;
      }
    }
    if (current >= 0) {
      context.fillStyle = COLOR.currentEdge;
      context.fillRect(current * columnWidth - offsetX + columnWidth / 2 - 1, 0, 2, LANE_HEIGHT);
    }
  }

  // ---------- 侧栏 ----------
  function card(box: HTMLElement, heading: string, ...children: (HTMLElement | null)[]) {
    box.replaceChildren(el('h3', null, heading), ...children.filter(Boolean));
  }

  function grid(pairs: [string, string | HTMLElement][]) {
    const box = el('div', 'btv-kv');
    for (const [key, value] of pairs) {
      box.append(el('span', 'k', key));
      if (typeof value === 'string') box.append(el('span', 'v', value));
      else {
        value.classList.add('v');
        box.append(value);
      }
    }
    return box;
  }

  function titleOf(def: TreeDef | undefined, node: AiNode) {
    const treeNode = def?.nodes.get(node.node);
    return treeNode ? nodeTitle(treeNode) : node.name.split(' ')[0];
  }

  function renderSide() {
    const tick = currentTick();
    const def = currentTree();
    if (!tick) {
      card(tickBox, '这一帧', el('div', 'btv-hint', '还没有数据'));
      detailBox.replaceChildren();
      blackboardBox.replaceChildren();
      switchBox.replaceChildren();
      return;
    }
    // 这一帧：决定做什么、前面哪些分支被拦下了
    const found = decisionOf(tick);
    const path = el('div', 'btv-path');
    if (found) {
      const visits = visitsOf(tick);
      found.pathIds.forEach((id, index) => {
        if (index) path.append(el('span', 'sep', '›'));
        const visit = visits.get(id);
        path.append(el('span', `step st-${visit?.node.status || 'none'}`, visit ? titleOf(def, visit.node) : `#${id}`));
      });
    } else {
      const paused = pauseReason(tick);
      path.append(el('span', 'btv-hint', paused ? `行为树暂停：${paused}` : '这一帧没有任务在跑'));
    }
    const skipped = el('ul', 'btv-skipped');
    for (const node of tick.nodes) {
      if (found && node === found.leaf) break;
      const failed = node.checks.find((check) => !check.pass);
      if (node.status !== 'failure' || !failed) continue;
      const decorator = def?.nodes.get(failed.node);
      const item = el('li');
      item.append(
        el('b', null, titleOf(def, node)),
        el('span', null, `：${decorator ? decorator.label || subText(decorator.subType) : '条件'}没通过`),
      );
      if (failed.why) item.append(el('em', null, ` — ${failed.why}`));
      skipped.append(item);
    }
    const why = found?.leaf.why.length ? el('div', 'btv-why', '→ ' + found.leaf.why.join('；')) : null;
    card(
      tickBox,
      `这一帧 · ${formatTime(tick.time)}`,
      grid([
        ['帧', `${current + 1} / ${ticks.length}`],
        ['树', tick.tree],
        ['访问', `${tick.nodes.length} 个节点`],
        ['结果', found ? `${STATUS_TEXT[found.leaf.status]}${found.leaf.fresh ? ' · 新进入' : ' · 接着上一帧'}` : '—'],
      ]),
      path,
      why,
      skipped.childElementCount ? el('div', 'btv-subhead', '前面试过但被拦下的分支') : null,
      skipped.childElementCount ? skipped : null,
    );

    renderDetail(tick, def);

    const blackboard = grid(tick.blackboard.map((pair) => [pair.key, pair.value]));
    card(blackboardBox, '黑板与状态', tick.blackboard.length ? blackboard : el('div', 'btv-hint', '空'));

    renderSwitches();
  }

  function renderDetail(tick: Tick, def: TreeDef | undefined) {
    const focus = selected || decisionOf(tick)?.leafId || 0;
    const node = def?.nodes.get(focus);
    if (!node) {
      card(detailBox, '节点详情', el('div', 'btv-hint', '点左边树里的节点看详情'));
      return;
    }
    const visit = visitsOf(tick).get(node.id);
    const pairs: [string, string | HTMLElement][] = [
      ['节点', `#${node.id} ${node.label ? node.label + ' · ' : ''}${node.subType}`],
      ['类型', node.kind === 'composite' ? '组合' : '任务'],
    ];
    if (COMPOSITE_HINT[node.subType]) pairs.push(['规则', COMPOSITE_HINT[node.subType]]);
    for (const prop of node.props) pairs.push([`参数 ${prop.key}`, prop.value]);
    pairs.push([
      '本帧',
      visit
        ? `第 ${visit.order} 个访问 · ${STATUS_TEXT[visit.node.status]}${visit.node.fresh ? ' · 新进入' : ' · 接着上一帧运行'}`
        : '未执行',
    ]);
    for (const note of visit?.node.notes || []) if (!note.startsWith('service:')) pairs.push(['备注', noteText(note)]);
    for (const why of visit?.node.why || []) pairs.push(['说明', why]);
    const scores = tickScores(tick);
    const childScore = scores.get(node.id);
    if (childScore) pairs.push(['效用分数', scoreText(childScore.score)]);
    const checks = el('ul', 'btv-checks');
    for (const decoratorId of node.decorators) {
      const decorator = def.nodes.get(decoratorId);
      if (!decorator) continue;
      if (isScoreDecorator(decorator, scores)) {
        const score = scores.get(decoratorId);
        const item = el('li', score ? 'ck-score' : 'ck-none');
        item.append(
          el('span', 'badge', score ? `★ ${scoreText(score.score)}` : '没打分'),
          el('b', null, decorator.label || subText(decorator.subType)),
          el('span', 'btv-props', propsText(decorator)),
        );
        if (score?.why) item.append(el('div', 'btv-why', score.why));
        checks.append(item);
        continue;
      }
      const check = visit?.node.checks.find((item) => item.node === decoratorId);
      const changed = visit?.node.notes.includes(decorator.subType);
      const state = check ? (check.pass ? 'pass' : 'fail') : changed ? 'changed' : 'none';
      const badge = check ? (check.pass ? '✓ 通过' : '✗ 未通过') : changed ? '改了结果' : visit && !visit.node.fresh ? '运行中不复查' : '未检查';
      const item = el('li', `ck-${state}`);
      item.append(
        el('span', 'badge', badge),
        el('b', null, decorator.label || subText(decorator.subType)),
        el('span', 'btv-props', [propsText(decorator), decorator.inverse ? '取反' : '', decorator.periodic ? '运行中也复查' : ''].filter(Boolean).join(' · ')),
      );
      if (check?.why) item.append(el('div', 'btv-why', check.why));
      checks.append(item);
    }
    for (const serviceId of node.services) {
      const service = def.nodes.get(serviceId);
      if (!service) continue;
      const note = serviceNote(visit, service.subType);
      const item = el('li', note != null ? 'ck-service' : 'ck-none');
      item.append(
        el('span', 'badge', note != null ? '⟳ 触发' : '未触发'),
        el('b', null, service.label || subText(service.subType)),
        el('span', 'btv-props', `每 ${service.interval}s`),
      );
      if (note) item.append(el('div', 'btv-why', note));
      checks.append(item);
    }
    // 统计：录像里这个节点各种结果出现了几帧
    const counts = { success: 0, failure: 0, running: 0, none: 0 };
    for (const other of ticks) {
      if (trees.get(other.tree) !== def) continue;
      const otherVisit = visitsOf(other).get(node.id);
      counts[otherVisit ? otherVisit.node.status : 'none']++;
    }
    pairs.push(['全程', `成功 ${counts.success} · 失败 ${counts.failure} · 运行 ${counts.running} · 未执行 ${counts.none} 帧`]);
    const unpin = selected ? el('button', 'btv-btn btv-mini', '跟随决策') : null;
    unpin?.addEventListener('click', () => {
      selected = 0;
      render();
    });
    const heading = el('div', 'btv-cardhead');
    heading.append(el('h3', null, `节点详情 · ${nodeTitle(node)}`));
    if (unpin) heading.append(unpin);
    detailBox.replaceChildren(heading, grid(pairs));
    if (checks.childElementCount) detailBox.append(el('div', 'btv-subhead', '条件、打分和服务'), checks);
  }

  let switchesRendered = '';
  function renderSwitches() {
    const key = `${switches.length}:${switches[0]}:${current}:${ticks.length}`;
    if (key === switchesRendered) return;
    switchesRendered = key;
    const list = el('ol', 'btv-switchlist');
    let currentItem: HTMLElement | null = null;
    switches.forEach((index, position) => {
      const tick = ticks[index];
      const found = decisionOf(tick);
      const end = position + 1 < switches.length ? switches[position + 1] : ticks.length;
      const item = el('li');
      item.dataset.index = String(index);
      if (current >= index && current < end) {
        item.classList.add('cur');
        currentItem = item;
      }
      const swatch = el('i');
      const paused = !found && pauseReason(tick);
      swatch.style.background = found ? leafColor(found.leafId) : paused ? '#5b5f6b' : '#444';
      const pathText = found
        ? found.pathIds
            .map((id) => {
              const node = trees.get(tick.tree)?.nodes.get(id);
              return node ? nodeTitle(node) : `#${id}`;
            })
            .join(' › ')
        : paused
          ? `暂停：${paused}`
          : '没有任务在跑';
      const duration = (ticks[end - 1].time - tick.time).toFixed(1);
      item.append(swatch, el('span', 't', formatTime(tick.time)), el('span', 'p', pathText), el('span', 'd', `${end - index} 帧 · ${duration}s`));
      list.append(item);
    });
    card(switchBox, `决策切换记录（${switches.length} 次，点一行跳过去）`, list);
    if (currentItem) {
      const box = list;
      const itemTop = currentItem.offsetTop;
      if (itemTop < box.scrollTop || itemTop > box.scrollTop + box.clientHeight - 30) box.scrollTop = itemTop - 60;
    }
  }

  // ---------- 总绘制 ----------
  function renderMeta() {
    heading.textContent = title || '行为树回放';
    document.title = `${title || '行为树'} · 行为树回放`;
    const parts: string[] = [];
    const treeNames = [...new Set(ticks.map((tick) => tick.tree))];
    if (treeNames.length) parts.push(`行为树 ${treeNames.join('、')}`);
    if (ticks.length) {
      parts.push(`${ticks.length} 帧`);
      parts.push(`${formatTime(ticks[0].time)} – ${formatTime(ticks[ticks.length - 1].time)}`);
    }
    if (!options.live) parts.push(`导出于 ${exportedAt}`);
    meta.textContent = parts.join(' · ');
    if (options.live) meta.append(' · ', el('span', 'btv-live', '● 实时'));
  }

  function render() {
    layoutRows();
    renderMeta();
    const tick = currentTick();
    frameText.textContent = tick ? `第 ${current + 1}/${ticks.length} 帧 · ${formatTime(tick.time)}` : '';
    firstButton.disabled = prevButton.disabled = current <= 0;
    nextButton.disabled = lastButton.disabled = current >= ticks.length - 1;
    playButton.textContent = playing ? '⏸ 暂停' : '▶ 播放';
    followButton.classList.toggle('on', follow);
    spacer.style.width = `${Math.max(1, ticks.length * columnWidth)}px`;
    renderTree();
    renderSide();
    queueDraw();
  }

  // keepVisible 让当前帧那一列留在热力图看得见的地方。
  function keepVisible() {
    const width = scroller.clientWidth - treeWidth();
    const x = current * columnWidth;
    if (x < scroller.scrollLeft + columnWidth || x > scroller.scrollLeft + width - columnWidth * 3) {
      scroller.scrollLeft = Math.max(0, x - width * 0.75);
    }
  }

  function goTo(index: number, goOptions: { keepFollow?: boolean } = {}) {
    if (!ticks.length) return;
    current = Math.max(0, Math.min(ticks.length - 1, index));
    if (!goOptions.keepFollow) follow = false;
    render();
    keepVisible();
  }

  // ---------- 交互 ----------
  firstButton.addEventListener('click', () => goTo(0));
  prevButton.addEventListener('click', () => goTo(current - 1));
  nextButton.addEventListener('click', () => goTo(current + 1));
  lastButton.addEventListener('click', () => goTo(ticks.length - 1));
  playButton.addEventListener('click', () => setPlaying(!playing));
  speedSelect.addEventListener('change', () => (speed = Number(speedSelect.value)));
  followButton.addEventListener('click', () => {
    follow = !follow;
    if (follow) goTo(ticks.length - 1, { keepFollow: true });
    else render();
  });
  const zoom = (factor: number, anchorX = (scroller.clientWidth - treeWidth()) / 2) => {
    const anchorIndex = (scroller.scrollLeft + anchorX) / columnWidth;
    columnWidth = Math.max(MIN_COLUMN, Math.min(MAX_COLUMN, Math.round(columnWidth * factor)));
    if (columnWidth === Math.round(columnWidth / factor) && factor > 1) columnWidth++;
    spacer.style.width = `${ticks.length * columnWidth}px`;
    scroller.scrollLeft = anchorIndex * columnWidth - anchorX;
    queueDraw();
  };
  zoomIn.addEventListener('click', () => zoom(1.5));
  zoomOut.addEventListener('click', () => zoom(1 / 1.5));
  expandButton.addEventListener('click', () => {
    const tick = currentTick();
    if (tick) foldSet(tick.tree).clear();
    render();
  });
  collapseButton.addEventListener('click', () => {
    const tick = currentTick();
    const def = currentTree();
    if (!tick || !def) return;
    const set = foldSet(tick.tree);
    for (const node of def.nodes.values()) if (node.children.length && node.id !== def.root) set.add(node.id);
    render();
  });
  pathButton.addEventListener('click', () => {
    const tick = currentTick();
    const def = currentTree();
    if (!tick || !def) return;
    const visits = visitsOf(tick);
    const set = foldSet(tick.tree);
    set.clear();
    for (const node of def.nodes.values()) if (node.children.length && !visits.has(node.id)) set.add(node.id);
    render();
  });

  rowsBox.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const line = target.closest<HTMLElement>('[data-id]');
    if (!line) return;
    const id = Number(line.dataset.id);
    const tick = currentTick();
    if (target.classList.contains('btv-caret') && tick) {
      const set = foldSet(tick.tree);
      if (set.has(id)) set.delete(id);
      else set.add(id);
    } else selected = selected === id ? 0 : id;
    render();
  });

  // 热力图上的点击、悬停：按坐标算出行和帧
  function hit(event: MouseEvent) {
    const box = scroller.getBoundingClientRect();
    const x = event.clientX - box.left - treeWidth();
    const y = event.clientY - box.top;
    if (x < 0 || y < 0 || x > scroller.clientWidth - treeWidth() || y > scroller.clientHeight) return null;
    const index = Math.floor((x + scroller.scrollLeft) / columnWidth);
    const contentY = y + scroller.scrollTop;
    const row = rows.find((item) => contentY >= item.top && contentY < item.top + item.height) || null;
    if (index < 0 || index >= ticks.length) return null;
    return { index, row };
  }

  scroller.addEventListener('click', (event) => {
    const found = hit(event);
    if (!found) return;
    if (found.row) selected = found.row.owner;
    goTo(found.index);
  });

  scroller.addEventListener('mousemove', (event) => {
    const found = hit(event);
    const def = currentTree();
    if (!found || !found.row || !def) {
      tip.classList.add('hidden');
      return;
    }
    const tick = ticks[found.index];
    const node = def.nodes.get(found.row.id);
    const visit = visitsOf(tick).get(found.row.owner);
    let text = `${formatTime(tick.time)} · ${node ? nodeTitle(node) : '#' + found.row.id}\n`;
    if (found.row.kind === 'node') {
      text += visit ? `${STATUS_TEXT[visit.node.status]}${visit.node.fresh ? '' : '（接着上一帧）'}` : '未执行';
      if (visit?.node.why.length) text += '\n→ ' + visit.node.why.join('；');
    } else if (found.row.kind === 'decorator' && tickScores(tick).has(found.row.id)) {
      const score = tickScores(tick).get(found.row.id);
      text += `分数 ${scoreText(score.score)}${score.why ? '：' + score.why : ''}`;
    } else if (found.row.kind === 'decorator') {
      const check = visit?.node.checks.find((item) => item.node === found.row.id);
      text += check ? `${check.pass ? '通过' : '未通过'}${check.why ? '：' + check.why : ''}` : visit ? '本帧没检查' : '未执行';
    } else {
      const note = serviceNote(visit, node.subType);
      text += note == null ? '未触发' : `触发${note ? '：' + note : ''}`;
    }
    tip.textContent = text;
    tip.classList.remove('hidden');
    const tipX = Math.min(window.innerWidth - tip.offsetWidth - 8, event.clientX + 14);
    tip.style.left = `${Math.max(8, tipX)}px`;
    tip.style.top = `${event.clientY + 16}px`;
  });
  scroller.addEventListener('mouseleave', () => tip.classList.add('hidden'));
  scroller.addEventListener('scroll', queueDraw, { passive: true });
  scroller.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const box = scroller.getBoundingClientRect();
      zoom(event.deltaY < 0 ? 1.25 : 0.8, event.clientX - box.left - treeWidth());
    },
    { passive: false },
  );

  // 在决策带上按住拖动就是拖进度条
  let scrubbing = false;
  const scrubTo = (event: PointerEvent) => {
    const box = laneCanvas.getBoundingClientRect();
    goTo(Math.floor((event.clientX - box.left + scroller.scrollLeft) / columnWidth));
  };
  laneCanvas.addEventListener('pointerdown', (event) => {
    scrubbing = true;
    laneCanvas.setPointerCapture(event.pointerId);
    scrubTo(event);
  });
  laneCanvas.addEventListener('pointermove', (event) => {
    if (scrubbing) scrubTo(event);
  });
  laneCanvas.addEventListener('pointerup', () => (scrubbing = false));

  switchBox.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');
    if (item) goTo(Number(item.dataset.index));
  });

  window.addEventListener('keydown', (event) => {
    if ((event.target as HTMLElement).tagName === 'SELECT') return;
    if (event.key === 'ArrowLeft') goTo(current - 1);
    else if (event.key === 'ArrowRight') goTo(current + 1);
    else if (event.key === 'Home') goTo(0);
    else if (event.key === 'End') goTo(ticks.length - 1);
    else if (event.key === ' ') setPlaying(!playing);
    else return;
    event.preventDefault();
  });
  window.addEventListener('resize', () => {
    rowsKey = '';
    render();
  });

  // ---------- 播放 ----------
  let playClock = 0;   // 播放进度：从当前帧起已经过去的“游戏秒”
  let lastFrame = 0;
  function setPlaying(value: boolean) {
    playing = value && ticks.length > 1;
    if (playing) {
      follow = false;
      if (current >= ticks.length - 1) current = 0;
      playClock = 0;
      lastFrame = performance.now();
      requestAnimationFrame(playStep);
    }
    render();
  }
  function playStep(now: number) {
    if (!playing) return;
    playClock += ((now - lastFrame) / 1000) * speed;
    lastFrame = now;
    let moved = false;
    while (current < ticks.length - 1 && playClock >= ticks[current + 1].time - ticks[current].time) {
      playClock -= ticks[current + 1].time - ticks[current].time;
      current++;
      moved = true;
    }
    if (current >= ticks.length - 1) playing = false;
    if (moved || !playing) {
      render();
      keepVisible();
    }
    if (playing) requestAnimationFrame(playStep);
  }

  // ---------- 对外 ----------
  function load(recording: BtRecording) {
    title = recording.title;
    exportedAt = recording.exportedAt;
    trees = new Map(Object.entries(recording.trees).map(([name, def]) => [name, toTreeDef(def)]));
    ticks = [];
    switches = [];
    pushTicks(recording.ticks);
    current = options.live || !ticks.length ? ticks.length - 1 : 0;
    selected = 0;
    rowsKey = '';
    switchesRendered = '';
    render();
    if (options.live) keepVisible();
    else scroller.scrollLeft = 0;
  }

  render();

  return {
    load,
    append(newTitle, newTrees, newTicks) {
      title = newTitle || title;
      for (const [name, def] of Object.entries(newTrees)) trees.set(name, toTreeDef(def));
      pushTicks(newTicks);
      trimLive();
      if (follow) current = ticks.length - 1;
      render();
      if (follow) keepVisible();
    },
  };
}
