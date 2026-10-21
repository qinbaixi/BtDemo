// WebSocket 连接：断线 2 秒后自动重连，收到的帧解码后交给 onMessage。

import type { Protocol } from './protocol';
import type { ClientMessage, ServerMessage } from './types';

export interface ConnectionHooks {
  onMessage(m: ServerMessage): void;
  onStatus(kind: 'wait' | 'ok' | 'bad', text: string): void;
  onClose(): void;   // 连接断开：清掉旧角色的状态
}

export interface Connection {
  connect(): void;
  send(msg: ClientMessage): void;
}

export function createConnection(protocol: Protocol, hooks: ConnectionHooks): Connection {
  let ws: WebSocket | null = null;
  let retryTimer = 0;

  function connect(): void {
    clearTimeout(retryTimer);
    hooks.onStatus('wait', '连接中…');
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
    sock.onopen = () => hooks.onStatus('wait', '已连接，等待数据…');
    sock.onmessage = (ev) => {
      let m: ServerMessage | null;
      try { m = protocol.decode(ev.data); } catch (err) { console.warn('bad frame', err); return; }
      if (m) hooks.onMessage(m);
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      hooks.onClose();
      hooks.onStatus('bad', '连接已断开，2 秒后重连');
      scheduleReconnect();
    };
    sock.onerror = () => { /* 之后一定会触发 onclose，重连在那里处理 */ };
  }

  function scheduleReconnect(): void {
    clearTimeout(retryTimer);
    retryTimer = window.setTimeout(connect, 2000);
  }

  function send(msg: ClientMessage): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const data = protocol.encode(msg);
      if (data) ws.send(data as Uint8Array<ArrayBuffer>);
    }
  }

  return { connect, send };
}
