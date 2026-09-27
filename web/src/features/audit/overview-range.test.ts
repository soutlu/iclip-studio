import { describe, expect, it } from 'vitest'
import {
  overviewRangeFromSearch,
  overviewRangeLabel,
  overviewRangeToSearch,
  type OverviewRange,
} from './overview-range'

const NOW = new Date(2026, 8, 15, 20, 0, 0)

describe('日期按钮', () => {
  it.each<{ range: OverviewRange; label: string }>([
    { range: { preset: 'today' }, label: '9月15日' },
    { range: { preset: '7d' }, label: '9月9日 – 9月15日' },
    { range: { preset: 'lastMonth' }, label: '8月1日 – 8月31日' },
    {
      range: { preset: 'custom', first: '2025-12-20', last: '2026-01-05' },
      label: '2025年12月20日 – 2026年1月5日',
    },
  ])('$range.preset 写成实际区间', ({ range, label }) => {
    expect(overviewRangeLabel(range, NOW)).toBe(label)
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
