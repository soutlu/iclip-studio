import { z } from 'zod'

const PRESET_DAYS = { '7d': 7, '30d': 30 } as const

type DateRangePresetDays = keyof typeof PRESET_DAYS

export const DATE_RANGE_DAY_PRESETS = Object.keys(PRESET_DAYS) as readonly DateRangePresetDays[]

const DATE_RANGE_PRESETS = [...DATE_RANGE_DAY_PRESETS, 'all', 'custom'] as const

export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number]

export const isDateRangeDayPreset = (value: string): value is DateRangePresetDays =>
  Object.hasOwn(PRESET_DAYS, value)

export interface DateRange {
  range: DateRangePreset
  since: string | null
  until: string | null
}

export const UNBOUNDED_RANGE: DateRange = { range: 'all', since: null, until: null }

export function dateRangePresetDays(range: DateRangePreset): number | null {
  return isDateRangeDayPreset(range) ? PRESET_DAYS[range] : null
}

const DAY_MS = 24 * 60 * 60_000

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function dateRangeBounds(
  value: DateRange,
  now: Date = new Date(),
): { since: Date | null; until: Date | null } {
  if (isDateRangeDayPreset(value.range)) {
    return { since: new Date(now.getTime() - PRESET_DAYS[value.range] * DAY_MS), until: null }
  }
  if (value.range === 'custom') {
    const since = value.since === null ? null : parseLocalDate(value.since)
    const until = value.until === null ? null : parseLocalDate(value.until)
    if (until !== null) until.setDate(until.getDate() + 1)
    return { since, until }
  }
  return { since: null, until: null }
}

export function parseLocalDate(date: string): Date | null {
  const match = LOCAL_DATE.exec(date)
  if (match === null) return null

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const value = new Date(0)
  value.setHours(0, 0, 0, 0)
  // Date(year, month, day) 会将 0–99 年映射为 1900–1999 年，需通过 setFullYear 设置真实年份。
  value.setFullYear(year, month - 1, day)
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day) {
    return null
  }
  return value
}

export function formatLocalDate(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

export function dateRangeLabel(value: DateRange): string {
  if (value.range === 'all') return '时间'
  if (isDateRangeDayPreset(value.range)) return `近 ${PRESET_DAYS[value.range]} 天`

  const since = value.since === null ? null : parseLocalDate(value.since)
  const until = value.until === null ? null : parseLocalDate(value.until)
  if (since === null || until === null) return '自定义'

  const currentYear = new Date().getFullYear()
  const includeYear = since.getFullYear() !== currentYear || until.getFullYear() !== currentYear
  const format = (date: Date) =>
    `${includeYear ? `${date.getFullYear()}年` : ''}${date.getMonth() + 1}月${date.getDate()}日`
  return since.getTime() === until.getTime() ? format(since) : `${format(since)} — ${format(until)}`
}

export const dateRangeSearchFields = {
  range: z.enum(DATE_RANGE_PRESETS).optional().catch(undefined),
  since: z.string().regex(LOCAL_DATE).optional().catch(undefined),
  until: z.string().regex(LOCAL_DATE).optional().catch(undefined),
}

export type DateRangeSearch = {
  range?: DateRangePreset | undefined
  since?: string | undefined
  until?: string | undefined
}

export function dateRangeFromSearch(search: DateRangeSearch, fallback: DateRange): DateRange {
  const custom =
    search.range === 'custom' && search.since !== undefined && search.until !== undefined
  const range = search.range === 'custom' && !custom ? undefined : search.range
  return {
    range: range ?? fallback.range,
    since: custom ? (search.since ?? null) : null,
    until: custom ? (search.until ?? null) : null,
  }
}

export function dateRangeToSearch(value: DateRange, fallback: DateRange): DateRangeSearch {
  const custom = value.range === 'custom'
  return {
    range: value.range === fallback.range ? undefined : value.range,
    since: custom ? (value.since ?? undefined) : undefined,
    until: custom ? (value.until ?? undefined) : undefined,
  }
}
