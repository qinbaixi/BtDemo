// 在游戏页里生成查看器的整页 HTML：导出文件和实时窗口都用它。
// 查看器脚本来自 virtual:btview-bundle（vite.config.ts 的 btviewBundle 插件把 entry.ts 单独打包成
// 一段字符串），所以生成的页面不依赖服务器，可以存成文件双击打开。

import type { BtRecording } from './model';

// 放进 <script> 里的文字不能出现 "</script"；JSON 里把 < 写成 < 就安全了
const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
const safeScript = (code: string) => code.replace(/<\/script/gi, '<\\/script');
const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

async function bundle(): Promise<string> {
  return (await import('virtual:btview-bundle')).default;
}

function page(title: string, head: string, code: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${head}
</head>
<body>
<div id="btv"></div>
<script>${safeScript(code)}</script>
</body>
</html>
`;
}

// recordingHtml 是一份可以单独打开的录像文件。
export async function recordingHtml(recording: BtRecording): Promise<string> {
  const data = `<script id="bt-data" type="application/json">${safeJson(recording)}</script>`;
  return page(`${recording.title || '行为树'} · 行为树回放`, data, await bundle());
}

// liveHtml 是实时窗口的页面：打开后通过 BroadcastChannel 向游戏页要数据。
export async function liveHtml(): Promise<string> {
  return page('行为树 · 实时', '<script>window.BT_LIVE = true;</script>', await bundle());
}
