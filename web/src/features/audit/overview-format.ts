import type { OverviewBucket } from './audit.api'
import { addDays, zonedParts } from './audit-time'

export const EMPTY = '—'

const WEEKDAYS = '日一二三四五六'

export const fmtCount = (value: number | null): string =>
  value === null ? EMPTY : Math.round(value).toLocaleString('zh-CN')

export const fmtTokens = (value: number | null): string => {
  if (value === null) return EMPTY
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`
  if (value >= 1e6) return `${Math.round(value / 1e4).toLocaleString('zh-CN')} 万`
  if (value >= 1e4) return `${Number((value / 1e4).toFixed(1))} 万`
  return fmtCount(value)
}

export const fmtRate = (ratio: number | null): string =>
  ratio === null ? EMPTY : `${Math.round(ratio * 100)}%`

export const durationParts = (seconds: number | null): [string, string] => {
  if (seconds === null) return [EMPTY, '']
  if (seconds < 60) return [String(Math.round(seconds)), '秒']
  if (seconds < 3600) return [String(Math.round(seconds / 60)), '分钟']
  if (seconds < 48 * 3600) return [(seconds / 3600).toFixed(1), '小时']
  return [(seconds / 86_400).toFixed(1), '天']
}

const joinParts = ([value, unit]: [string, string]) => (unit === '' ? value : `${value} ${unit}`)

export const fmtDuration = (seconds: number | null): string => joinParts(durationParts(seconds))

export const lengthParts = (seconds: number | null): [string, string] => {
  if (seconds === null) return [EMPTY, '']
  if (seconds < 60) return [String(Math.round(seconds)), '秒']
  if (seconds < 3600) return [String(Number((seconds / 60).toFixed(1))), '分钟']
  return [String(Number((seconds / 3600).toFixed(1))), '小时']
}

export const fmtLength = (seconds: number | null): string => joinParts(lengthParts(seconds))

const pad2 = (value: number) => String(value).padStart(2, '0')

export const monthDay = (at: Date): string => {
  const { month, day } = zonedParts(at)
  return `${month}月${day}日`
}

export const fmtMoment = (at: Date): string => {
  const { hour, minute } = zonedParts(at)
  return `${monthDay(at)} ${pad2(hour)}:${pad2(minute)}`
}

export const fmtDayRange = (since: Date, until: Date): string => {
  const last = new Date(until.getTime() - 1)
  const from = zonedParts(since)
  const to = zonedParts(last)
  if (from.year !== to.year || from.month !== to.month)
    return `${monthDay(since)}–${monthDay(last)}`
  return from.day === to.day ? monthDay(since) : `${monthDay(since)}–${to.day}日`
}

export const periodLabel = (
  start: Date,
  bucket: OverviewBucket,
  window: { since: Date; until: Date },
): string => {
  if (bucket === 'hour') return `${monthDay(start)} ${pad2(zonedParts(start).hour)}:00`
  if (bucket === 'week') {
    const from = start < window.since ? window.since : start
    const next = addDays(start, 7)
    return fmtDayRange(from, next > window.until ? window.until : next)
  }
  return `${monthDay(start)} 周${WEEKDAYS[zonedParts(start).weekday] ?? ''}`
}

export const tickLabel = (start: Date, bucket: OverviewBucket, first: boolean): string => {
  const { month, day, hour } = zonedParts(start)
  const date = `${month}/${day}`
  if (bucket !== 'hour') return date
  return hour === 0 || first ? date : `${hour}时`
}

export const tickEvery = (bandWidth: number, bucket: OverviewBucket): number => {
  const every = Math.max(1, Math.ceil(56 / Math.max(bandWidth, 1)))
  if (bucket !== 'hour') return every
  return [1, 2, 3, 4, 6, 8, 12, 24].find((step) => step >= every) ?? 24 * Math.ceil(every / 24)
}

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

export const rateTicks = (): number[] => [0, 0.25, 0.5, 0.75, 1]

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

export const lengthTicks = (high: number): number[] =>
  high <= 600 ? niceTicks(0, high, 4, true) : niceTicks(0, high / 60, 4, true).map((v) => v * 60)

export const lengthTickText = (seconds: number, ticks: readonly number[]): string =>
  (ticks.at(-1) ?? 0) > 600 ? `${seconds / 60}分` : `${seconds}秒`

export const tokenTickText = (value: number): string => fmtTokens(value).replace(' ', '')

export const percentTickText = (value: number): string => `${Math.round(value * 100)}%`
