// mediabunny 按轨道时间基换算浮点秒，需四舍五入至整数毫秒以消除浮点误差。
export const roundToMs = (seconds: number): number => Math.round(seconds * 1000) / 1000

export type SecondsRange = { start: number; end: number }
