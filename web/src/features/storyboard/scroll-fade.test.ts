import { describe, expect, it } from 'vitest'
import { scrollFadeOf } from './scroll-fade'

describe('scrollFadeOf', () => {
  it.each([
    { expected: 'none', scrollLeft: 0, scrollWidth: 300, when: '放得下' },
    { expected: 'none', scrollLeft: 0, scrollWidth: 300.5, when: '只多出不到 1px 的小数宽度' },
    { expected: 'end', scrollLeft: 0, scrollWidth: 600, when: '在最左、右边还有' },
    { expected: 'both', scrollLeft: 120, scrollWidth: 600, when: '滚到中间' },
    { expected: 'start', scrollLeft: 300, scrollWidth: 600, when: '滚到最右' },
  ] as const)('$when：$expected', ({ expected, scrollLeft, scrollWidth }) => {
    expect(scrollFadeOf({ clientWidth: 300, scrollLeft, scrollWidth })).toBe(expected)
  })
})
