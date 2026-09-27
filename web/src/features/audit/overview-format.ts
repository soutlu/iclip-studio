/** 总览的数字与日期写法：件数、token、时长、比率、片长，提示框里的具体日期与坐标刻度。

对话明细与异常两个页签还在用 format.ts 的旧写法，随它们下线再合并。 */

import type { OverviewBucket } from './audit.api'
import { EMPTY } from './format'

const WEEKDAYS = '日一二三四五六'

export const fmtCount = (value: number | null): string =>
  value === null ? EMPTY : Math.round(value).toLocaleString('zh-CN')

/** 一万起写「万」，一百万起取整万，一亿起写「亿」保留两位。 */
export const fmtTokens = (value: number | null): string => {
  if (value === null) return EMPTY
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`
  if (value >= 1e6) return `${Math.round(value / 1e4).toLocaleString('zh-CN')} 万`
  if (value >= 1e4) return `${Number((value / 1e4).toFixed(1))} 万`
  return fmtCount(value)
}

export const fmtRate = (ratio: number | null): string =>
  ratio === null ? EMPTY : `${Math.round(ratio * 100)}%`

/** 用时拆成数字与单位：一分钟内按秒，一小时内按分钟，两天内按小时，再长按天。 */
export const durationParts = (seconds: number | null): [string, string] => {
  if (seconds === null) return [EMPTY, '']
  if (seconds < 60) return [String(Math.round(seconds)), '秒']
  if (seconds < 3600) return [String(Math.round(seconds / 60)), '分钟']
  if (seconds < 48 * 3600) return [(seconds / 3600).toFixed(1), '小时']
  return [(seconds / 86_400).toFixed(1), '天']
}

const joinParts = ([value, unit]: [string, string]) => (unit === '' ? value : `${value} ${unit}`)

export const fmtDuration = (seconds: number | null): string => joinParts(durationParts(seconds))

/** 片长拆成数字与单位：一分钟内按秒，再长按分钟、小时。 */
export const lengthParts = (seconds: number | null): [string, string] => {
  if (seconds === null) return [EMPTY, '']
  if (seconds < 60) return [String(Math.round(seconds)), '秒']
  if (seconds < 3600) return [String(Number((seconds / 60).toFixed(1))), '分钟']
  return [String(Number((seconds / 3600).toFixed(1))), '小时']
}

export const fmtLength = (seconds: number | null): string => joinParts(lengthParts(seconds))

const startOfDay = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate())

export const monthDay = (at: Date): string => `${at.getMonth() + 1}月${at.getDate()}日`

const hourText = (at: Date) => `${String(at.getHours()).padStart(2, '0')}:00`

/** 时刻写成「9月27日 14:30」。 */
export const fmtMoment = (at: Date): string =>
  `${monthDay(at)} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`

/** [since, until) 写成日期区间：同一天只写一天，同月省掉第二个月份。 */
export const fmtDayRange = (since: Date, until: Date): string => {
  const last = startOfDay(new Date(until.getTime() - 1))
  if (startOfDay(since).getTime() === last.getTime()) return monthDay(since)
  if (since.getFullYear() === last.getFullYear() && since.getMonth() === last.getMonth()) {
    return `${monthDay(since)}–${last.getDate()}日`
  }
  return `${monthDay(since)}–${monthDay(last)}`
}

/** 提示框里这一期的名字：按小时写到整点，按天带星期，按周写实际覆盖的日期区间。 */
export const periodLabel = (
  start: Date,
  bucket: OverviewBucket,
  window: { since: Date; until: Date },
): string => {
  if (bucket === 'hour') return `${monthDay(start)} ${hourText(start)}`
  if (bucket === 'week') {
    const from = start < window.since ? window.since : start
    const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)
    return fmtDayRange(from, next > window.until ? window.until : next)
  }
  return `${monthDay(start)} 周${WEEKDAYS[start.getDay()] ?? ''}`
}

/** 横轴刻度：按小时零点与第一格写日期、其余写几时，按天与按周写「9/23」。 */
export const tickLabel = (start: Date, bucket: OverviewBucket, first: boolean): string => {
  const date = `${start.getMonth() + 1}/${start.getDate()}`
  if (bucket !== 'hour') return date
  return start.getHours() === 0 || first ? date : `${start.getHours()}时`
}

/** 横轴每隔几格标一个字：标签间距不小于 56px；按小时取 24 的约数，零点那格总会落上日期。 */
export const tickEvery = (bandWidth: number, bucket: OverviewBucket): number => {
  const every = Math.max(1, Math.ceil(56 / Math.max(bandWidth, 1)))
  if (bucket !== 'hour') return every
  return [1, 2, 3, 4, 6, 8, 12, 24].find((step) => step >= every) ?? 24 * Math.ceil(every / 24)
}

/** 纵轴四段左右的整齐刻度；integer 时步长至少为 1。 */
export const niceTicks = (low: number, high: number, count: number, integer: boolean): number[] => {
  const top = high <= low ? low + (integer ? 4 : 1) : high
  const raw = (top - low) / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  let step = [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((s) => s >= raw) ?? magnitude * 10
  if (integer) step = Math.max(1, Math.ceil(step))
  const start = Math.floor(low / step) * step
  const end = Math.ceil(top / step) * step
  const ticks: number[] = []
  for (let value = start; value <= end + step / 1e6; value += step) {
    ticks.push(Number(value.toFixed(6)))
  }
  return ticks
}

/** 比率纵轴固定四等分。 */
export const rateTicks = (): number[] => [0, 0.25, 0.5, 0.75, 1]

/** 用时刻度按整分钟、整小时、整天走。 */
export const durationTicks = (high: number): number[] => {
  const steps = [
    60, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400, 172_800, 259_200, 604_800,
  ]
  const step = steps.find((s) => high / s <= 4) ?? 604_800
  const ticks: number[] = []
  for (let value = 0; value < high + step; value += step) ticks.push(value)
  return ticks.length < 2 ? [0, step] : ticks
}

export const durationTickText = (seconds: number): string => {
  if (seconds === 0) return '0'
  if (seconds < 3600) return `${seconds / 60}分`
  if (seconds < 86_400) return `${Number((seconds / 3600).toFixed(1))}时`
  return `${Number((seconds / 86_400).toFixed(1))}天`
}

/** 片长纵轴整条用一个单位：顶格不过 10 分钟按秒，再多按整分钟切。 */
export const lengthTicks = (high: number): number[] =>
  high <= 600 ? niceTicks(0, high, 4, true) : niceTicks(0, high / 60, 4, true).map((v) => v * 60)

export const lengthTickText = (seconds: number, ticks: readonly number[]): string =>
  (ticks.at(-1) ?? 0) > 600 ? `${seconds / 60}分` : `${seconds}秒`

export const tokenTickText = (value: number): string => fmtTokens(value).replace(' ', '')

export const percentTickText = (value: number): string => `${Math.round(value * 100)}%`
