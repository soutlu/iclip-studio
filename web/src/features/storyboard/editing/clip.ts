// mediabunny 按各轨的时间基换算出浮点秒（0.99999…）；取整到毫秒后同一时刻处处相等。
export const roundToMs = (seconds: number): number => Math.round(seconds * 1000) / 1000

export type SecondsRange = { start: number; end: number }

export type Clip = SecondsRange & { sourceJobId: string }
