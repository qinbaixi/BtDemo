// Debug drawer: an "AI 决策" tab tracing the behavior tree of the selected
// monster or NPC, and a "协议" tab listing every frame sent and received.
// Toggled with the ` key or the 调试 button.

import { createProtoPanel } from './debug-proto';
import type { ClientEntity } from '../game/state';
import { createAiPanel } from './debug-ai';
import type { AiTrace, ClientMessage } from '../net/types';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string | null): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

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
  let traceId = 0;       // entity the panel is showing
  let traceAt = 0;       // when the last trace arrived
  let stale = false;
  let defAskedAt = 0;

  // ---- AI tab layout ----
  const ai = bodies.ai;
  const head = el('div', 'dbg-head');
  const title = el('div', 'dbg-title', '未选择目标');
  const sub = el('div', 'dbg-sub', '点击一个怪物或 NPC 查看它的行为树决策');
  head.append(title, sub);
  ai.append(head);
  const panel = createAiPanel(ai, sub, () => {
    // 缺树结构（比如断线重连）：重新发一次 watch，服务端会附上结构
    const now = performance.now();
    if (watching && now - defAskedAt > 2000) {
      defAskedAt = now;
      send({ t: 'watch', id: watching });
    }
  });

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

  return {
    toggle,

    // update flags a watch that has stopped producing traces: the entity
    // left the AOI or is dead (dead entities do not run their tree).
    update(now) {
      const quiet = watching !== 0 && now - traceAt > 1200;
      if (quiet && !stale) panel.stale();
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
        panel.clear();
      }
      renderHead();
      panel.trace(t);
    },
  };
}
