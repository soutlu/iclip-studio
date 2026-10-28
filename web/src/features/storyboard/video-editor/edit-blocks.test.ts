import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import { blockStateOf, laneEditsOf, shotsOf, spanName } from './edit-blocks'

const shots = shotsOf({ keyframes: [0, 1, 2, 3, 4, 5], duration: 6 })

let minute = 0
const edit = ([start, end]: [number, number], spec: Partial<GenerationJob> = {}): GenerationJob => {
  minute += 1
  return makeGenerationJob({
    id: `edit-${minute}`,
    rootJobId: 'root',
    sourceJobId: 'root',
    rangeStartMs: Math.round(start * 1000),
    rangeEndMs: Math.round(end * 1000),
    createdAt: `2026-10-28T10:${String(minute).padStart(2, '0')}:00Z`,
    ...spec,
  })
}

describe('shotsOf', () => {
  it('关键帧之间一段一个镜头，从 1 编号，时间取到毫秒', () => {
    expect(shotsOf({ keyframes: [0, 1.00049, 2.5], duration: 3 })).toEqual([
      { no: 1, start: 0, end: 1 },
      { no: 2, start: 1, end: 2.5 },
      { no: 3, start: 2.5, end: 3 },
    ])
  })
})

describe('spanName', () => {
  it.each([
    [{ from: 3, to: 3 }, '镜头 3'],
    [{ from: 3, to: 6 }, '镜头 3–6'],
  ])('%o 叫 %s', (span, name) => expect(spanName(span)).toBe(name))
})

describe('laneEditsOf', () => {
  it.each<[string, [number, number], { from: number; to: number } | undefined]>([
    ['正好对齐', [1, 3], { from: 2, to: 3 }],
    ['两端各差 0.05 秒以内', [1.049, 2.951], { from: 2, to: 3 }],
    ['开头差 0.06 秒', [1.06, 3], undefined],
    ['结尾差 0.06 秒', [1, 2.94], undefined],
    ['落在一个镜头中间', [1.5, 2.5], undefined],
  ])('%s', (_, range, expected) => {
    const lane = laneEditsOf('root', [edit(range)], shots)
    expect(lane[0] === undefined ? undefined : { from: lane[0].from, to: lane[0].to }).toEqual(
      expected,
    )
  })

  it('在合成上做的编辑段、别的原片的、合成本身都不在轨上', () => {
    const jobs = [
      edit([1, 2], { sourceJobId: 'composite-1' }),
      edit([1, 2], { sourceJobId: 'other-root', rootJobId: 'other-root' }),
      makeGenerationJob({ id: 'm', operation: 'compose', sourceJobId: 'root', rootJobId: 'root' }),
    ]
    expect(laneEditsOf('root', jobs, shots)).toEqual([])
  })

  it('按生成先后排行：放进第一个不重叠的行，后来的选用不改行', () => {
    const first = edit([1, 3])
    const second = edit([2, 4])
    const third = edit([3, 5])
    const fourth = edit([0, 1])
    // 列表里新的在前，排行仍按生成先后。
    const lane = laneEditsOf('root', [fourth, third, second, first], shots)
    expect(lane.map(({ id, row }) => [id, row])).toEqual([
      [first.id, 0],
      [second.id, 1],
      [third.id, 0],
      [fourth.id, 0],
    ])
  })

  it('同样几个镜头生成过不止一次才编第几次，在跑与失败的也算', () => {
    const lane = laneEditsOf(
      'root',
      [
        edit([1, 3], { status: 'failed' }),
        edit([1, 3]),
        edit([1, 3], { status: 'submitted' }),
        edit([4, 5]),
      ],
      shots,
    )
    expect(lane.map((item) => item.name)).toEqual([
      '镜头 2–3 · 第 1 次',
      '镜头 2–3 · 第 2 次',
      '镜头 2–3 · 第 3 次',
      '镜头 5',
    ])
  })
})

describe('blockStateOf', () => {
  const url = 'https://oss.example/edit.mp4'
  it.each<[string, Partial<GenerationJob>, Record<string, number | null>, unknown]>([
    ['在跑', { status: 'submitted' }, {}, { kind: 'running' }],
    [
      '失败带原因',
      { status: 'failed', errorMessage: '模型超时' },
      {},
      { kind: 'failed', message: '模型超时' },
    ],
    ['完成却没有地址', { outputUrl: null }, {}, { kind: 'failed', message: '未返回生成结果' }],
    ['时长还在读', { outputUrl: url }, {}, { kind: 'measuring' }],
    ['时长读不出', { outputUrl: url }, { [url]: null }, { kind: 'unreadable' }],
    ['可以选用', { outputUrl: url }, { [url]: 4 }, { kind: 'ready', duration: 4 }],
  ])('%s', (_, spec, durations, expected) => {
    expect(blockStateOf(edit([1, 2], spec), durations)).toEqual(expected)
  })
})
