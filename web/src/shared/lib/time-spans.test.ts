import { describe, expect, it } from 'vitest'
import { mergeSpans, sameSpans, windowSpans } from './time-spans'

describe('windowSpans', () => {
  it('只留落在片段里的部分，并换算到片段在时间线上的位置', () => {
    const buffered = [
      { start: 0, end: 3 },
      { start: 5, end: 9 },
    ]
    expect(windowSpans(buffered, 2, 6, 10)).toEqual([
      { start: 10, end: 11 },
      { start: 13, end: 14 },
    ])
  })

  it('和片段不相交的缓冲段不出现', () => {
    expect(windowSpans([{ start: 0, end: 2 }], 2, 6, 0)).toEqual([])
    expect(windowSpans([{ start: 7, end: 9 }], 2, 6, 0)).toEqual([])
  })
})

describe('mergeSpans', () => {
  it('按开始时间排序，首尾相接或重叠的并成一段，隔开的保持分开', () => {
    expect(
      mergeSpans([
        { start: 4, end: 6 },
        { start: 0, end: 2 },
        { start: 2.03, end: 3 },
        { start: 5, end: 5.5 },
      ]),
    ).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 6 },
    ])
  })

  it('不改动传入的区间', () => {
    const spans = [
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]
    mergeSpans(spans)
    expect(spans).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ])
  })
})

describe('sameSpans', () => {
  it('段数和每段的起止都一样才算相同', () => {
    expect(sameSpans([{ start: 0, end: 1 }], [{ start: 0, end: 1 }])).toBe(true)
    expect(sameSpans([{ start: 0, end: 1 }], [{ start: 0, end: 1.5 }])).toBe(false)
    expect(sameSpans([{ start: 0, end: 1 }], [])).toBe(false)
  })
})
