import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { overviewSearchParams } from './audit.api'
import type { OverviewRange } from './overview-range'

// 浏览器在纽约：时间窗仍按 UTC+8 的零点切，不跟浏览器时区。
beforeAll(() => vi.stubEnv('TZ', 'America/New_York'))
afterAll(() => vi.unstubAllEnvs())

/** UTC+8 已是 9 月 15 日（周二）01:00，纽约还是 14 日 13:00。 */
const NOW = new Date('2026-09-14T17:00:00Z')

/** 2026 年某日 UTC+8 零点。 */
const utc8 = (month: number, day: number) =>
  new Date(
    `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00+08:00`,
  ).toISOString()

describe('总览查询串', () => {
  it.each<{ range: OverviewRange; since: string; until: string }>([
    { range: { preset: 'today' }, since: utc8(9, 15), until: NOW.toISOString() },
    { range: { preset: 'yesterday' }, since: utc8(9, 14), until: utc8(9, 15) },
    // 近 N 天含今天在内的 N 个日历日，从最早那天零点起，到此刻为止。
    { range: { preset: '7d' }, since: utc8(9, 9), until: NOW.toISOString() },
    { range: { preset: '30d' }, since: utc8(8, 17), until: NOW.toISOString() },
    { range: { preset: '90d' }, since: utc8(6, 18), until: NOW.toISOString() },
    { range: { preset: 'month' }, since: utc8(9, 1), until: NOW.toISOString() },
    { range: { preset: 'lastMonth' }, since: utc8(8, 1), until: utc8(9, 1) },
    // 自定义含结束日全天，截在次日零点。
    {
      range: { preset: 'custom', first: '2026-09-01', last: '2026-09-07' },
      since: utc8(9, 1),
      until: utc8(9, 8),
    },
  ])('$range.preset：按 UTC+8 零点切的时间窗，时区固定', ({ range, since, until }) => {
    const params = overviewSearchParams(range, NOW)
    expect(params.get('since')).toBe(since)
    expect(params.get('until')).toBe(until)
    expect(params.get('timezone')).toBe('Asia/Singapore')
  })

  it('UTC+8 跨进新月份时，本月从新月 1 日零点算起', () => {
    // UTC+8 已是 9 月 1 日 01:00，纽约还在 8 月 31 日。
    const params = overviewSearchParams({ preset: 'month' }, new Date('2026-08-31T17:00:00Z'))
    expect(params.get('since')).toBe(utc8(9, 1))
  })
})
