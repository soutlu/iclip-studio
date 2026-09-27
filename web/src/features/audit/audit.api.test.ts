import { describe, expect, it } from 'vitest'
import {
  anomaliesSearchParams,
  conversationsSearchParams,
  DEFAULT_AUDIT_SCOPE,
  overviewSearchParams,
  type AuditScope,
} from './audit.api'
import type { OverviewRange } from './overview-range'

/** 2026 年 9 月 15 日（周二）本地 20:00。 */
const NOW = new Date(2026, 8, 15, 20, 0, 0)

const scopeOf = (patch: Partial<AuditScope>): AuditScope => ({ ...DEFAULT_AUDIT_SCOPE, ...patch })
const local = (month: number, day: number) => new Date(2026, month - 1, day).toISOString()

describe('总览查询串', () => {
  it.each<{ range: OverviewRange; since: string; until: string }>([
    { range: { preset: 'today' }, since: local(9, 15), until: NOW.toISOString() },
    { range: { preset: 'yesterday' }, since: local(9, 14), until: local(9, 15) },
    // 近 N 天含今天在内的 N 个日历日，从最早那天零点起，到此刻为止。
    { range: { preset: '7d' }, since: local(9, 9), until: NOW.toISOString() },
    { range: { preset: '30d' }, since: local(8, 17), until: NOW.toISOString() },
    { range: { preset: '90d' }, since: local(6, 18), until: NOW.toISOString() },
    { range: { preset: 'month' }, since: local(9, 1), until: NOW.toISOString() },
    { range: { preset: 'lastMonth' }, since: local(8, 1), until: local(9, 1) },
    // 自定义含结束日全天，截在次日零点。
    {
      range: { preset: 'custom', first: '2026-09-01', last: '2026-09-07' },
      since: local(9, 1),
      until: local(9, 8),
    },
  ])('$range.preset：本地零点切的时间窗', ({ range, since, until }) => {
    const params = overviewSearchParams(range, NOW, 'Asia/Singapore')
    expect(params.get('since')).toBe(since)
    expect(params.get('until')).toBe(until)
    expect(params.get('timezone')).toBe('Asia/Singapore')
  })
})

describe('明细与异常查询串', () => {
  it('对话明细带页长与游标', () => {
    const params = conversationsSearchParams(scopeOf({ range: 'all' }), 'cursor-1', NOW)
    expect(params.get('limit')).toBe('20')
    expect(params.get('cursor')).toBe('cursor-1')
  })

  it('异常把每个种类重复成一个 kind，不筛就不带', () => {
    const params = anomaliesSearchParams(scopeOf({ range: 'all' }), ['retry', 'idle'], null, NOW)
    expect(params.getAll('kind')).toEqual(['retry', 'idle'])
    expect(params.has('cursor')).toBe(false)
    expect(anomaliesSearchParams(scopeOf({}), null, null, NOW).has('kind')).toBe(false)
  })
})
