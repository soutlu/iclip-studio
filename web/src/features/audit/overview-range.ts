/** 总览的时间范围：快捷档、日历预设与自定义区间，换算成请求的时间窗、日期按钮上的字与查询串。 */

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

/** 预设按此刻现算；自定义是两个 UTC+8 日期，两端都含。 */
export type OverviewRange =
  { preset: OverviewPreset } | { preset: 'custom'; first: string; last: string }

export const DEFAULT_OVERVIEW_RANGE: OverviewRange = { preset: '30d' }

/** 日历左侧预设的全名，按原型顺序。 */
export const PRESET_LABELS: Record<OverviewPreset, string> = {
  today: '今天',
  yesterday: '昨天',
  '7d': '近 7 天',
  '30d': '近 30 天',
  month: '本月',
  lastMonth: '上月',
  '90d': '近 90 天',
}

/** 工具条上的快捷档与短名；其余预设只在日历弹层里。 */
export const QUICK_PRESETS: readonly { preset: OverviewPreset; label: string }[] = [
  { preset: 'today', label: '今天' },
  { preset: '7d', label: '7 天' },
  { preset: '30d', label: '30 天' },
  { preset: '90d', label: '90 天' },
]

const LAST_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const

/**
 * 请求的时间窗 [since, until)，按 UTC+8 的零点切，与浏览器所在时区无关。
 * 今天、近 N 天与本月到此刻为止；昨天、上月与自定义截在结束日次日零点，晚于此刻的由服务端按此刻算。
 */
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

/** 时间窗覆盖的首尾两天，各取 UTC+8 零点，日历高亮与日期按钮用。 */
export function overviewDays(range: OverviewRange, now: Date): { first: Date; last: Date } {
  const { since, until } = overviewWindow(range, now)
  return { first: startOfZonedDay(since), last: startOfZonedDay(new Date(until.getTime() - 1)) }
}

const monthDay = (at: Date, withYear: boolean) => {
  const { year, month, day } = zonedParts(at)
  return `${withYear ? `${year}年` : ''}${month}月${day}日`
}

/** 日期按钮常显实际区间：同一天只写一天；不在今年的日期带上年份。 */
export function overviewRangeLabel(range: OverviewRange, now: Date): string {
  const { first, last } = overviewDays(range, now)
  const thisYear = zonedParts(now).year
  const withYear = zonedParts(first).year !== thisYear || zonedParts(last).year !== thisYear
  if (first.getTime() === last.getTime()) return monthDay(first, withYear)
  return `${monthDay(first, withYear)} – ${monthDay(last, withYear)}`
}

/** 两天（各为 UTC+8 零点）拼成自定义范围，先后顺序不论。 */
export function customRange(a: Date, b: Date): OverviewRange {
  const [first, last] = a.getTime() <= b.getTime() ? [a, b] : [b, a]
  return { preset: 'custom', first: formatZonedDate(first), last: formatZonedDate(last) }
}

const dateField = z
  .string()
  .refine((value) => parseZonedDate(value) !== null)
  .optional()
  .catch(undefined)

/** 总览时间范围在查询串里的三个字段，拼进审计页的 search schema。 */
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

/** 自定义缺一端或两端颠倒的链接退回缺省范围，免得日期按钮写着一段、实际查的是另一段。 */
export function overviewRangeFromSearch(search: OverviewRangeSearch): OverviewRange {
  if (search.period === 'custom') {
    const { from, to } = search
    if (from === undefined || to === undefined || from > to) return DEFAULT_OVERVIEW_RANGE
    return { preset: 'custom', first: from, last: to }
  }
  return search.period === undefined ? DEFAULT_OVERVIEW_RANGE : { preset: search.period }
}

/** 缺省范围不落地址栏；预设不留日期。 */
export function overviewRangeToSearch(range: OverviewRange): OverviewRangeSearch {
  if (range.preset === 'custom') return { period: 'custom', from: range.first, to: range.last }
  return { period: range.preset === DEFAULT_OVERVIEW_RANGE.preset ? undefined : range.preset }
}
