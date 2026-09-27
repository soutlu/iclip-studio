import { describe, expect, it } from 'vitest'
import { formatDuration, formatRate, formatTimes, formatTokens } from './format'

describe('审计数字的人话', () => {
  it.each([
    { seconds: null, text: '—' },
    { seconds: 42, text: '42 秒' },
    { seconds: 1500, text: '25 分' },
    { seconds: 4800, text: '1.3 小时' },
    { seconds: 200_000, text: '2.3 天' },
  ])('$seconds 秒写成 $text', ({ seconds, text }) => {
    expect(formatDuration(seconds)).toBe(text)
  })

  it.each([
    { value: 950, text: '950' },
    { value: 12_345, text: '1.2 万' },
    { value: 2_500_000, text: '250 万' },
    { value: 340_000_000, text: '3.4 亿' },
  ])('$value token 写成 $text', ({ value, text }) => {
    expect(formatTokens(value)).toBe(text)
  })

  it('比率与次数保留一位小数，缺数据给横线', () => {
    expect(formatRate(0.625)).toBe('62.5%')
    expect(formatRate(null)).toBe('—')
    expect(formatTimes(1.4)).toBe('1.4 次')
    expect(formatTimes(null)).toBe('—')
  })
})
