// WebSocket 连接：断线后自动重连，并且接着用原来的角色。
//
//   - 每条连接的第一帧是 Hello{token}：token 是上一次 Welcome 给的重连凭证（存在 sessionStorage，
//     刷新页面也能接回）。服务端把断线的角色保留 30 秒；接得上就回 Welcome{resumed} 加全量，
//     接不上（token 空或过期）就当新角色。
//   - 协议里没有序号和确认：断线期间的输入直接丢掉，重连收到 Welcome 后由 main 把当前按键状态重发。
//   - 保活靠服务端发的 WebSocket ping，浏览器自动回 pong，客户端不用发心跳。

import type { Protocol } from './protocol';
import type { ClientMessage, ServerFrame } from './types';

export interface ConnectionHooks {
  onFrame(frame: ServerFrame): void;
  onStatus(kind: 'wait' | 'ok' | 'bad', text: string): void;
}

export interface Connection {
  connect(): void;
  send(msg: ClientMessage): void;
}

const TOKEN_KEY = 'btdemo.token';   // sessionStorage：刷新页面也能接回同一个角色
const RETRY_MS = [500, 1000, 2000, 5000];   // 第 n 次重连前等多久，之后都按最后一个

function loadToken(): string {
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

function saveToken(token: string): void {
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* 存不了就只在本页有效 */ }
}

export function createConnection(protocol: Protocol, hooks: ConnectionHooks): Connection {
  let ws: WebSocket | null = null;
  let retryTimer = 0;
  let retries = 0;
  let token = loadToken();

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
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => {
      sock.send(protocol.encodeHello(token) as Uint8Array<ArrayBuffer>);
      hooks.onStatus('wait', '已连接，等待数据…');
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      let frame: ServerFrame;
      try { frame = protocol.decode(ev.data); } catch (err) { console.warn('bad frame', err); return; }
      for (const m of frame.msgs) {
        if (m.t !== 'welcome') continue;
        retries = 0;
        if (m.token && m.token !== token) {
          token = m.token;
          saveToken(token);
        }
      }
      hooks.onFrame(frame);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
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

  // 没连上时直接丢掉：重连后服务端发全量，按键状态由 resendMove 补发
  function send(msg: ClientMessage): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const data = protocol.encode(msg);
    if (data) ws.send(data as Uint8Array<ArrayBuffer>);
  }

  return { connect, send };
}
