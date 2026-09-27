import { describe, expect, it } from 'vitest'
import { groupByRecency, recencyBucket, type RecencyBucket } from './recency-group'

const iso = (...parts: [number, number, number, number?, number?]) => {
  const [year, month, day, hour = 0, minute = 0] = parts
  return new Date(year, month, day, hour, minute).toISOString()
}

describe('recencyBucket', () => {
  const now = new Date(2026, 8, 27, 15, 30)

  it.each<[string, string, RecencyBucket]>([
    ['今天 00:00', iso(2026, 8, 27, 0, 0), 'today'],
    ['此刻', now.toISOString(), 'today'],
    ['比此刻晚（时钟偏差）', iso(2026, 8, 28, 0, 30), 'today'],
    ['昨天 23:59', iso(2026, 8, 26, 23, 59), 'yesterday'],
    ['昨天 00:00', iso(2026, 8, 26, 0, 0), 'yesterday'],
    ['前天', iso(2026, 8, 25, 12, 0), 'week'],
    ['第 6 天 00:00', iso(2026, 8, 21, 0, 0), 'week'],
    ['第 7 天 23:59', iso(2026, 8, 20, 23, 59), 'earlier'],
    ['一年前', iso(2025, 8, 27, 15, 30), 'earlier'],
  ])('%s 归入 %s', (_, at, bucket) => {
    expect(recencyBucket(at, now)).toBe(bucket)
  })

  it.each<[string, string, RecencyBucket]>([
    ['上月最后一天是昨天', iso(2026, 8, 30, 22, 0), 'yesterday'],
    ['上月倒数第 6 天仍在 7 天内', iso(2026, 8, 25, 9, 0), 'week'],
    ['上月倒数第 7 天算更早', iso(2026, 8, 24, 23, 59), 'earlier'],
  ])('跨月按日历日数：%s', (_, at, bucket) => {
    expect(recencyBucket(at, new Date(2026, 9, 1, 8, 0))).toBe(bucket)
  })

  it('无效时刻算更早', () => {
    expect(recencyBucket('not-a-date', now)).toBe('earlier')
  })
})

describe('groupByRecency', () => {
  const now = new Date(2026, 8, 27, 15, 30)
  const rows = [
    { id: 'a', at: iso(2026, 8, 27, 14, 0) },
    { id: 'b', at: iso(2026, 8, 27, 9, 0) },
    { id: 'c', at: iso(2026, 8, 26, 20, 0) },
    { id: 'd', at: iso(2026, 8, 10, 8, 0) },
    { id: 'e', at: iso(2026, 7, 1, 8, 0) },
  ]

  it('按原顺序切段，空组不出现', () => {
    const groups = groupByRecency(rows, (row) => row.at, now)

    expect(groups.map(({ bucket, items }) => [bucket, items.map((row) => row.id)])).toEqual([
      ['today', ['a', 'b']],
      ['yesterday', ['c']],
      ['earlier', ['d', 'e']],
    ])
  })

  it('不重排条目：拼接各段等于原列表', () => {
    const groups = groupByRecency(rows, (row) => row.at, now)

    expect(groups.flatMap((group) => group.items)).toEqual(rows)
  })

  it('空列表没有分组', () => {
    expect(groupByRecency([], (row: { at: string }) => row.at, now)).toEqual([])
  })
})
