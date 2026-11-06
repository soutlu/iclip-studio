import { z } from 'zod'
import {
  addDays,
  formatZonedDate,
  parseZonedDate,
  startOfZonedDay,
  startOfZonedMonth,
  zonedParts,
} from './audit-time'

export const OVERVIEW_PRESETS = [
  'today',
  'yesterday',
  '7d',
  '30d',
  'month',
  'lastMonth',
  '90d',
] as const

export type OverviewPreset = (typeof OVERVIEW_PRESETS)[number]

export type OverviewRange =
  { preset: OverviewPreset } | { preset: 'custom'; first: string; last: string }

export const DEFAULT_OVERVIEW_RANGE: OverviewRange = { preset: '30d' }

export const PRESET_LABELS: Record<OverviewPreset, string> = {
  today: '今天',
  yesterday: '昨天',
  '7d': '近 7 天',
  '30d': '近 30 天',
  month: '本月',
  lastMonth: '上月',
  '90d': '近 90 天',
}

export const QUICK_PRESETS: readonly { preset: OverviewPreset; label: string }[] = [
  { preset: 'today', label: '今天' },
  { preset: '7d', label: '7 天' },
  { preset: '30d', label: '30 天' },
  { preset: '90d', label: '90 天' },
]

const LAST_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const

export function overviewWindow(range: OverviewRange, now: Date): { since: Date; until: Date } {
  const today = startOfZonedDay(now)
  switch (range.preset) {
    case 'today':
      return { since: today, until: now }
    case 'yesterday':
      return { since: addDays(today, -1), until: today }
    case '7d':
    case '30d':
    case '90d':
      return { since: addDays(today, 1 - LAST_DAYS[range.preset]), until: now }
    case 'month':
      return { since: startOfZonedMonth(now), until: now }
    case 'lastMonth':
      return { since: startOfZonedMonth(now, -1), until: startOfZonedMonth(now) }
    case 'custom': {
      const first = parseZonedDate(range.first) ?? today
      const last = parseZonedDate(range.last) ?? today
      return { since: first, until: addDays(last, 1) }
    }
  }
}

export function overviewDays(range: OverviewRange, now: Date): { first: Date; last: Date } {
  const { since, until } = overviewWindow(range, now)
  return { first: startOfZonedDay(since), last: startOfZonedDay(new Date(until.getTime() - 1)) }
}

const monthDay = (at: Date, withYear: boolean) => {
  const { year, month, day } = zonedParts(at)
  return `${withYear ? `${year}年` : ''}${month}月${day}日`
}

export function overviewRangeLabel(range: OverviewRange, now: Date): string {
  const { first, last } = overviewDays(range, now)
  const thisYear = zonedParts(now).year
  const withYear = zonedParts(first).year !== thisYear || zonedParts(last).year !== thisYear
  if (first.getTime() === last.getTime()) return monthDay(first, withYear)
  return `${monthDay(first, withYear)} – ${monthDay(last, withYear)}`
}

export function customRange(a: Date, b: Date): OverviewRange {
  const [first, last] = a.getTime() <= b.getTime() ? [a, b] : [b, a]
  return { preset: 'custom', first: formatZonedDate(first), last: formatZonedDate(last) }
}

const dateField = z
  .string()
  .refine((value) => parseZonedDate(value) !== null)
  .optional()
  .catch(undefined)

export const overviewRangeSearchFields = {
  period: z
    .enum([...OVERVIEW_PRESETS, 'custom'])
    .optional()
    .catch(undefined),
  from: dateField,
  to: dateField,
}

export type OverviewRangeSearch = {
  period?: OverviewPreset | 'custom' | undefined
  from?: string | undefined
  to?: string | undefined
}

export function overviewRangeFromSearch(search: OverviewRangeSearch): OverviewRange {
  if (search.period === 'custom') {
    const { from, to } = search
    if (from === undefined || to === undefined || from > to) return DEFAULT_OVERVIEW_RANGE
    return { preset: 'custom', first: from, last: to }
  }
  return search.period === undefined ? DEFAULT_OVERVIEW_RANGE : { preset: search.period }
}

export function overviewRangeToSearch(range: OverviewRange): OverviewRangeSearch {
  if (range.preset === 'custom') return { period: 'custom', from: range.first, to: range.last }
  return { period: range.preset === DEFAULT_OVERVIEW_RANGE.preset ? undefined : range.preset }
}
