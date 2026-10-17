import { describe, expect, it } from 'vitest'
import { layoutPlay, locateClock, totalDuration } from './play-layout'

describe('layoutPlay', () => {
  it('按顺序排上时钟，零长的段不占时钟', () => {
    const laid = layoutPlay([
      { mediaUrl: 'a', start: 1, end: 3 },
      { mediaUrl: 'b', start: 2, end: 2 },
      { mediaUrl: 'b', start: 0, end: 1.5 },
    ])
    expect(laid).toEqual([
      { mediaUrl: 'a', start: 1, end: 3, at: 0, duration: 2 },
      { mediaUrl: 'b', start: 0, end: 1.5, at: 2, duration: 1.5 },
    ])
    expect(totalDuration(laid)).toBe(3.5)
  })
})

describe('locateClock', () => {
  const laid = layoutPlay([
    { mediaUrl: 'a', start: 0, end: 2 },
    { mediaUrl: 'b', start: 0, end: 3 },
  ])

  it.each([
    [0, { index: 0, offset: 0 }],
    [1.5, { index: 0, offset: 1.5 }],
    [2, { index: 1, offset: 0 }],
    [4.5, { index: 1, offset: 2.5 }],
    [5, { index: 1, offset: 3 }],
    [99, { index: 1, offset: 3 }],
    [-1, { index: 0, offset: 0 }],
  ])('%s 秒落在 %j', (clock, expected) => {
    expect(locateClock(laid, clock)).toEqual(expected)
  })

  it('没有段就没有位置', () => {
    expect(locateClock([], 1)).toBeUndefined()
  })
})
