// WebSocket 连接：断线后自动重连，并且接着用原来的角色。
//
// 可靠性（和服务端 internal/game/session/reliable.go 对应）：
//   - 每条连接的第一帧是 Hello{token, lastSeq}：token 是 Welcome 给的重连凭证，
//     lastSeq 是收到的最大服务端序号。服务端从下一条开始重放，接不上就发 Welcome{resumed} 和全量。
//   - 发出去的游戏消息带 seq，留在 unacked 里直到服务端的 input_ack 确认；断线期间按的键也先排着，
//     重连成功后按顺序补发，服务端按 seq 去重。服务端说是新角色时（token 过期），旧角色的输入作废。
//   - 收到的序号不连续（不应该发生）就主动断开重连，让服务端重放或发全量，而不是带着错的状态继续。
//   - 每秒发一次 Ping：保活，顺带告诉服务端收到哪了。

import type { Protocol } from './protocol';
import type { ClientMessage, ServerMessage } from './types';

export interface ConnectionHooks {
  onMessage(m: ServerMessage): void;
  onStatus(kind: 'wait' | 'ok' | 'bad', text: string): void;
}

export interface Connection {
  connect(): void;
  send(msg: ClientMessage): void;
}

const TOKEN_KEY = 'btdemo.token';   // sessionStorage：刷新页面也能接回同一个角色
const PING_MS = 1000;
const RETRY_MS = [500, 1000, 2000, 5000];   // 第 n 次重连前等多久，之后都按最后一个
const UNACKED_LIMIT = 512;

// 只关心最新值的消息：断线期间排队时，新的直接替换队尾同类的旧的
const STATE_KINDS = new Set<ClientMessage['t']>(['move', 'target', 'block', 'watch']);

interface Pending { seq: number; msg: ClientMessage; sent: boolean }

function loadToken(): string {
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

function saveToken(token: string): void {
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* 存不了就只在本页有效 */ }
}

export function createConnection(protocol: Protocol, hooks: ConnectionHooks): Connection {
  let ws: WebSocket | null = null;
  let ready = false;          // 已经收到这条连接的第一条消息，知道是不是原来的角色
  let retryTimer = 0;
  let retries = 0;
  let token = loadToken();
  let lastSeq = 0;            // 收到的最大服务端序号
  let nextSeq = 0;            // 最后一条游戏消息的序号
  let unacked: Pending[] = [];

  function connect(): void {
    clearTimeout(retryTimer);
    hooks.onStatus('wait', retries ? '重新连接中…' : '连接中…');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let sock: WebSocket;
    try {
      sock = new WebSocket(`${proto}//${location.host}/ws`);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = sock;
    ready = false;
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => {
      sock.send(protocol.encodeHello(token, lastSeq) as Uint8Array<ArrayBuffer>);
      hooks.onStatus('wait', '已连接，等待数据…');
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      let received;
      try { received = protocol.decode(ev.data); } catch (err) { console.warn('bad frame', err); return; }
      const { m, seq, inputAck } = received;
      const welcome = m?.t === 'welcome' ? m : null;
      if (seq && lastSeq && seq <= lastSeq && !welcome) return;   // 重放里已经收到过的
      if (seq && lastSeq && seq !== lastSeq + 1 && !welcome) {
        console.warn(`消息序号跳了：${lastSeq} → ${seq}，重新连接`);
        sock.close();
        return;
      }
      if (seq) lastSeq = seq;
      if (inputAck) unacked = unacked.filter((pending) => pending.seq > inputAck);
      if (!ready) {
        ready = true;
        retries = 0;
        // 新角色（第一次连，或者断太久角色已经没了）：旧角色没确认的输入作废
        if (welcome && !welcome.resumed) unacked = [];
        flushUnacked();
      }
      if (welcome && welcome.token && welcome.token !== token) {
        token = welcome.token;
        saveToken(token);
      }
      if (m) hooks.onMessage(m);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      ready = false;
      for (const pending of unacked) pending.sent = false;   // 不知道服务端收到没有：重连后都再发，它会去重
      hooks.onStatus('bad', '连接已断开，正在重连');
      scheduleReconnect();
    };
    sock.onerror = () => { /* 之后一定会触发 onclose，重连在那里处理 */ };
  }

  function scheduleReconnect(): void {
    clearTimeout(retryTimer);
    retryTimer = window.setTimeout(connect, RETRY_MS[Math.min(retries, RETRY_MS.length - 1)]);
    retries++;
  }

  // flushUnacked 发出所有还没发的输入（按顺序）。
  function flushUnacked(): void {
    if (!ws || !ready) return;
    for (const pending of unacked) {
      if (pending.sent) continue;
      const data = protocol.encode(pending.msg, pending.seq, lastSeq);
      if (data) ws.send(data as Uint8Array<ArrayBuffer>);
      pending.sent = true;
    }
  }

  function send(msg: ClientMessage): void {
    const last = unacked[unacked.length - 1];
    if (last && !last.sent && last.msg.t === msg.t && STATE_KINDS.has(msg.t)) {
      last.msg = msg;   // 还没发出去的同类状态消息：只留最新的
      last.seq = ++nextSeq;
    } else {
      unacked.push({ seq: ++nextSeq, msg, sent: false });
      if (unacked.length > UNACKED_LIMIT) {
        console.warn('断线太久，最早的输入不再补发');
        unacked.shift();
      }
    }
    flushUnacked();
  }

  window.setInterval(() => {
    if (ws && ready) ws.send(protocol.encodePing(lastSeq) as Uint8Array<ArrayBuffer>);
  }, PING_MS);

  return { connect, send };
}
