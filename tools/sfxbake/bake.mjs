// 音效烘焙脚本：把 web/src/audio/recipes.ts 的配方（和 assets-src/audio/ 里的真实素材）
// 烘焙成音频图集 web/public/audio/sfx.webm、sfx.m4a 和偏移表 audio.json。
//
// 用法（在 web/ 目录下）：
//   npm i --no-save playwright && npx playwright install chromium   # 第一次用之前装一次
//   npm run sfx:bake
//
// 过程：起一个 vite 开发服务器，用无头浏览器打开 /?sfxbake，在页面里用 OfflineAudioContext 离线渲染
// （见 web/src/audio/bake.ts），拿回 PCM 写成 wav，再用 ffmpeg 编码。没装 ffmpeg 时只出 sfx.wav（大一些，照样能用）。
//
// 真实素材：assets-src/audio/<声音名>/ 下放一个或几个 wav（多个就是多个变体，播放时随机挑），
// 比如 assets-src/audio/hit.blade.metal.light/1.wav。有素材的声音不再用配方；来源和授权记在 assets-src/audio/CREDITS.md。

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const web = path.join(root, 'web');
const outDir = path.join(web, 'public', 'audio');
const sourceDir = path.join(root, 'assets-src', 'audio');
const port = Number(process.env.SFXBAKE_PORT || 5179);

const require = createRequire(path.join(web, 'package.json'));
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('找不到 playwright。在 web/ 目录下先运行：npm i --no-save playwright && npx playwright install chromium');
  process.exit(1);
}

// readOverrides 收集真实素材：目录名就是声音名，里面每个 wav 是一个变体。
function readOverrides() {
  const overrides = {};
  if (!fs.existsSync(sourceDir)) return overrides;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = fs.readdirSync(path.join(sourceDir, entry.name)).filter((f) => /\.wav$/i.test(f)).sort();
    if (files.length) overrides[entry.name] = files.map((f) => fs.readFileSync(path.join(sourceDir, entry.name, f)).toString('base64'));
  }
  return overrides;
}

// startVite 起开发服务器（会先跑 npm run proto），等到能访问为止。
async function startVite() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npm, ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: web, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32',
    detached: process.platform !== 'win32',   // 自成一个进程组，结束时连 vite 子进程一起关掉
  });
  child.stdout.on('data', () => {});
  let exited = false;
  child.on('exit', () => { exited = true; });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    // 端口被占（--strictPort）或者 npm 出错时 vite 会直接退出；别去连别人的服务器
    if (exited) throw new Error(`vite 开发服务器没能启动（端口 ${port} 可能被占用，可以设 SFXBAKE_PORT 换一个）`);
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.ok) return child;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  stopTree(child);
  throw new Error('vite 开发服务器 60 秒内没有起来');
}

// stopTree 关掉 npm 和它起的 vite（只杀 npm 的话 vite 会留在后台占着端口）。
function stopTree(child) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    // 已经退出了
  }
}

// writeWav 把 Float32 单声道 PCM 写成 16 位 wav。
function writeWav(file, samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);              // PCM
  header.writeUInt16LE(1, 22);              // 单声道
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

function hasFfmpeg() {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

function ffmpeg(args) {
  const run = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} 失败`);
}

async function main() {
  const overrides = readOverrides();
  console.log(`真实素材：${Object.keys(overrides).length} 个声音`);
  const vite = await startVite();
  let result;
  let browser;
  try {
    browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.error('页面错误：', err.message));
    await page.goto(`http://localhost:${port}/?sfxbake`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.btdemo && window.btdemo.sfxbake, null, { timeout: 30000 });
    result = await page.evaluate((o) => window.btdemo.sfxbake(o), overrides);
  } finally {
    await browser?.close().catch(() => {});
    stopTree(vite);
  }
  const pcm = Buffer.from(result.pcm, 'base64');
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
  fs.mkdirSync(outDir, { recursive: true });
  for (const old of ['sfx.wav', 'sfx.webm', 'sfx.m4a']) fs.rmSync(path.join(outDir, old), { force: true });
  const wav = path.join(outDir, 'sfx.wav');
  writeWav(wav, samples, result.sampleRate);
  const files = {};
  if (hasFfmpeg()) {
    ffmpeg(['-i', wav, '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', path.join(outDir, 'sfx.webm')]);
    ffmpeg(['-i', wav, '-c:a', 'aac', '-b:a', '32k', '-ac', '1', path.join(outDir, 'sfx.m4a')]);
    fs.rmSync(wav);
    files.webm = 'sfx.webm';
    files.m4a = 'sfx.m4a';
  } else {
    console.warn('没找到 ffmpeg：只输出 sfx.wav（文件大一些）。装了 ffmpeg 再跑一遍可以得到 webm 和 m4a。');
    files.wav = 'sfx.wav';
  }
  // 指纹：加在图集地址后面，重新烘焙后浏览器不会拿缓存的旧图集去配新的偏移表
  const hash = createHash('sha1').update(pcm).digest('hex').slice(0, 10);
  const index = { version: 1, sampleRate: result.sampleRate, scale: result.scale, hash, files, sounds: result.sounds };
  fs.writeFileSync(path.join(outDir, 'audio.json'), JSON.stringify(index, null, 1) + '\n');
  const fromFiles = Object.entries(result.sources).filter(([, s]) => s === 'file').map(([n]) => n);
  const seconds = (samples.length / result.sampleRate).toFixed(1);
  console.log(`烘焙完成：${Object.keys(result.sounds).length} 个声音，共 ${seconds} 秒，整体音量 ×${result.scale}`);
  if (fromFiles.length) console.log(`用真实素材的：${fromFiles.join('、')}`);
  for (const [name, file] of Object.entries(files)) {
    console.log(`  ${name}: ${(fs.statSync(path.join(outDir, file)).size / 1024).toFixed(0)} KB`);
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
