import { describe, expect, it } from 'vitest'
import { picture } from '@/testing/whole-film'
import {
  rangePieces,
  shiftShot,
  shotAt,
  shotRange,
  trimRange,
  usedSpans,
  type MaterialRange,
} from './materials'

const range = (startMs: number, endMs: number): MaterialRange =>
  shotRange('job', 'take', { startMs, endMs })

const SHOTS = Array.from({ length: 6 }, (_, at) => ({
  startMs: at * 1_000,
  endMs: (at + 1) * 1_000,
}))

const shots = (
  first: number,
  last: number,
  trim: { startMs?: number; endMs?: number } = {},
): MaterialRange => ({
  jobId: 'job',
  takeId: 'take',
  startMs: trim.startMs ?? (first - 1) * 1_000,
  endMs: trim.endMs ?? last * 1_000,
  shots: SHOTS.slice(first - 1, last),
})

const shiftClick = (current: MaterialRange | null, n: number, jobId = 'job') => {
  const shot = SHOTS[n - 1]
  if (shot === undefined) throw new Error(`没有镜头 ${n}`)
  return shiftShot(current, shotRange(jobId, 'take', shot), SHOTS)
}

describe('trimRange：挪选区的一端', () => {
  it('只挪这一端，另一端不动', () => {
    expect(trimRange(range(1_000, 3_000), 'start', 500, 6_000)).toMatchObject({
      startMs: 1_500,
      endMs: 3_000,
    })
    expect(trimRange(range(1_000, 3_000), 'end', -100, 6_000)).toMatchObject({
      startMs: 1_000,
      endMs: 2_900,
    })
  })

  it('不出素材的头尾', () => {
    expect(trimRange(range(300, 3_000), 'start', -1_000, 6_000)).toMatchObject({
      startMs: 0,
      endMs: 3_000,
    })
    expect(trimRange(range(1_000, 5_500), 'end', 1_000, 6_000)).toMatchObject({
      startMs: 1_000,
      endMs: 6_000,
    })
  })

  it('两端之间至少留 0.1 秒', () => {
    expect(trimRange(range(1_000, 3_000), 'start', 5_000, 6_000)).toMatchObject({
      startMs: 2_900,
      endMs: 3_000,
    })
    expect(trimRange(range(1_000, 3_000), 'end', -5_000, 6_000)).toMatchObject({
      startMs: 1_000,
      endMs: 1_100,
    })
  })

  it('只选一个镜头时可以拉过镜头边界，选中的镜头不变', () => {
    expect(trimRange(range(2_000, 3_000), 'end', 1_500, 6_000)).toEqual({
      ...range(2_000, 3_000),
      endMs: 4_500,
    })
  })

  it('选了几个镜头：左端调第一个镜头的开头，往里不越过它的结尾、留 0.1 秒，往外到素材开头', () => {
    const picked = shots(2, 4)
    expect(trimRange(picked, 'start', 5_000, 6_000)).toEqual(shots(2, 4, { startMs: 1_900 }))
    expect(trimRange(picked, 'start', -5_000, 6_000)).toEqual(shots(2, 4, { startMs: 0 }))
  })

  it('选了几个镜头：右端调最后一个镜头的结尾，往里不越过它的开头、留 0.1 秒，往外到素材结尾', () => {
    const picked = shots(2, 4)
    expect(trimRange(picked, 'end', -5_000, 6_000)).toEqual(shots(2, 4, { endMs: 3_100 }))
    expect(trimRange(picked, 'end', 5_000, 6_000)).toEqual(shots(2, 4, { endMs: 6_000 }))
  })
})

describe('rangePieces：加入成片时拆成的段', () => {
  it('一个镜头一段；拉过镜头边界也不拆', () => {
    expect(rangePieces({ ...range(2_000, 3_000), startMs: 1_500, endMs: 4_500 })).toEqual([
      { mediaStart: 1_500, duration: 3_000 },
    ])
  })

  it('几个镜头按镜头拆，第一段、最后一段带两端的修剪', () => {
    expect(rangePieces(shots(2, 4, { startMs: 1_200, endMs: 3_400 }))).toEqual([
      { mediaStart: 1_200, duration: 800 },
      { mediaStart: 2_000, duration: 1_000 },
      { mediaStart: 3_000, duration: 400 },
    ])
  })
})

describe('shiftShot：Shift 点镜头', () => {
  it('点紧挨的镜头扩选，没变的一端保留修剪', () => {
    expect(shiftClick(range(2_000, 3_000), 4)).toEqual(shots(3, 4))
    expect(shiftClick(shots(3, 4, { endMs: 4_600 }), 2)).toEqual(shots(2, 4, { endMs: 4_600 }))
    expect(shiftClick(shots(3, 4, { startMs: 2_300 }), 5)).toEqual(shots(3, 5, { startMs: 2_300 }))
  })

  it('去掉最左或最右的镜头，另一端保留修剪；只剩一个时点它全部取消', () => {
    expect(shiftClick(shots(2, 4, { endMs: 3_500 }), 2)).toEqual(shots(3, 4, { endMs: 3_500 }))
    expect(shiftClick(shots(2, 4, { startMs: 1_200 }), 4)).toEqual(shots(2, 3, { startMs: 1_200 }))
    expect(shiftClick(range(2_000, 3_000), 3)).toBeNull()
  })

  it('只选一个镜头时拉过了边界，扩选后收回到新的镜头边界以内', () => {
    expect(shiftClick({ ...range(2_000, 3_000), startMs: 3_500, endMs: 4_500 }, 4)).toEqual(
      shots(3, 4, { startMs: 2_900 }),
    )
  })

  it.each([
    ['选区中间的镜头', shots(2, 4), 3],
    ['不相邻的镜头', shots(2, 3), 6],
    ['没有选区时', null, 5],
  ])('点%s：只选它', (_, current, n) => {
    expect(shiftClick(current, n)).toEqual(shots(n, n))
  })

  it('别的素材、别的版本里的镜头：只选它', () => {
    expect(shiftClick(shots(2, 3), 4, 'other')).toEqual(
      shotRange('other', 'take', { startMs: 3_000, endMs: 4_000 }),
    )
  })
})

describe('usedSpans：成片里每版素材片用了哪些段', () => {
  it('按版本分开，同一版用了几段就记几段', () => {
    const used = usedSpans([
      picture({ id: 'v1', jobId: 'a', mediaStart: 1_000, duration: 2_000 }),
      picture({ id: 'v2', jobId: 'b', mediaStart: 0, duration: 500 }),
      picture({ id: 'v3', jobId: 'a', mediaStart: 4_000, duration: 1_000 }),
    ])
    expect(Object.fromEntries(used)).toEqual({
      a: [
        { clipId: 'v1', startMs: 1_000, endMs: 3_000 },
        { clipId: 'v3', startMs: 4_000, endMs: 5_000 },
      ],
      b: [{ clipId: 'v2', startMs: 0, endMs: 500 }],
    })
  })

  it('调了速度的块：用掉的是块长 × 速度那么长的一段', () => {
    const used = usedSpans([
      picture({ id: 'v1', jobId: 'a', mediaStart: 1_000, duration: 2_000, playbackRate: 2 }),
      picture({ id: 'v2', jobId: 'a', mediaStart: 6_000, duration: 2_000, playbackRate: 0.5 }),
    ])
    expect(used.get('a')).toEqual([
      { clipId: 'v1', startMs: 1_000, endMs: 5_000 },
      { clipId: 'v2', startMs: 6_000, endMs: 7_000 },
    ])
  })

  it('成片里没有画面时什么都没用', () => {
    expect(usedSpans([]).size).toBe(0)
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
