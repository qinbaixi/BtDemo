// 设置面板：HUD 上的“设置”按钮或 Esc 键开关，面板里 Esc 也能关。
// 每个控件一改就立刻生效：总音量、静音走 audio/engine.ts，其余走 game/settings.ts（会存下来）。
// 静音还能按 M 键切换，所以面板每次打开、M 键切换之后都要重新读一遍。

import { getVolume, isMuted, setVolume, toggleMute } from '../audio/engine';
import { onSettings, resetSettings, SETTINGS, updateSettings, type Settings } from '../game/settings';

// 滑条的读写方式：总音量存在 engine 里，其余存在 settings 里
interface SliderSpec {
  key: string;
  label: string;
  read(): number;
  write(value: number): void;
}

// 开关项的键，对应 Settings 里的布尔字段
type FlagKey = 'flash' | 'rumble' | 'slowmo';

interface FlagSpec {
  key: FlagKey;
  label: string;
}

// 滑条按面板上的顺序排，第一条是总音量（静音开关紧跟在它下面）
const SLIDERS: SliderSpec[] = [
  { key: 'volume', label: '总音量', read: getVolume, write: setVolume },
  { key: 'sfx', label: '音效', read: () => SETTINGS.sfx, write: (value) => updateSettings({ sfx: value }) },
  { key: 'ambience', label: '环境声', read: () => SETTINGS.ambience, write: (value) => updateSettings({ ambience: value }) },
  { key: 'shake', label: '震屏强度', read: () => SETTINGS.shake, write: (value) => updateSettings({ shake: value }) },
];

const FLAGS: FlagSpec[] = [
  { key: 'flash', label: '受击闪白' },
  { key: 'rumble', label: '手柄 / 手机震动' },
  { key: 'slowmo', label: '清场慢放' },
];

let root: HTMLElement;
let open = false;   // 面板开着没有（state 里没有这个标记，这里自己记）

// initSettingsPanel 建好面板（隐藏着），接上设置按钮和各个控件。
export function initSettingsPanel(): void {
  root = document.getElementById('settings')!;
  root.innerHTML = buildPanelHtml();
  bindSliders();
  bindFlags();
  bindMute();
  root.querySelector('.settings-close')!.addEventListener('click', () => closeSettings());
  root.querySelector('.settings-reset')!.addEventListener('click', () => resetAllSettings());
  // 焦点在滑条上时，全局键盘处理会跳过，所以面板自己接 Esc；停止冒泡，免得全局再开一次
  root.addEventListener('keydown', (event) => {
    if (event.code !== 'Escape') return;
    event.stopPropagation();
    closeSettings();
  });
  // 面板上的点击不要传到画布
  root.addEventListener('pointerdown', (event) => event.stopPropagation());
  const btn = document.getElementById('settings-btn');
  btn?.addEventListener('pointerdown', (event) => event.stopPropagation());
  btn?.addEventListener('click', () => toggleSettings());
  // 任何设置变化（包括恢复默认）都刷新面板；面板关着时什么也不做
  onSettings(() => refreshSettingsPanel());
}

// toggleSettings 开关设置面板（设置按钮、Esc 键）。
export function toggleSettings(): void {
  if (open) closeSettings();
  else openSettings();
}

// refreshSettingsPanel 按当前设置重画所有控件（M 键切换静音之后调用）。面板关着时什么也不做。
export function refreshSettingsPanel(): void {
  if (!root || !open) return;
  refreshSliders();
  refreshFlags();
  refreshMute();
}

function openSettings(): void {
  if (!root) return;
  open = true;
  root.classList.remove('hidden');
  refreshSettingsPanel();
}

// closeSettingsPanel 关掉设置面板（打开装备、线路面板前调用，同时只开一个）。
export function closeSettingsPanel(): void {
  closeSettings();
}

function closeSettings(): void {
  if (!root) return;
  open = false;
  root.classList.add('hidden');
}

function resetAllSettings(): void {
  resetSettings();
  refreshSettingsPanel();
}

function buildPanelHtml(): string {
  const [volumeSpec, ...otherSliders] = SLIDERS;
  return `
    <div class="bag-panel panel settings-panel">
      <div class="picker-head"><span class="picker-title">设置</span><button type="button" class="bag-close settings-close" title="关闭（Esc）">×</button></div>
      <div class="settings-rows">
        ${sliderRowHtml(volumeSpec)}
        <label class="settings-row settings-toggle"><span class="settings-name">静音</span><input type="checkbox" data-mute></label>
        ${otherSliders.map(sliderRowHtml).join('')}
        ${FLAGS.map(flagRowHtml).join('')}
      </div>
      <div class="settings-note">系统开了“减少动态效果”时，默认减弱震屏、关闭闪白和慢放。</div>
      <div class="settings-foot"><button type="button" class="settings-reset">恢复默认</button></div>
    </div>`;
}

function sliderRowHtml(spec: SliderSpec): string {
  return `<label class="settings-row"><span class="settings-name">${spec.label}</span>`
    + `<input type="range" min="0" max="1" step="0.05" data-slider="${spec.key}">`
    + `<span class="settings-value" data-value="${spec.key}"></span></label>`;
}

function flagRowHtml(spec: FlagSpec): string {
  return `<label class="settings-row settings-toggle"><span class="settings-name">${spec.label}</span>`
    + `<input type="checkbox" data-flag="${spec.key}"></label>`;
}

function sliderInput(key: string): HTMLInputElement {
  return root.querySelector<HTMLInputElement>(`input[data-slider="${key}"]`)!;
}

function sliderValueText(key: string): HTMLElement {
  return root.querySelector<HTMLElement>(`[data-value="${key}"]`)!;
}

function flagBox(key: FlagKey): HTMLInputElement {
  return root.querySelector<HTMLInputElement>(`input[data-flag="${key}"]`)!;
}

function muteBox(): HTMLInputElement {
  return root.querySelector<HTMLInputElement>('input[data-mute]')!;
}

function bindSliders(): void {
  for (const spec of SLIDERS) {
    const input = sliderInput(spec.key);
    input.addEventListener('input', () => {
      spec.write(Number(input.value));
      refreshSliderRow(spec);   // 总音量不走 onSettings，这里自己更新数字
    });
  }
}

function bindFlags(): void {
  for (const spec of FLAGS) {
    const box = flagBox(spec.key);
    box.addEventListener('change', () => updateSettings({ [spec.key]: box.checked } as Partial<Settings>));
  }
}

function bindMute(): void {
  muteBox().addEventListener('change', () => {
    toggleMute();
    refreshMute();   // 切换后以引擎里的真实状态为准
  });
}

function refreshSliders(): void {
  for (const spec of SLIDERS) refreshSliderRow(spec);
}

function refreshSliderRow(spec: SliderSpec): void {
  const value = spec.read();
  sliderInput(spec.key).value = String(value);
  sliderValueText(spec.key).textContent = percentText(value);
}

function refreshFlags(): void {
  for (const spec of FLAGS) flagBox(spec.key).checked = SETTINGS[spec.key] as boolean;
}

function refreshMute(): void {
  muteBox().checked = isMuted();
}

function percentText(value: number): string {
  return `${Math.round(value * 100)}%`;
}
