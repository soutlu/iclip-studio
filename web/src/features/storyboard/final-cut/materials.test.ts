import { describe, expect, it } from 'vitest'
import { video } from '@/testing/final-cut'
import {
  addSpan,
  edgeLimits,
  extendToShot,
  orderedPicks,
  picksSummary,
  removeSpan,
  shotAt,
  slideSpan,
  spanIndexAt,
  spanPieces,
  trimSpan,
  usedSpans,
  type Material,
  type MaterialGroup,
  type MediaSpan,
  type PickSpan,
} from './materials'

const span = (startMs: number, endMs: number): MediaSpan => ({ startMs, endMs })
const pick = (startMs: number, endMs: number): PickSpan => ({ startMs, endMs, id: `${startMs}` })

/** 6 秒的素材，每秒一个镜头。 */
const DURATION = 6_000
const SHOTS = Array.from({ length: 6 }, (_, at) => span(at * 1_000, (at + 1) * 1_000))
const shot = (n: number) => {
  const found = SHOTS[n - 1]
  if (found === undefined) throw new Error(`没有镜头 ${n}`)
  return found
}

describe('addSpan：划出一段、点一个镜头，并进选区', () => {
  it('划出的一段可以跨镜头切口，原样留着', () => {
    expect(addSpan([], span(1_400, 3_600))).toEqual([span(1_400, 3_600)])
  })

  it('和已有的段不重叠时分开放，按时间排', () => {
    expect(addSpan([span(4_000, 5_000)], span(1_000, 2_000))).toEqual([
      span(1_000, 2_000),
      span(4_000, 5_000),
    ])
  })

  it('和已有的段重叠时并成一段；同时盖住几段时几段一起并', () => {
    expect(addSpan([span(1_000, 2_500)], span(2_000, 3_000))).toEqual([span(1_000, 3_000)])
    expect(addSpan([span(1_000, 2_000), span(3_000, 4_000)], span(1_500, 3_500))).toEqual([
      span(1_000, 4_000),
    ])
  })

  it('点紧挨着的镜头、空档不到 0.1 秒时也连成一段', () => {
    expect(addSpan([shot(2)], shot(3))).toEqual([span(1_000, 3_000)])
    expect(addSpan([span(1_000, 1_950)], shot(3))).toEqual([span(1_000, 3_000)])
    expect(addSpan([span(1_000, 1_900)], shot(3))).toEqual([span(1_000, 1_900), shot(3)])
  })

  it('点已经在选区里的镜头：选区不变', () => {
    expect(addSpan([span(500, 3_500)], shot(2))).toEqual([span(500, 3_500)])
  })
})

describe('extendToShot：Shift 点镜头', () => {
  it('从最靠后的一段连到点的镜头', () => {
    expect(extendToShot([shot(1), shot(3)], shot(5))).toEqual([shot(1), span(2_000, 5_000)])
  })

  it('点在最后一段前面：从这个镜头连到最后一段的结尾，中间的段并进来', () => {
    expect(extendToShot([shot(2), shot(5)], shot(4))).toEqual([shot(2), span(3_000, 5_000)])
    expect(extendToShot([shot(3), shot(5)], shot(1))).toEqual([span(0, 5_000)])
  })

  it('这条原作上还没有选区：只选这个镜头', () => {
    expect(extendToShot([], shot(4))).toEqual([shot(4)])
  })
})

describe('spanIndexAt、removeSpan：单击选区去掉这一段', () => {
  const spans = [span(1_000, 2_000), span(3_000, 5_000)]

  it('按时间找到盖着它的那一段，去掉它，别的段不动', () => {
    expect(spanIndexAt(spans, 3_500)).toBe(1)
    expect(removeSpan(spans, 1)).toEqual([span(1_000, 2_000)])
  })

  it('落在空档里、段的结尾上都不算', () => {
    expect(spanIndexAt(spans, 2_500)).toBeUndefined()
    expect(spanIndexAt(spans, 2_000)).toBeUndefined()
  })
})

describe('trimSpan：拖选区的一端调长短', () => {
  it('可以越过镜头切口，另一端不动', () => {
    expect(trimSpan([shot(2)], 0, 'end', 2_300, DURATION)).toEqual([span(1_000, 4_300)])
    expect(trimSpan([shot(3)], 0, 'start', -1_700, DURATION)).toEqual([span(300, 3_000)])
  })

  it('不压到相邻的段：停在离它 0.1 秒的地方', () => {
    const spans = [span(1_000, 2_000), span(3_000, 4_000)]
    expect(trimSpan(spans, 0, 'end', 5_000, DURATION)).toEqual([
      span(1_000, 2_900),
      span(3_000, 4_000),
    ])
    expect(trimSpan(spans, 1, 'start', -5_000, DURATION)).toEqual([
      span(1_000, 2_000),
      span(2_100, 4_000),
    ])
    expect(edgeLimits(spans, 1, 'start', DURATION)).toEqual({ min: 2_100, max: 3_900 })
  })

  it('不出素材的头尾，两端之间至少留 0.1 秒', () => {
    expect(trimSpan([shot(1)], 0, 'start', -500, DURATION)).toEqual([shot(1)])
    expect(trimSpan([shot(6)], 0, 'end', 500, DURATION)).toEqual([shot(6)])
    expect(trimSpan([shot(2)], 0, 'start', 5_000, DURATION)).toEqual([span(1_900, 2_000)])
    expect(trimSpan([shot(2)], 0, 'end', -5_000, DURATION)).toEqual([span(1_000, 1_100)])
  })
})

describe('slideSpan：拖选区中间整段平移', () => {
  it('长短不变，可以挪过镜头切口', () => {
    expect(slideSpan([span(1_000, 2_500)], 0, 1_200, DURATION)).toEqual([span(2_200, 3_700)])
  })

  it('碰到相邻的段停在离它 0.1 秒的地方，碰到素材的头尾就停', () => {
    const spans = [span(1_000, 2_000), span(3_000, 4_000)]
    expect(slideSpan(spans, 0, 5_000, DURATION)).toEqual([span(1_900, 2_900), span(3_000, 4_000)])
    expect(slideSpan(spans, 0, -5_000, DURATION)).toEqual([span(0, 1_000), span(3_000, 4_000)])
    expect(slideSpan(spans, 1, 5_000, DURATION)).toEqual([span(1_000, 2_000), span(5_000, 6_000)])
  })
})

describe('spanPieces：加入 final-cut 时一段拆成的片段', () => {
  it('在段里的镜头切口处切开，一个镜头一个片段，头尾带着划选的位置', () => {
    expect(spanPieces(span(1_200, 3_400), SHOTS)).toEqual([
      { mediaStart: 1_200, duration: 800 },
      { mediaStart: 2_000, duration: 1_000 },
      { mediaStart: 3_000, duration: 400 },
    ])
  })

  it('没跨切口时整段一个片段', () => {
    expect(spanPieces(span(2_100, 2_900), SHOTS)).toEqual([{ mediaStart: 2_100, duration: 800 }])
  })

  it('离一端不到 0.1 秒的切口不切，那一小截并进旁边的片段', () => {
    expect(spanPieces(span(1_950, 3_050), SHOTS)).toEqual([{ mediaStart: 1_950, duration: 1_100 }])
  })
})

const material = (jobId: string, takeId: string): Material => ({
  jobId,
  url: `${jobId}.mp4`,
  durationMs: DURATION,
  groupId: 'group',
  groupLabel: '镜头组 1',
  takeId,
  takeLetter: takeId.toUpperCase(),
  takeLabel: `生成 ${takeId.toUpperCase()}`,
  version: 'V1 原片',
  versionNumber: 'V1',
})

const group = (id: string, takes: readonly string[]): MaterialGroup => ({
  id,
  label: id,
  takes: takes.map((takeId) => {
    const latest = material(`${takeId}-v1`, takeId)
    return { id: takeId, label: latest.takeLabel, versions: [latest], latest }
  }),
})

describe('orderedPicks：几条原作上的选区一起加入时的先后', () => {
  const groups = [group('镜头组 1', ['a', 'b']), group('镜头组 2', ['c'])]

  it('原作按在面板里的顺序，同一条原作里按时间', () => {
    const picks = new Map([
      ['c', { jobId: 'c-v1', spans: [pick(0, 1_000)] }],
      ['b', { jobId: 'b-v1', spans: [pick(500, 900)] }],
      ['a', { jobId: 'a-v1', spans: [pick(1_000, 2_000), pick(4_000, 5_000)] }],
    ])
    expect(
      orderedPicks(groups, picks).map(({ material, span }) => [material.jobId, span.startMs]),
    ).toEqual([
      ['a-v1', 1_000],
      ['a-v1', 4_000],
      ['b-v1', 500],
      ['c-v1', 0],
    ])
    expect(picksSummary(picks)).toEqual({ count: 4, durationMs: 3_400 })
  })

  it('选在面板里已经没有的版本上的段不加', () => {
    const picks = new Map([['a', { jobId: 'gone', spans: [pick(0, 1_000)] }]])
    expect(orderedPicks(groups, picks)).toEqual([])
  })
})

describe('usedSpans：final-cut 里每版素材片用了哪些段', () => {
  it('按版本的地址分开，同一版用了几段就记几段', () => {
    const used = usedSpans([
      video({ id: 'v1', src: 'a.mp4', mediaStart: 1_000, duration: 2_000 }),
      video({ id: 'v2', src: 'b.mp4', mediaStart: 0, duration: 500 }),
      video({ id: 'v3', src: 'a.mp4', mediaStart: 4_000, duration: 1_000 }),
    ])
    expect(Object.fromEntries(used)).toEqual({
      'a.mp4': [
        { clipId: 'v1', startMs: 1_000, endMs: 3_000 },
        { clipId: 'v3', startMs: 4_000, endMs: 5_000 },
      ],
      'b.mp4': [{ clipId: 'v2', startMs: 0, endMs: 500 }],
    })
  })

  it('调了速度的片段：用掉的是片段长 × 速度那么长的一段', () => {
    const used = usedSpans([
      video({ id: 'v1', src: 'a.mp4', mediaStart: 1_000, duration: 2_000, playbackRate: 2 }),
      video({ id: 'v2', src: 'a.mp4', mediaStart: 6_000, duration: 2_000, playbackRate: 0.5 }),
    ])
    expect(used.get('a.mp4')).toEqual([
      { clipId: 'v1', startMs: 1_000, endMs: 5_000 },
      { clipId: 'v2', startMs: 6_000, endMs: 7_000 },
    ])
  })

  it('final-cut 里没有画面时什么都没用', () => {
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
