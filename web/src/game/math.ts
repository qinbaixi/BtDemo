// 通用的小数学函数。

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const hypot = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(bx - ax, by - ay);

// fmt 把数值格式化成整数或一位小数，非数值显示 -。
export function fmt(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-';
  const r = Math.round(v);
  return Math.abs(v - r) < 0.05 ? String(r) : v.toFixed(1);
}
