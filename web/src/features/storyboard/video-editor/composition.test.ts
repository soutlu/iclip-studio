import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import {
  anchorOfClock,
  arePicksUsable,
  canCompose,
  clockOfAnchor,
  compositeSegmentsOf,
  compositionOf,
  pickEdit,
  pickedBlocksOf,
  picksFromComposite,
  segmentsLength,
  segmentsOf,
  unitsOf,
  type Segment,
} from './composition'
import { editBlocksOf, laneEditsOf, shotsOf } from './edit-blocks'

const ROOT = { id: 'root', mediaUrl: 'https://oss.example/root.mp4' }
// 6 个镜头，各 1 秒。
const shots = shotsOf({ keyframes: [0, 1, 2, 3, 4, 5], duration: 6 })

let minute = 0
const edit = (
  id: string,
  [start, end]: [number, number],
  spec: Partial<GenerationJob> = {},
): GenerationJob => {
  minute += 1
  return makeGenerationJob({
    id,
    rootJobId: 'root',
    sourceJobId: 'root',
    rangeStartMs: start * 1000,
    rangeEndMs: end * 1000,
    outputUrl: `https://oss.example/${id}.mp4`,
    createdAt: `2026-10-28T10:${String(minute).padStart(2, '0')}:00Z`,
    ...spec,
  })
}

/** a 换镜头 2–3（出 4 秒），b 换镜头 3–4（出 1 秒），c 换镜头 6（还在跑）。 */
const jobs = [
  edit('a', [1, 3]),
  edit('b', [2, 4]),
  edit('c', [5, 6], { status: 'submitted', outputUrl: null }),
]
const blocks = editBlocksOf(laneEditsOf('root', jobs, shots), {
  'https://oss.example/a.mp4': 4,
  'https://oss.example/b.mp4': 1,
})
const composition = (picks: readonly string[]) =>
  compositionOf(ROOT, shots, pickedBlocksOf(blocks, picks))

describe('选用', () => {
  it('选用一条取消与它重叠的，不重叠的留着', () => {
    expect(pickEdit(['a'], blocks, 'b')).toEqual(['b'])
    expect(pickEdit(['b'], blocks, 'a')).toEqual(['a'])
    expect(pickEdit([], blocks, 'a')).toEqual(['a'])
  })

  it.each<[string, string[], boolean]>([
    ['都可用且不重叠', ['a'], true],
    ['有一条重叠', ['a', 'b'], false],
    ['有一条还在跑', ['c'], false],
    ['有一条不在轨上', ['gone'], false],
    ['什么都没选', [], true],
  ])('存着的选用：%s', (_, picks, usable) => {
    expect(arePicksUsable(picks, blocks)).toBe(usable)
  })

  it('原片轨的单位：被替换的镜头并成那一条编辑片段', () => {
    expect(unitsOf(shots, pickedBlocksOf(blocks, ['a'])).map((unit) => unit.id)).toEqual([
      'shot-1',
      'a',
      'shot-4',
      'shot-5',
      'shot-6',
    ])
  })
})

describe('合成内容', () => {
  it('没选用就是整条原片', () => {
    expect(segmentsOf(composition([]))).toEqual([{ sourceJobId: 'root', start: 0, end: 6 }])
  })

  it('原片没被替换的相连部分并成一段，编辑片段整段用到结尾，按原片时间排', () => {
    const pieces = composition(['a'])
    expect(segmentsOf(pieces)).toEqual([
      { sourceJobId: 'root', start: 0, end: 1 },
      { sourceJobId: 'a', start: 0, end: null },
      { sourceJobId: 'root', start: 3, end: 6 },
    ])
    expect(pieces.map(({ at, duration }) => [at, duration])).toEqual([
      [0, 1],
      [1, 4],
      [5, 3],
    ])
  })

  it('选用盖住全部镜头时只剩编辑片段', () => {
    const lane = editBlocksOf(laneEditsOf('root', [edit('all', [0, 6])], shots), {
      'https://oss.example/all.mp4': 5,
    })
    const pieces = compositionOf(ROOT, shots, pickedBlocksOf(lane, ['all']))
    expect(segmentsOf(pieces)).toEqual([{ sourceJobId: 'all', start: 0, end: null }])
    expect(anchorOfClock(pieces, 2.5)).toBe(3)
  })
})

describe('播放头在原片时间轴上的位置', () => {
  const pieces = composition(['a'])

  it.each([
    [0.5, 0.5],
    [1, 1],
    // 4 秒的编辑片段按比例落在原片 1–3 秒上
    [3, 2],
    [5, 3],
    [6.5, 4.5],
    [8, 6],
  ])('合成里 %f 秒在原片 %f 秒', (clock, anchor) => {
    expect(anchorOfClock(pieces, clock)).toBeCloseTo(anchor)
  })

  it.each([
    [0.5, 0.5],
    [1, 1],
    [2, 3],
    [3, 5],
    [4.5, 6.5],
  ])('原片 %f 秒在合成里 %f 秒', (anchor, clock) => {
    expect(clockOfAnchor(pieces, anchor)).toBeCloseTo(clock)
  })
})

describe('最近一次合成', () => {
  const composite = (segments: unknown) =>
    makeGenerationJob({ id: 'm', operation: 'compose', sourceJobId: 'root', request: { segments } })
  const durationOf = (id: string) => (id === 'a' ? 4 : id === 'b' ? 1 : undefined)
  const parse = (segments: unknown) => compositeSegmentsOf(composite(segments), 'root', durationOf)

  it('按镜头存的原片段并成一段，整段的编辑段统一写法；带着地址也读得出', () => {
    const segments = parse([
      { sourceJobId: 'root', start: 0, end: 1, url: 'https://oss.example/root.mp4' },
      { sourceJobId: 'a', start: 0, end: 4.02, url: 'https://oss.example/a.mp4' },
      { sourceJobId: 'root', start: 3, end: 4, url: 'https://oss.example/root.mp4' },
      { sourceJobId: 'root', start: 4, end: 6, url: 'https://oss.example/root.mp4' },
    ])
    expect(segments).toEqual(segmentsOf(composition(['a'])))
    expect(picksFromComposite(segments, 'root', shots, blocks)).toEqual(['a'])
  })

  it.each<[string, unknown]>([
    ['编辑段被裁短', [{ sourceJobId: 'a', start: 0, end: 2 }]],
    ['原片段落在镜头中间', [{ sourceJobId: 'root', start: 0.5, end: 1 }]],
    ['编辑段不在轨上', [{ sourceJobId: 'gone', start: 0, end: null }]],
    [
      '两条编辑段重叠',
      [
        { sourceJobId: 'a', start: 0, end: null },
        { sourceJobId: 'b', start: 0, end: null },
      ],
    ],
  ])('%s 时推不出选用', (_, segments) => {
    expect(picksFromComposite(parse(segments), 'root', shots, blocks)).toEqual([])
  })

  it.each([
    ['读不懂', 'not-a-list'],
    ['空的', []],
  ])('请求%s时什么都不选', (_, segments) => {
    expect(parse(segments)).toBeUndefined()
    expect(picksFromComposite(parse(segments), 'root', shots, blocks)).toEqual([])
  })
})

describe('segmentsLength', () => {
  const segments: Segment[] = [
    { sourceJobId: 'root', start: 0, end: 2 },
    { sourceJobId: 'a', start: 0, end: null },
    { sourceJobId: 'root', start: 4, end: null },
  ]
  it('用到出处结尾的段按出处全长算', () => {
    expect(segmentsLength(segments, (id) => (id === 'root' ? 6 : 3))).toBe(7)
  })
  it('有一段的出处不知道多长就算不出', () => {
    expect(segmentsLength(segments, (id) => (id === 'root' ? 6 : undefined))).toBeUndefined()
  })
})

describe('canCompose', () => {
  const original: Segment[] = [{ sourceJobId: 'root', start: 0, end: 6 }]
  const withA = segmentsOf(composition(['a']))
  const check = (overrides: Partial<Parameters<typeof canCompose>[0]>) =>
    canCompose({
      current: withA,
      original,
      latest: undefined,
      composing: false,
      busy: false,
      ...overrides,
    })

  it.each<[string, Partial<Parameters<typeof canCompose>[0]>, boolean]>([
    ['和原片不同、也没合成过', {}, true],
    ['就是原片', { current: original }, false],
    ['和最近一次合成一样', { latest: withA }, false],
    ['最近一次合成用的是裁短的编辑段', { latest: [{ sourceJobId: 'a', start: 0, end: 2 }] }, true],
    ['正在合成', { composing: true }, false],
    ['正在提交', { busy: true }, false],
  ])('%s', (_, overrides, expected) => {
    expect(check(overrides)).toBe(expected)
  })
})
