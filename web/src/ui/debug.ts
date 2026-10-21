// Debug drawer: an "AI 决策" tab tracing the behavior tree of the selected
// monster or NPC, and a "协议" tab listing every frame sent and received.
// Toggled with the ` key or the 调试 button.

import { createProtoPanel } from './debug-proto';
import type { ClientEntity } from '../game/state';
import type { AiNode, AiTrace, ClientMessage } from '../net/types';

const LOG_CAP = 300;
const STATUS_TEXT = { success: '成功', failure: '失败', running: '运行中' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string | null): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// noteText turns a trace note from the server into a short label.
function noteText(n: string) {
  if (n.startsWith('blocked:')) return `条件未过 ${n.slice(8)}`;
  if (n.startsWith('service:')) return `服务 ${n.slice(8)}`;
  return `装饰 ${n}`;
}

// decision picks what a tick "decided": the last task visited that did not
// fail, with the chain of composites above it.
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
  // branches that were tried first and turned down, with the reason
  const skipped = [];
  for (let i = 0; i < leaf; i++) {
    const n = nodes[i];
    const why = n.notes.find((x) => x.startsWith('blocked:'));
    if (n.status === 'failure' && why) skipped.push(`${short(n.name)}（${noteText(why)}）`);
  }
  return { leaf: nodes[leaf], path, skipped };
}

const short = (name: string) => name.split(' ')[0];

/**
 * createDebug builds the drawer.
 *   send(obj)      sends a client message ({t:'watch', id})
 *   entity(id)     returns a client entity or undefined
 */
export type Debug = ReturnType<typeof createDebug>;

export function createDebug({ send, entity }: {
  send(msg: ClientMessage): void;
  entity(id: number): ClientEntity | undefined;
}) {
  const root = document.getElementById('debug');
  const tabs = root.querySelector('.dbg-tabs');
  const bodies = { ai: document.getElementById('dbg-ai'), proto: document.getElementById('dbg-proto') };
  const proto = createProtoPanel(bodies.proto);

  let open = false;
  let tab = 'ai';
  let target = 0;        // the selected entity
  let watching = 0;      // what the server was last asked to trace
  let traceId = 0;       // entity of the log below
  let lastSig = '';
  let paused = false;
  let traceAt = 0;       // when the last trace arrived
  let stale = false;

  // ---- AI tab layout ----
  const ai = bodies.ai;
  const head = el('div', 'dbg-head');
  const title = el('div', 'dbg-title', '未选择目标');
  const sub = el('div', 'dbg-sub', '点击一个怪物或 NPC 查看它的行为树决策');
  head.append(title, sub);
  const nowBox = el('div', 'dbg-section');
  const nowTitle = el('h5', null, '当前帧');
  const tree = el('div', 'dbg-tree');
  nowBox.append(nowTitle, tree);
  const bbBox = el('div', 'dbg-section');
  const bb = el('div', 'dbg-bb');
  bbBox.append(el('h5', null, '黑板与状态'), bb);
  const logBox = el('div', 'dbg-section dbg-logbox');
  const logBar = el('div', 'dbg-logbar');
  const pauseBtn = el('button', 'dbg-btn', '暂停');
  const clearBtn = el('button', 'dbg-btn', '清空');
  logBar.append(el('h5', null, '决策日志'), pauseBtn, clearBtn);
  const log = el('div', 'dbg-log');
  logBox.append(logBar, log);
  ai.append(head, nowBox, bbBox, logBox);

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? '继续' : '暂停';
  });
  clearBtn.addEventListener('click', () => { log.replaceChildren(); lastSig = ''; });

  tabs.addEventListener('click', (ev) => {
    const b = (ev.target as Element).closest('button');
    if (!b) return;
    if (b.dataset.tab) selectTab(b.dataset.tab);
    else if (b.classList.contains('dbg-close')) toggle(false);
  });
  document.getElementById('debug-btn')?.addEventListener('click', () => toggle());

  function selectTab(t) {
    tab = t;
    for (const b of tabs.querySelectorAll<HTMLElement>('[data-tab]')) b.classList.toggle('on', b.dataset.tab === t);
    for (const [k, body] of Object.entries(bodies)) body.classList.toggle('hidden', k !== t);
    proto.setVisible(open && t === 'proto');
    syncWatch();
  }

  function toggle(v = !open) {
    open = v;
    root.classList.toggle('hidden', !open);
    proto.setVisible(open && tab === 'proto');
    syncWatch();
  }

  // syncWatch asks the server to trace the selected NPC or monster while the
  // AI tab is on screen, and stops the trace otherwise.
  function syncWatch() {
    const e = target ? entity(target) : null;
    const want = open && tab === 'ai' && e && e.kind !== 'player' ? target : 0;
    if (want !== watching) {
      watching = want;
      traceAt = performance.now();
      send({ t: 'watch', id: want });
    }
    renderHead();
  }

  function renderHead() {
    const e = target ? entity(target) : null;
    if (!e || e.kind === 'player') {
      title.textContent = e ? `${e.name}（玩家，没有行为树）` : '未选择目标';
      sub.textContent = '点击一个怪物或 NPC 查看它的行为树决策';
      return;
    }
    title.textContent = `${e.name} #${e.id} · Lv${e.lv}${e.dead ? ' · 已阵亡' : ''}`;
  }

  function renderTick(trace, tick) {
    sub.textContent = `行为树 ${trace.tree} · ${tick.time.toFixed(1)}s`;
    nowTitle.textContent = `当前帧（访问 ${tick.nodes.length} 个节点）`;
    tree.replaceChildren(...tick.nodes.map((n) => {
      const row = el('div', `dbg-node st-${n.status}`);
      row.style.paddingLeft = `${6 + n.depth * 14}px`;
      row.append(el('span', 'dot'), el('span', `nm ${n.kind}`, n.name));
      for (const x of n.notes) row.append(el('span', 'tag', noteText(x)));
      row.title = `#${n.node} ${STATUS_TEXT[n.status] || n.status}`;
      return row;
    }));
    bb.replaceChildren(...trace.bb.flatMap((kv) => [el('span', 'k', kv.key), el('span', 'v', kv.value)]));
  }

  function appendLog(tick, d) {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    const row = el('div', `dbg-line st-${d.leaf.status}`);
    row.append(
      el('span', 't', tick.time.toFixed(1)),
      el('span', 'p', d.path.map((n) => short(n.name)).join(' › ')),
      el('span', 's', STATUS_TEXT[d.leaf.status] || d.leaf.status),
    );
    if (d.leaf.name.includes(' ')) row.append(el('div', 'args', d.leaf.name));
    if (d.skipped.length) row.append(el('div', 'skip', '跳过：' + d.skipped.join('，')));
    log.append(row);
    while (log.childElementCount > LOG_CAP) log.firstElementChild.remove();
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  return {
    toggle,

    // update flags a watch that has stopped producing traces: the entity
    // left the AOI or is dead (dead entities do not run their tree).
    update(now) {
      const quiet = watching !== 0 && now - traceAt > 1200;
      if (quiet && !stale) {
        sub.textContent = '不在视野内或已阵亡，暂无决策数据';
        tree.replaceChildren();
      }
      stale = quiet;
    },
    get open() { return open; },

    // frame is the protocol tap: every sent and received message.
    frame(dir, type, bytes, obj) { proto.log(dir, type, bytes, obj); },

    // setTarget follows the player's selection.
    setTarget(id) {
      if (id === target) return;
      target = id;
      syncWatch();
    },

    // reset forgets server-side state after a reconnect.
    reset() {
      watching = 0;
      syncWatch();
    },

    // trace takes Sync.ai.
    trace(t: AiTrace) {
      if (!t || t.id !== watching) return;
      if (t.ticks.length) traceAt = performance.now();   // dead entities send no ticks
      if (t.id !== traceId) {
        traceId = t.id;
        lastSig = '';
        log.replaceChildren();
      }
      renderHead();
      if (!t.ticks.length) return;
      if (open && tab === 'ai') renderTick(t, t.ticks[t.ticks.length - 1]);
      if (paused) return;
      for (const tick of t.ticks) {
        const d = decision(tick.nodes);
        if (!d) continue;
        // a task re-runs every tick (running, then success, then again);
        // log it once until the tree picks a different branch
        const sig = d.path.map((n) => n.node).join('/');
        if (sig === lastSig) continue;
        lastSig = sig;
        appendLog(tick, d);
      }
    },
  };
}
