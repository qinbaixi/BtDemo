// debug-proto.js: WebSocket protobuf 收发协议调试面板（纯内容，容器由外部抽屉提供）
// 用法: const panel = createProtoPanel(div); panel.log('in', 'sync', 123, obj); panel.setVisible(true);

const CAP = 600;            // 环形缓冲与 DOM 行数上限
const PREVIEW_MAX = 120;    // JSON 预览最大字符数
const SYNC_TYPE = 'sync';

function el(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function previewOf(obj) {
  let s;
  try { s = JSON.stringify(obj); } catch (_) { s = undefined; }
  if (s === undefined) s = String(obj);
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) + '…' : s;
}

function detailOf(obj) {
  let s;
  try { s = JSON.stringify(obj, null, 2); } catch (_) { s = undefined; }
  return s === undefined ? String(obj) : s;
}

export function createProtoPanel(root) {
  const doc = root.ownerDocument;
  const t0 = performance.now();
  root.classList.add('dp-root');

  const buf = [];        // 环形缓冲，最近 CAP 条记录
  const recent = [];     // 最近 1 秒内的记录，用于速率统计
  const itemEntry = new WeakMap(); // DOM 行 -> 记录
  let total = 0;
  let paused = false;
  let visible = false;
  let frameQueued = false;
  let pending = [];      // 等待下一帧追加到 DOM 的记录
  let statsTimer = 0;

  // ---- 工具栏 ----
  const toolbar = el(doc, 'div', 'dp-toolbar');
  const pauseBtn = el(doc, 'button', 'dp-btn', '暂停');
  pauseBtn.type = 'button';
  const clearBtn = el(doc, 'button', 'dp-btn', '清空');
  clearBtn.type = 'button';
  const filterInput = el(doc, 'input', 'dp-input');
  filterInput.type = 'text';
  filterInput.placeholder = '按类型过滤，如 sync';

  function makeCheck(text, checked) {
    const label = el(doc, 'label', 'dp-chk');
    const input = el(doc, 'input');
    input.type = 'checkbox';
    input.checked = checked;
    label.append(input, el(doc, 'span', null, text));
    return { label, input };
  }
  const chkIn = makeCheck('收', true);
  const chkOut = makeCheck('发', true);
  const chkHide = makeCheck('隐藏 sync', true);
  toolbar.append(pauseBtn, clearBtn, filterInput, chkIn.label, chkOut.label, chkHide.label);

  const stats = el(doc, 'div', 'dp-stats', '收 0/s 0.0KB/s · 发 0/s 0.0KB/s · 共 0 条');
  const list = el(doc, 'div', 'dp-list');
  root.append(toolbar, stats, list);

  // ---- 过滤 ----
  function passes(e) {
    if (e.dir === 'in' ? !chkIn.input.checked : !chkOut.input.checked) return false;
    if (chkHide.input.checked && e.type === SYNC_TYPE) return false;
    const q = filterInput.value.trim().toLowerCase();
    if (q && !e.type.toLowerCase().includes(q)) return false;
    return true;
  }

  // ---- 行构建 ----
  function ensureDetail(e) {
    if (!e.detail) {
      const d = el(doc, 'div', 'dp-detail');
      d.appendChild(el(doc, 'pre', 'dp-pre', detailOf(e.obj)));
      e.detail = d;
    }
    return e.detail;
  }

  function makeItem(e) {
    const item = el(doc, 'div', 'dp-item');
    itemEntry.set(item, e);
    if (e.prev == null) e.prev = previewOf(e.obj);

    const row = el(doc, 'div', 'dp-row');
    row.append(
      el(doc, 'span', 'dp-t', e.t.toFixed(2)),
      el(doc, 'span', 'dp-dir dp-' + e.dir, e.dir === 'in' ? '↓收' : '↑发'),
      el(doc, 'span', 'dp-type', e.type),
      el(doc, 'span', 'dp-bytes', e.bytes + ' B'),
      el(doc, 'span', 'dp-prev', e.prev)
    );
    item.appendChild(row);
    if (e.open) {
      item.classList.add('dp-open');
      item.appendChild(ensureDetail(e));
    }
    return item;
  }

  // 整表重建：仅用于用户操作（过滤、清空、暂停恢复）和重新显示
  function rebuild() {
    if (!visible) return;
    pending = [];
    list.textContent = '';
    const frag = doc.createDocumentFragment();
    for (const e of buf) if (passes(e)) frag.appendChild(makeItem(e));
    list.appendChild(frag);
    list.scrollTop = list.scrollHeight;
  }

  // ---- 每帧追加 ----
  function flush() {
    frameQueued = false;
    if (!visible || paused || pending.length === 0) { pending = []; return; }
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 30;
    const frag = doc.createDocumentFragment();
    for (const e of pending) frag.appendChild(makeItem(e));
    pending = [];
    list.appendChild(frag);
    while (list.childElementCount > CAP) list.removeChild(list.firstElementChild);
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  function scheduleFrame() {
    if (frameQueued || !visible) return;
    frameQueued = true;
    requestAnimationFrame(flush);
  }

  // ---- 统计（最多每 500ms 一次，仅可见时写 DOM）----
  function updateStats() {
    if (!visible) return;
    const now = (performance.now() - t0) / 1000;
    let inN = 0, inB = 0, outN = 0, outB = 0;
    for (const e of recent) {
      if (now - e.t > 1) continue;
      if (e.dir === 'in') { inN++; inB += e.bytes; } else { outN++; outB += e.bytes; }
    }
    stats.textContent =
      `收 ${inN}/s ${(inB / 1024).toFixed(1)}KB/s · 发 ${outN}/s ${(outB / 1024).toFixed(1)}KB/s · 共 ${total} 条`;
  }

  // ---- 交互 ----
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? '继续' : '暂停';
    if (paused) pending = [];
    else rebuild();
  });

  clearBtn.addEventListener('click', () => {
    buf.length = 0;
    recent.length = 0;
    total = 0;
    pending = [];
    rebuild();
    updateStats();
  });

  filterInput.addEventListener('input', rebuild);
  chkIn.input.addEventListener('change', rebuild);
  chkOut.input.addEventListener('change', rebuild);
  chkHide.input.addEventListener('change', rebuild);

  list.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || !t.closest || t.closest('.dp-detail')) return; // 选中 JSON 文本时不折叠
    const item = t.closest('.dp-item');
    const e = item && itemEntry.get(item);
    if (!e) return;
    e.open = !e.open;
    item.classList.toggle('dp-open', e.open);
    if (e.open) item.appendChild(ensureDetail(e));
    else if (e.detail && e.detail.parentNode === item) item.removeChild(e.detail);
  });

  // ---- 对外接口 ----
  function log(dir, type, bytes, obj) {
    const now = (performance.now() - t0) / 1000;
    const e = {
      t: now,
      dir: dir === 'out' ? 'out' : 'in',
      type: String(type),
      bytes: Number(bytes) || 0,
      obj,
      open: false,
      prev: null,
      detail: null,
    };
    total++;
    buf.push(e);
    if (buf.length > CAP) buf.shift();
    recent.push(e);
    while (recent.length && now - recent[0].t > 1) recent.shift();

    if (visible && !paused && passes(e)) {
      pending.push(e);
      if (pending.length > CAP) pending.splice(0, pending.length - CAP);
      scheduleFrame();
    }
  }

  function setVisible(v) {
    v = !!v;
    if (v === visible) return;
    visible = v;
    if (v) {
      rebuild();
      updateStats();
      statsTimer = setInterval(updateStats, 500);
    } else {
      clearInterval(statsTimer);
      statsTimer = 0;
      pending = [];
    }
  }

  return { log, setVisible };
}
