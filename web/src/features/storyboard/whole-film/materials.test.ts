import { describe, expect, it } from 'vitest'
import { card, video } from '@/testing/whole-film'
import { shotAt, trimRange, usedSpans, type MaterialRange } from './materials'

const range = (startMs: number, endMs: number): MaterialRange => ({
  jobId: 'job',
  takeId: 'take',
  startMs,
  endMs,
})

describe('trimRange：挪选区的一端', () => {
  it('只挪这一端，另一端不动', () => {
    expect(trimRange(range(1_000, 3_000), 'start', 500, 6_000)).toEqual(range(1_500, 3_000))
    expect(trimRange(range(1_000, 3_000), 'end', -100, 6_000)).toEqual(range(1_000, 2_900))
  })

  it('不出素材的头尾', () => {
    expect(trimRange(range(300, 3_000), 'start', -1_000, 6_000)).toEqual(range(0, 3_000))
    expect(trimRange(range(1_000, 5_500), 'end', 1_000, 6_000)).toEqual(range(1_000, 6_000))
  })

  it('两端之间至少留 0.1 秒', () => {
    expect(trimRange(range(1_000, 3_000), 'start', 5_000, 6_000)).toEqual(range(2_900, 3_000))
    expect(trimRange(range(1_000, 3_000), 'end', -5_000, 6_000)).toEqual(range(1_000, 1_100))
  })
})

describe('usedSpans：画面轨上每版素材片用了哪些段', () => {
  it('按版本分开，同一版用了几段就记几段；组件段不算', () => {
    const used = usedSpans([
      video('v1', 'a', 1_000, 2_000),
      card('c1', 2_000),
      video('v2', 'b', 0, 500),
      video('v3', 'a', 4_000, 1_000),
    ])
    expect(Object.fromEntries(used)).toEqual({
      a: [
        { clipId: 'v1', startMs: 1_000, endMs: 3_000 },
        { clipId: 'v3', startMs: 4_000, endMs: 5_000 },
      ],
      b: [{ clipId: 'v2', startMs: 0, endMs: 500 }],
    })
  })

  it('画面轨上没有视频时什么都没用', () => {
    expect(usedSpans([card('c1', 2_000)]).size).toBe(0)
  })
})

describe('shotAt：某一刻落在第几个镜头', () => {
  const shots = [
    { start: 0, end: 2 },
    { start: 2, end: 4.5 },
    { start: 4.5, end: 6 },
  ]

  it('从 1 数；落在切点上算后一个镜头', () => {
    expect(shotAt(shots, 0)).toBe(1)
    expect(shotAt(shots, 2)).toBe(2)
    expect(shotAt(shots, 5.9)).toBe(3)
  })

  it('不在任何镜头里时没有镜头号', () => {
    expect(shotAt(shots, 6)).toBeUndefined()
    expect(shotAt([], 1)).toBeUndefined()
  })
})
