// 混音表：每个声音的音量和音高微调（1 = 不变），实时合成和烘焙好的素材都按这里播。
// 在 ?sfxlab 调音页里拖滑条调好后点"导出"，把 JSON 粘回这里。
// 名字和 recipes.ts 一样，可以写通配的名字（hit.*.*.heavy），按 fallbacks() 的顺序取第一个找得到的。

export interface MixEntry { gain?: number; pitch?: number }

export const MIX: Record<string, MixEntry> = {};
