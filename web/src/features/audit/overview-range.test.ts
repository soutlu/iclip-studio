import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  overviewRangeFromSearch,
  overviewRangeLabel,
  overviewRangeSearchFields,
  overviewRangeToSearch,
  type OverviewRange,
} from './overview-range'

// 浏览器在纽约：日期仍按 UTC+8 写。
beforeAll(() => vi.stubEnv('TZ', 'America/New_York'))
afterAll(() => vi.unstubAllEnvs())

/** UTC+8 已是 9 月 15 日 01:00，纽约还是 14 日 13:00。 */
const NOW = new Date('2026-09-14T17:00:00Z')

describe('日期按钮', () => {
  it.each<{ range: OverviewRange; label: string }>([
    { range: { preset: 'today' }, label: '9月15日' },
    { range: { preset: '7d' }, label: '9月9日 – 9月15日' },
    { range: { preset: 'lastMonth' }, label: '8月1日 – 8月31日' },
    {
      range: { preset: 'custom', first: '2025-12-20', last: '2026-01-05' },
      label: '2025年12月20日 – 2026年1月5日',
    },
  ])('$range.preset 按 UTC+8 写成实际区间', ({ range, label }) => {
    expect(overviewRangeLabel(range, NOW)).toBe(label)
  })
})

describe('地址栏里的日期', () => {
  const search = z.object(overviewRangeSearchFields)

  it('不是真实日期的一端丢掉，退回缺省范围', () => {
    const parsed = search.parse({ period: 'custom', from: '2026-02-30', to: '2026-03-02' })
    expect(parsed.from).toBeUndefined()
    expect(overviewRangeFromSearch(parsed)).toEqual({ preset: '30d' })
  })
})

describe('查询串', () => {
  it('缺省的近 30 天不落地址栏，自定义带两端日期', () => {
    expect(overviewRangeToSearch({ preset: '30d' })).toEqual({ period: undefined })
    expect(
      overviewRangeToSearch({ preset: 'custom', first: '2026-09-01', last: '2026-09-07' }),
    ).toEqual({ from: '2026-09-01', period: 'custom', to: '2026-09-07' })
  })

  it.each([
    { search: { period: 'custom' as const, from: '2026-09-01' } },
    { search: { period: 'custom' as const, from: '2026-09-07', to: '2026-09-01' } },
  ])('自定义缺一端或两端颠倒就退回缺省范围', ({ search }) => {
    expect(overviewRangeFromSearch(search)).toEqual({ preset: '30d' })
  })
})
