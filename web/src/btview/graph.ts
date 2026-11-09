// 画板视图：照着行为树编辑器的画板画出整棵树（自上而下的节点卡片 + 贝塞尔连线），
// 再把当前这一帧的执行情况叠上去：
//   - 卡片外圈按结果着色（成功绿 / 失败红 / 运行中黄，运行中会呼吸；接着上一帧在跑的是虚线圈）；
//   - 左上角的数字是这一帧的访问顺序，顺着数字看就是这一帧的流向；
//   - 最终决策那条路径上的连线加粗，虚线顺着执行方向流动；
//   - 没执行到的节点变暗；条件装饰器显示通过 / 未通过，服务显示有没有触发，效用子节点显示分数。
// 卡片的样子（装饰器、服务在上，节点本身在最下面，左边一条类型色）和编辑器一致，
// 类型的颜色、图标、描述模板直接读 BtDemo 自己的 bt/owl-bt.json，不依赖编辑器的代码。
//
// 这个文件会被打进独立的查看器（导出的 HTML 和实时窗口），只能依赖 model.ts、DOM 和工程配置。

import css from './graph.css?inline';
import owlProject from '../../../bt/owl-bt.json';
import type { AiNode, AiScore, AiTreeNode } from '../net/types';
import { COMPOSITE_HINT, SCORE_DECORATORS, STATUS_TEXT, scoreText, subText } from './model';

// 布局参数（和编辑器差不多：同一层的卡片顶端对齐，层与层之间留出连线的空间）
const GAP_X = 28;            // 相邻两棵子树之间的横向间距
const GAP_Y = 64;            // 层与层之间的纵向间距
const LINK_STUB = 10;        // 连线从父卡片底部先垂直伸出的长度
const MARGIN = 40;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
const CAMERA_TIME = 320;     // 镜头移动动画时长（毫秒）
// 整棵树放不下时，开场至少用这个缩放（再小字就看不清了）；手机屏幕窄，放宽一点
const readableZoom = (width: number) => (width < 600 ? 0.55 : 0.75);

// ---------- 节点类型：颜色、图标、描述 ----------

interface TypeInfo {
  color?: string;
  icon?: string;
  description?: string;
  name: string;              // 编辑器里的类型名，例如 UtilitySelector
}

interface OwlItem {
  name: string;
  icon?: string;
  color?: string;
  description?: string;
}

// 编辑器的类型名转成导出的 sub_type：UtilitySelector -> utility_selector
const snakeCase = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

const TYPE_INFO = new Map<string, TypeInfo>();
for (const group of ['nodes', 'decorators', 'services'] as const) {
  for (const item of ((owlProject as Record<string, unknown>)[group] || []) as OwlItem[]) {
    TYPE_INFO.set(`${group}:${snakeCase(item.name)}`, {
      color: item.color,
      icon: item.icon,
      description: item.description,
      name: item.name,
    });
  }
}

function typeInfo(node: AiTreeNode): TypeInfo | undefined {
  const group = node.kind === 'decorator' ? 'decorators' : node.kind === 'service' ? 'services' : 'nodes';
  return TYPE_INFO.get(`${group}:${node.subType}`);
}

// 没配颜色的类型按种类给一个默认色
const DEFAULT_COLOR: Record<string, string> = {
  composite: '#8f9cff',
  task: '#4fb3a9',
  decorator: '#b48cf0',
  service: '#4fa3e8',
};

// 编辑器用的是 Font Awesome 图标；查看器要能离线打开，不带字体，挑形状接近的字符代替。
// ︎ 让这些字符按文字而不是彩色 emoji 显示。
const ICON_GLYPH: Record<string, string> = {
  question: '?', 'arrow-right': '→', bars: '≡', shuffle: '⤨', 'scale-balanced': '⚖',
  eye: '◉', eraser: '⌫', 'person-running': '»', 'wand-magic-sparkles': '✦', 'shoe-prints': '∴',
  house: '⌂', hourglass: '⧗', comment: '❝', paw: '❦', 'arrows-left-right': '↔',
  'hand-holding-heart': '♥', 'arrows-split-up-and-left': '⤧', users: '☷', flag: '⚑', crosshairs: '⌖',
  shield: '⛉', share: '↪', repeat: '↻', 'street-view': '☗', 'exclamation-triangle': '⚠',
  'long-arrow-right': '⟶', ruler: '⟷', 'heart-crack': '♡', route: '⤳', burst: '✸', check: '✓',
  clock: '◷', 'clock-o': '◷', 'people-group': '☷', 'flag-checkered': '⚐', 'chart-line': '〽',
  'satellite-dish': '⌔', 'shield-halved': '⛉',
};

function glyphOf(node: AiTreeNode, info: TypeInfo | undefined): string {
  const glyph = info?.icon ? ICON_GLYPH[info.icon] : undefined;
  if (glyph) return glyph + '︎';
  return (info?.name || node.subType).charAt(0).toUpperCase();
}

// describe 用属性填描述模板：“目标在 {{Range}} 以内” -> “目标在 60 以内”。
function describe(node: AiTreeNode, info: TypeInfo | undefined): string {
  const props = new Map(node.props.map((prop) => [prop.key, prop.value]));
  if (info?.description) {
    return info.description.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => props.get(key) ?? whole);
  }
  return node.props.map((prop) => `${prop.key}=${prop.value}`).join(' ');
}

// ---------- 对外接口 ----------

export interface GraphVisit {
  order: number;
  node: AiNode;
}

// GraphFrame 是画板要显示的一帧。
export interface GraphFrame {
  treeName: string;
  root: number;
  nodes: Map<number, AiTreeNode>;
  visits: Map<number, GraphVisit>;
  scores: Map<number, AiScore>;
  pathIds: number[];          // 根到最终决策任务的路径
  paused?: string;            // 这一帧行为树没跑（硬直、击退、前摇）的原因
  focus: number;              // 选中（或默认跟着决策）的节点
  folded: Set<number>;        // 折叠起来的节点
}

export type GraphItemKind = 'node' | 'decorator' | 'service';

export interface GraphCallbacks {
  select(nodeId: number): void;
  toggleFold(nodeId: number): void;
  // tipText 返回悬停在某个卡片行上时显示的说明
  tipText(kind: GraphItemKind, itemId: number, ownerId: number): string;
  showTip(text: string, clientX: number, clientY: number): void;
  hideTip(): void;
}

export interface Graph {
  element: HTMLElement;
  render(frame: GraphFrame | null, emptyText?: string): void;
  // 画板刚显示出来（之前是隐藏的，量不出尺寸）时调用
  shown(): void;
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

// serviceFired 判断服务这一帧有没有触发（追踪备注 "service:<名字>[ 说明]"）。
function serviceFired(visit: GraphVisit | undefined, subType: string): boolean {
  if (!visit) return false;
  return visit.node.notes.some((note) => note === `service:${subType}` || note.startsWith(`service:${subType} `));
}

// ---------- 卡片 ----------

interface SubRow {
  kind: 'decorator' | 'service';
  node: AiTreeNode;
  element: HTMLElement;
  state: HTMLElement;
}

interface Card {
  node: AiTreeNode;
  element: HTMLElement;
  order: HTMLElement;
  result: HTMLElement;
  score: HTMLElement;
  subs: SubRow[];
  children: number[];         // 画出来的子节点（折叠了就是空）
  width: number;
  height: number;
  x: number;
  y: number;
  depth: number;
}

interface Link {
  parent: number;
  child: number;
  path: SVGPathElement;
}

function itemRow(kind: GraphItemKind, node: AiTreeNode, ownerId: number): { row: HTMLElement; state: HTMLElement } {
  const info = typeInfo(node);
  const row = el('div', `gv-item gv-${kind === 'node' ? 'head' : kind}`);
  row.style.setProperty('--item-color', info?.color || DEFAULT_COLOR[node.kind] || DEFAULT_COLOR.task);
  row.dataset.tipKind = kind;
  row.dataset.tipId = String(node.id);
  row.dataset.tipOwner = String(ownerId);
  if (kind !== 'node') row.append(el('span', 'gv-tag', kind === 'decorator' ? 'DEC' : 'SVC'));
  row.append(el('span', 'gv-badge', glyphOf(node, info)));
  const content = el('div', 'gv-content');
  const name = el('div', 'gv-name');
  const typeName = `${node.inverse ? '[非] ' : ''}${subText(node.subType)}`;
  if (node.label) {
    name.append(el('span', 'gv-namesub', `(${typeName})`), el('span', 'gv-label', node.label));
  } else {
    name.textContent = typeName;
  }
  content.append(name);
  const description = describe(node, info);
  if (description) content.append(el('div', 'gv-desc', description));
  const flags: string[] = [];
  if (node.periodic) flags.push('运行中复查');
  if (kind === 'service' && node.interval) flags.push(`每 ${node.interval}s`);
  if (flags.length) content.append(el('div', 'gv-flags', flags.join(' · ')));
  row.append(content);
  if (kind !== 'node') row.append(el('span', 'gv-id', `#${node.id}`));
  const state = el('span', 'gv-state');
  row.append(state);
  return { row, state };
}

function buildCard(node: AiTreeNode, nodes: Map<number, AiTreeNode>, folded: boolean, hiddenCount: number): Card {
  const element = el('div', `gv-card k-${node.kind}`);
  element.dataset.id = String(node.id);
  const info = typeInfo(node);
  element.style.setProperty('--item-color', info?.color || DEFAULT_COLOR[node.kind] || DEFAULT_COLOR.task);
  const order = el('span', 'gv-order');
  const nodeId = el('span', 'gv-nodeid', `#${node.id}`);
  const result = el('span', 'gv-result');
  const score = el('span', 'gv-scoreb');
  element.append(order, nodeId, result, score);
  const subs: SubRow[] = [];
  for (const decoratorId of node.decorators) {
    const decorator = nodes.get(decoratorId);
    if (!decorator) continue;
    const { row, state } = itemRow('decorator', decorator, node.id);
    element.append(row);
    subs.push({ kind: 'decorator', node: decorator, element: row, state });
  }
  for (const serviceId of node.services) {
    const service = nodes.get(serviceId);
    if (!service) continue;
    const { row, state } = itemRow('service', service, node.id);
    element.append(row);
    subs.push({ kind: 'service', node: service, element: row, state });
  }
  const head = itemRow('node', node, node.id);
  if (COMPOSITE_HINT[node.subType]) head.row.title = COMPOSITE_HINT[node.subType];
  element.append(head.row);
  if (node.children.length) {
    const fold = el('button', `gv-fold${folded ? ' folded' : ''}`, folded ? `+${hiddenCount}` : '−');
    fold.title = folded ? '展开子树' : '折叠子树';
    fold.dataset.fold = String(node.id);
    element.append(fold);
  }
  return {
    node,
    element,
    order,
    result,
    score,
    subs,
    children: [],
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    depth: 0,
  };
}

// ---------- 画板 ----------

export function createGraph(callbacks: GraphCallbacks): Graph {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);

  const host = el('div', 'gv');
  const content = el('div', 'gv-content-layer');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('gv-links');
  const cardLayer = el('div', 'gv-cards');
  content.append(svg, cardLayer);
  const empty = el('div', 'gv-empty hidden');
  const pausedBanner = el('div', 'gv-paused hidden');
  const tools = el('div', 'gv-tools');
  const tool = (text: string, tip: string) => {
    const button = el('button', 'gv-tool', text);
    button.title = tip;
    tools.append(button);
    return button;
  };
  const followButton = tool('跟随决策', '决策换了就把镜头移到正在执行的任务上');
  const fitButton = tool('适应', '整棵树放进画面（双击空白处也可以）');
  const zoomOutButton = tool('−', '缩小（滚轮）');
  const zoomInButton = tool('+', '放大（滚轮）');
  const legend = el('div', 'gv-legend');
  legend.innerHTML =
    '<span><i class="ring success"></i>成功</span><span><i class="ring failure"></i>失败</span>' +
    '<span><i class="ring running"></i>运行中</span><span><i class="ring cont"></i>接着上一帧</span>' +
    '<span><b class="num">3</b>执行顺序</span><span><i class="flow"></i>最终决策路径</span>';
  host.append(content, empty, pausedBanner, tools, legend);

  let cards = new Map<number, Card>();
  let links: Link[] = [];
  let builtKey = '';
  let laidOut = false;
  let lastFrame: GraphFrame | null = null;
  let follow = true;
  let lastLeaf = -1;
  let lastTree = '';
  // 镜头：屏幕坐标 = 画板坐标 * scale + (offsetX, offsetY)
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let contentWidth = 0;
  let contentHeight = 0;
  let cameraAnimation = 0;
  let userMoved = false;       // 用户自己拖过、缩放过镜头：画板尺寸变化时不再自动摆镜头

  function applyCamera() {
    content.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    const grid = 16 * scale;
    host.style.backgroundSize = `${grid}px ${grid}px`;
    host.style.backgroundPosition = `${offsetX}px ${offsetY}px`;
  }

  function moveCamera(targetScale: number, targetX: number, targetY: number, animate: boolean) {
    cancelAnimationFrame(cameraAnimation);
    if (!animate) {
      scale = targetScale;
      offsetX = targetX;
      offsetY = targetY;
      applyCamera();
      return;
    }
    const startScale = scale;
    const startX = offsetX;
    const startY = offsetY;
    const startTime = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - startTime) / CAMERA_TIME);
      const eased = 1 - Math.pow(1 - progress, 3);
      scale = startScale + (targetScale - startScale) * eased;
      offsetX = startX + (targetX - startX) * eased;
      offsetY = startY + (targetY - startY) * eased;
      applyCamera();
      if (progress < 1) cameraAnimation = requestAnimationFrame(step);
    };
    cameraAnimation = requestAnimationFrame(step);
  }

  function fit(animate: boolean) {
    if (!contentWidth || !host.clientWidth) return;
    const fitScale = Math.max(
      MIN_ZOOM,
      Math.min(1, (host.clientWidth - 20) / contentWidth, (host.clientHeight - 50) / contentHeight),
    );
    moveCamera(
      fitScale,
      (host.clientWidth - contentWidth * fitScale) / 2,
      Math.max(10, (host.clientHeight - contentHeight * fitScale) / 2),
      animate,
    );
  }

  // initialView 是开场镜头：整棵树放得下（字还看得清）就整棵放进来，
  // 放不下就用 readableZoom，对准正在执行的任务（没有就对准根节点）。
  function initialView(animate: boolean) {
    userMoved = false;
    if (!contentWidth || !host.clientWidth) return;
    const fitScale = Math.min(1, (host.clientWidth - 20) / contentWidth, (host.clientHeight - 50) / contentHeight);
    const zoom = readableZoom(host.clientWidth);
    if (fitScale >= zoom) {
      fit(animate);
      return;
    }
    const focusCard = cards.get(lastLeaf) || cards.get(lastFrame?.root ?? -1);
    if (!focusCard) return;
    const focusX = focusCard.x + focusCard.width / 2;
    const focusY = focusCard.y + focusCard.height / 2;
    moveCamera(
      zoom,
      host.clientWidth / 2 - focusX * zoom,
      Math.min(10, host.clientHeight * 0.45 - focusY * zoom),
      animate,
    );
  }

  // centerOn 把某张卡片移到画面中间偏上（不改缩放）。卡片已经在画面里就不动。
  function centerOn(nodeId: number, animate: boolean) {
    const card = cards.get(nodeId);
    if (!card || !host.clientWidth) return;
    const left = card.x * scale + offsetX;
    const top = card.y * scale + offsetY;
    const right = left + card.width * scale;
    const bottom = top + card.height * scale;
    const pad = 40;
    if (left > pad && top > pad && right < host.clientWidth - pad && bottom < host.clientHeight - pad) return;
    moveCamera(
      scale,
      host.clientWidth / 2 - (card.x + card.width / 2) * scale,
      host.clientHeight * 0.4 - (card.y + card.height / 2) * scale,
      animate,
    );
  }

  function zoomAt(factor: number, screenX: number, screenY: number) {
    const nextScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale * factor));
    const worldX = (screenX - offsetX) / scale;
    const worldY = (screenY - offsetY) / scale;
    moveCamera(nextScale, screenX - worldX * nextScale, screenY - worldY * nextScale, false);
  }

  // ---------- 搭建与布局 ----------

  function build(frame: GraphFrame) {
    const key = `${frame.treeName}|${frame.nodes.size}|${[...frame.folded].sort().join(',')}`;
    if (key === builtKey) return;
    builtKey = key;
    laidOut = false;
    cards = new Map();
    links = [];
    const countDescendants = (id: number): number => {
      const node = frame.nodes.get(id);
      return node ? node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0) : 0;
    };
    const walk = (id: number, depth: number) => {
      const node = frame.nodes.get(id);
      if (!node || cards.has(id)) return;
      const isFolded = frame.folded.has(id);
      const card = buildCard(node, frame.nodes, isFolded, isFolded ? countDescendants(id) : 0);
      card.depth = depth;
      cards.set(id, card);
      if (isFolded) return;
      for (const childId of node.children) {
        if (!frame.nodes.has(childId)) continue;
        card.children.push(childId);
        walk(childId, depth + 1);
      }
    };
    walk(frame.root, 0);
    cardLayer.replaceChildren(...[...cards.values()].map((card) => card.element));
    svg.replaceChildren();
    for (const card of cards.values()) {
      for (const childId of card.children) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.classList.add('gv-link');
        svg.append(path);
        links.push({ parent: card.node.id, child: childId, path });
      }
    }
  }

  // layout 量出每张卡片的大小，再排位置：子树宽度自下而上累加，父节点居中在子节点上方，
  // 同一层的卡片顶端对齐，层高取这一层最高的卡片。
  function layout(frame: GraphFrame): boolean {
    if (laidOut) return true;
    if (!host.clientWidth) return false;   // 画板还没显示出来，量不出尺寸
    for (const card of cards.values()) {
      card.width = card.element.offsetWidth;
      card.height = card.element.offsetHeight;
    }
    const spans = new Map<number, number>();
    const spanOf = (id: number): number => {
      const card = cards.get(id);
      let childrenWidth = 0;
      card.children.forEach((childId, index) => {
        childrenWidth += spanOf(childId) + (index ? GAP_X : 0);
      });
      const span = Math.max(card.width, childrenWidth);
      spans.set(id, span);
      return span;
    };
    spanOf(frame.root);
    const levelHeights: number[] = [];
    for (const card of cards.values()) {
      levelHeights[card.depth] = Math.max(levelHeights[card.depth] || 0, card.height);
    }
    const levelTops: number[] = [];
    let top = MARGIN;
    for (let depth = 0; depth < levelHeights.length; depth++) {
      levelTops[depth] = top;
      top += (levelHeights[depth] || 0) + GAP_Y;
    }
    // place 把子树放在 [left, left + span) 里，返回这张卡片中心的横坐标
    const place = (id: number, left: number): number => {
      const card = cards.get(id);
      const span = spans.get(id);
      let center: number;
      if (card.children.length) {
        let childrenWidth = 0;
        card.children.forEach((childId, index) => {
          childrenWidth += spans.get(childId) + (index ? GAP_X : 0);
        });
        let childLeft = left + (span - childrenWidth) / 2;
        const centers = card.children.map((childId) => {
          const childCenter = place(childId, childLeft);
          childLeft += spans.get(childId) + GAP_X;
          return childCenter;
        });
        center = (centers[0] + centers[centers.length - 1]) / 2;
      } else {
        center = left + span / 2;
      }
      card.x = center - card.width / 2;
      card.y = levelTops[card.depth];
      return center;
    };
    place(frame.root, MARGIN);
    let maxRight = 0;
    let maxBottom = 0;
    for (const card of cards.values()) {
      card.element.style.left = `${card.x}px`;
      card.element.style.top = `${card.y}px`;
      maxRight = Math.max(maxRight, card.x + card.width);
      maxBottom = Math.max(maxBottom, card.y + card.height);
    }
    contentWidth = maxRight + MARGIN;
    contentHeight = maxBottom + MARGIN;
    content.style.width = `${contentWidth}px`;
    content.style.height = `${contentHeight}px`;
    svg.setAttribute('width', String(contentWidth));
    svg.setAttribute('height', String(contentHeight));
    for (const link of links) {
      const parent = cards.get(link.parent);
      const child = cards.get(link.child);
      const startX = parent.x + parent.width / 2;
      const startY = parent.y + parent.height;
      const endX = child.x + child.width / 2;
      const endY = child.y;
      const middle = (startY + LINK_STUB + endY) / 2;
      link.path.setAttribute(
        'd',
        `M${startX},${startY}V${startY + LINK_STUB}` +
          `C${startX},${middle} ${endX},${middle} ${endX},${endY}`,
      );
    }
    laidOut = true;
    return true;
  }

  // ---------- 每帧的状态 ----------

  function paint(frame: GraphFrame) {
    const pathSet = new Set(frame.pathIds);
    const leafId = frame.pathIds[frame.pathIds.length - 1] ?? -1;
    for (const card of cards.values()) {
      const id = card.node.id;
      const visit = frame.visits.get(id);
      const status = visit?.node.status;
      const classes = card.element.classList;
      classes.toggle('run-idle', !visit);
      classes.toggle('run-success', status === 'success');
      classes.toggle('run-failure', status === 'failure');
      classes.toggle('run-running', status === 'running' && visit.node.fresh !== false);
      classes.toggle('run-cont', status === 'running' && visit.node.fresh === false);
      classes.toggle('on-path', pathSet.has(id));
      classes.toggle('leaf', id === leafId);
      classes.toggle('sel', id === frame.focus);
      card.order.textContent = visit ? String(visit.order) : '';
      card.result.textContent = status === 'success' ? '✓' : status === 'failure' ? '✗' : '';
      card.result.className = `gv-result${status === 'success' || status === 'failure' ? ' ' + status : ''}`;
      const score = frame.scores.get(id);
      card.score.textContent = score ? `⚖︎ ${scoreText(score.score)}` : '';
      for (const sub of card.subs) {
        let state = '';
        let text = '';
        if (sub.kind === 'decorator') {
          const subScore = frame.scores.get(sub.node.id);
          if (subScore || SCORE_DECORATORS.has(sub.node.subType)) {
            if (subScore) {
              state = 'score';
              text = scoreText(subScore.score);
            }
          } else {
            const check = visit?.node.checks.find((item) => item.node === sub.node.id);
            if (check) {
              state = check.pass ? 'pass' : 'fail';
              text = check.pass ? '✓' : '✗';
            } else if (visit?.node.notes.includes(sub.node.subType)) {
              state = 'changed';
              text = '!';
            }
          }
        } else if (serviceFired(visit, sub.node.subType)) {
          state = 'ran';
          text = '⚡︎';
        }
        sub.element.dataset.state = state;
        sub.state.textContent = text;
      }
    }
    for (const link of links) {
      const visit = frame.visits.get(link.child);
      const status = visit ? visit.node.status : 'idle';
      link.path.setAttribute(
        'class',
        `gv-link ${status}${pathSet.has(link.parent) && pathSet.has(link.child) ? ' on-path' : ''}`,
      );
    }
  }

  // ---------- 对外 ----------

  function render(frame: GraphFrame | null, emptyText = '') {
    lastFrame = frame;
    empty.textContent = emptyText;
    empty.classList.toggle('hidden', !!frame);
    content.classList.toggle('hidden', !frame);
    pausedBanner.textContent = frame?.paused ? `⏸ ${frame.paused}` : '';
    pausedBanner.classList.toggle('hidden', !frame?.paused);
    if (!frame) return;
    const treeChanged = frame.treeName !== lastTree;
    build(frame);
    if (!layout(frame)) return;
    paint(frame);
    const leafId = frame.pathIds[frame.pathIds.length - 1] ?? -1;
    if (treeChanged) {
      lastTree = frame.treeName;
      lastLeaf = leafId;
      initialView(false);
      return;
    }
    if (follow && leafId !== lastLeaf && leafId >= 0) centerOn(leafId, true);
    lastLeaf = leafId;
  }

  function shown() {
    if (!lastFrame) return;
    const firstTime = !laidOut;
    render(lastFrame);
    if (firstTime && laidOut) initialView(false);
  }

  // ---------- 交互：拖动平移、滚轮 / 双指缩放、点击选中、折叠 ----------

  const pointers = new Map<number, { x: number; y: number }>();
  let dragged = false;
  let pinchDistance = 0;
  const hostPoint = (clientX: number, clientY: number) => {
    const box = host.getBoundingClientRect();
    return { x: clientX - box.left, y: clientY - box.top };
  };

  host.addEventListener('pointerdown', (event) => {
    if ((event.target as HTMLElement).closest('.gv-tools, .gv-fold')) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) dragged = false;
    if (pointers.size === 2) {
      const [first, second] = [...pointers.values()];
      pinchDistance = Math.hypot(first.x - second.x, first.y - second.y);
    }
    host.setPointerCapture(event.pointerId);
  });
  host.addEventListener('pointermove', (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const deltaX = event.clientX - previous.x;
    const deltaY = event.clientY - previous.y;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [first, second] = [...pointers.values()];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const middle = hostPoint((first.x + second.x) / 2, (first.y + second.y) / 2);
      userMoved = true;
      if (pinchDistance > 0) zoomAt(distance / pinchDistance, middle.x, middle.y);
      pinchDistance = distance;
      dragged = true;
      return;
    }
    if (!dragged && Math.hypot(deltaX, deltaY) < 1) return;
    if (!dragged) {
      dragged = true;
      setFollow(false);
      callbacks.hideTip();
    }
    cancelAnimationFrame(cameraAnimation);
    userMoved = true;
    offsetX += deltaX;
    offsetY += deltaY;
    applyCamera();
  });
  const release = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
  };
  host.addEventListener('pointerup', release);
  host.addEventListener('pointercancel', release);

  host.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const fold = target.closest<HTMLElement>('[data-fold]');
    if (fold) {
      callbacks.toggleFold(Number(fold.dataset.fold));
      return;
    }
    if (dragged) return;
    const card = target.closest<HTMLElement>('.gv-card');
    if (card) callbacks.select(Number(card.dataset.id));
  });
  host.addEventListener('dblclick', (event) => {
    if (!(event.target as HTMLElement).closest('.gv-card, .gv-tools')) {
      fit(true);
      userMoved = true;
    }
  });
  host.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const point = hostPoint(event.clientX, event.clientY);
      userMoved = true;
      zoomAt(Math.exp(-event.deltaY * 0.0015), point.x, point.y);
    },
    { passive: false },
  );
  host.addEventListener('mousemove', (event) => {
    if (pointers.size) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-tip-kind]');
    if (!row) {
      callbacks.hideTip();
      return;
    }
    const text = callbacks.tipText(
      row.dataset.tipKind as GraphItemKind,
      Number(row.dataset.tipId),
      Number(row.dataset.tipOwner),
    );
    callbacks.showTip(text, event.clientX, event.clientY);
  });
  host.addEventListener('mouseleave', () => callbacks.hideTip());

  function setFollow(value: boolean) {
    follow = value;
    followButton.classList.toggle('on', follow);
  }
  setFollow(true);
  followButton.addEventListener('click', () => {
    setFollow(!follow);
    if (follow && lastLeaf >= 0) centerOn(lastLeaf, true);
  });
  fitButton.addEventListener('click', () => fit(true));
  zoomInButton.addEventListener('click', () => {
    userMoved = true;
    zoomAt(1.25, host.clientWidth / 2, host.clientHeight / 2);
  });
  zoomOutButton.addEventListener('click', () => {
    userMoved = true;
    zoomAt(0.8, host.clientWidth / 2, host.clientHeight / 2);
  });
  // 画板尺寸变了（窗口缩放、从隐藏变成显示）：没量过就补上布局，用户没动过镜头就重摆开场镜头
  new ResizeObserver(() => {
    if (!lastFrame || !host.clientWidth) return;
    if (!laidOut) shown();
    else if (!userMoved) initialView(false);
  }).observe(host);

  applyCamera();
  return { element: host, render, shown };
}

// statusText 给悬停说明用（和列表视图一致）
export const graphStatusText = (node: AiNode) =>
  `${STATUS_TEXT[node.status]}${node.fresh === false ? '（接着上一帧）' : ''}`;
