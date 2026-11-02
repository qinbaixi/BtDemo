// 行为树录像：调试面板观察某个实体时，把它每一帧的追踪都记下来（比面板里的历史长得多），
// 可以导出成单文件 HTML，也可以实时转发给独立的查看器窗口（同源页面之间用 BroadcastChannel）。

import type { AiTrace, AiTreeDef } from '../net/types';
import { LIVE_CHANNEL, type BtRecording, type LiveMsg, type RecTick, type RecTreeDef } from '../btview/model';

const RECORD_CAP = 3000;   // 最多录多少帧（20 帧/秒时约两分半）

function toRecTree(def: AiTreeDef): RecTreeDef {
  return { root: def.root, nodes: [...def.nodes.values()] };
}

function localTimeText(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export class BtRecorder {
  private title = '';
  private trees: Record<string, RecTreeDef> = {};
  private ticks: RecTick[] = [];
  private lastBlackboard = '';
  private channel: BroadcastChannel | null = null;
  private liveViewers = false;   // 有实时窗口打过招呼才往外发

  constructor() {
    if (typeof BroadcastChannel === 'undefined') return;
    this.channel = new BroadcastChannel(LIVE_CHANNEL);
    this.channel.onmessage = (event: MessageEvent<LiveMsg>) => {
      if (event.data?.t !== 'hello') return;
      this.liveViewers = true;
      this.post({ t: 'snapshot', recording: this.recording() });
    };
  }

  get length() {
    return this.ticks.length;
  }

  // reset 换了观察对象：清空录像，通知实时窗口。
  reset() {
    this.trees = {};
    this.ticks = [];
    this.lastBlackboard = '';
    if (this.liveViewers) this.post({ t: 'snapshot', recording: this.recording() });
  }

  setTitle(title: string) {
    this.title = title;
  }

  // add 记下一次同步带来的追踪；def 是调试面板手里这棵树的结构。
  add(trace: AiTrace, def: AiTreeDef | undefined) {
    const newTrees: Record<string, RecTreeDef> = {};
    if (def && !this.trees[trace.tree]) {
      this.trees[trace.tree] = newTrees[trace.tree] = toRecTree(def);
    }
    if (!trace.ticks.length) return;
    const blackboardText = JSON.stringify(trace.bb);
    const newTicks: RecTick[] = [];
    for (const tick of trace.ticks) {
      const recTick: RecTick = { time: tick.time, tree: trace.tree, nodes: tick.nodes };
      if (blackboardText !== this.lastBlackboard || !this.ticks.length) {
        recTick.bb = trace.bb;
        this.lastBlackboard = blackboardText;
      }
      newTicks.push(recTick);
      this.ticks.push(recTick);
    }
    if (this.ticks.length > RECORD_CAP) {
      this.ticks = this.ticks.slice(this.ticks.length - RECORD_CAP);
      // 第一帧必须带完整黑板，查看器才补得齐
      if (!this.ticks[0].bb) this.ticks[0] = { ...this.ticks[0], bb: this.blackboardAt(0) };
    }
    if (this.liveViewers) this.post({ t: 'ticks', title: this.title, trees: newTrees, ticks: newTicks });
  }

  // blackboardAt 往前找到第 index 帧实际的黑板。
  private blackboardAt(index: number) {
    for (let at = index; at >= 0; at--) if (this.ticks[at].bb) return this.ticks[at].bb;
    return JSON.parse(this.lastBlackboard || '[]');
  }

  recording(): BtRecording {
    return {
      version: 1,
      title: this.title,
      exportedAt: localTimeText(new Date()),
      trees: this.trees,
      ticks: this.ticks,
    };
  }

  // exportHtml 把整段录像存成一个能离线打开的 HTML 文件（浏览器下载）。
  async exportHtml() {
    const { recordingHtml } = await import('../btview/page');
    const recording = this.recording();
    const html = await recordingHtml(recording);
    const stamp = recording.exportedAt.replace(/[-: ]/g, '').slice(0, 14);
    const name = `${(this.title || 'bt').replace(/[\\/:*?"<>|#\s·]+/g, '_')}-${stamp}.html`;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // openLive 新开一个实时查看器窗口；窗口打开后会自己打招呼要全量数据。
  // 窗口要在点击的当下同步打开（否则会被拦截弹窗），页面准备好后再换过去。
  async openLive() {
    const popup = window.open('', 'btdemo-bt-live', 'width=1400,height=860');
    const { liveHtml } = await import('../btview/page');
    const url = URL.createObjectURL(new Blob([await liveHtml()], { type: 'text/html' }));
    if (popup) popup.location.href = url;
    else window.open(url, '_blank');
  }

  private post(message: LiveMsg) {
    this.channel?.postMessage(message);
  }
}
