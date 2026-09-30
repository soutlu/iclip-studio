import { describe, expect, it } from 'vitest'
import { formatDateTime, formatShortTime } from './date-time'

describe('formatDateTime', () => {
  it('月日与时分都补足两位', () => {
    // 使用本地日期构造，避免测试结果依赖机器时区。
    const at = new Date(2026, 8, 3, 9, 5)
    expect(formatDateTime(at.toISOString())).toBe('2026-09-03 09:05')
  })

  it('解析不出来就给空串，不画一个 NaN 出来', () => {
    expect(formatDateTime('前天下午')).toBe('')
  })
})

describe('formatShortTime', () => {
  // 本地时刻构造，结果不随机器时区变。
  const now = new Date(2026, 8, 29, 9, 0)
  const at = (...parts: [number, number, number, number, number]) =>
    new Date(...parts).toISOString()

  it.each([
    { expected: '13:05', iso: at(2026, 8, 29, 13, 5), when: '今天（比 now 还晚也算今天）' },
    { expected: '00:07', iso: at(2026, 8, 29, 0, 7), when: '今天凌晨' },
    { expected: '昨天 17:30', iso: at(2026, 8, 28, 17, 30), when: '昨天' },
    { expected: '昨天 00:00', iso: at(2026, 8, 28, 0, 0), when: '昨天零点' },
    { expected: '9月27日', iso: at(2026, 8, 27, 23, 59), when: '前天' },
    { expected: '12月31日', iso: at(2025, 11, 31, 8, 0), when: '去年' },
  ])('$when 写成 $expected', ({ expected, iso }) => {
    expect(formatShortTime(iso, now)).toBe(expected)
  })

  it('解析不出来就给空串', () => {
    expect(formatShortTime('刚才', now)).toBe('')
  })
})
