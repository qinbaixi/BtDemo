// 独立查看器的入口：会被 vite.config.ts 里的 btviewBundle 插件单独打成一段脚本，
// 塞进导出的 HTML 或实时窗口的页面里。
//   导出的文件：数据在 <script id="bt-data" type="application/json"> 里。
//   实时窗口：window.BT_LIVE 为 true，通过 BroadcastChannel 向游戏页要数据、收新帧。

import { createViewer } from './viewer';
import { LIVE_CHANNEL, type BtRecording, type LiveMsg } from './model';

declare global {
  interface Window {
    BT_LIVE?: boolean;
  }
}

function boot() {
  const root = document.getElementById('btv') || document.body.appendChild(document.createElement('div'));
  const live = !!window.BT_LIVE;
  const viewer = createViewer(root, { live });
  if (!live) {
    const dataTag = document.getElementById('bt-data');
    if (dataTag?.textContent) viewer.load(JSON.parse(dataTag.textContent) as BtRecording);
    return;
  }
  const channel = new BroadcastChannel(LIVE_CHANNEL);
  channel.onmessage = (event: MessageEvent<LiveMsg>) => {
    const message = event.data;
    if (message.t === 'snapshot') viewer.load(message.recording);
    else if (message.t === 'ticks') viewer.append(message.title, message.trees, message.ticks);
  };
  channel.postMessage({ t: 'hello' } satisfies LiveMsg);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
