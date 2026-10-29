import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import {
  editBlocksOf,
  editStateOf,
  failedEditsOf,
  laneEditsOf,
  lanePartsOf,
  shotsOf,
  spanName,
  type KeyframeRead,
} from './edit-blocks'

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
    outputUrl: `https://oss.example/edit-${minute}.mp4`,
    createdAt: `2026-10-28T10:${String(minute).padStart(2, '0')}:00Z`,
    ...spec,
  })
}
const failed = { status: 'failed', outputUrl: null } as const

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
  it.each<[string, [number, number], { from: number; to: number }]>([
    ['正好是镜头边界', [1, 3], { from: 2, to: 3 }],
    ['盖到一部分也算', [1.5, 3.2], { from: 2, to: 4 }],
    ['落在一个镜头中间', [1.5, 1.8], { from: 2, to: 2 }],
  ])('区间对不对得上镜头都在轨上，覆盖到的镜头是区间碰到的：%s', (_, range, expected) => {
    const [lane] = laneEditsOf('root', [edit(range)], shots)
    expect(lane).toMatchObject({ ...expected, start: range[0], end: range[1] })
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

  it('失败的不占行也不算次数：同样几个镜头在轨上不止一条才编第几次，在跑的也算', () => {
    const lane = laneEditsOf(
      'root',
      [
        edit([1, 3], failed),
        edit([1, 3]),
        edit([1, 3], { status: 'submitted', outputUrl: null }),
        edit([1, 3], { outputUrl: null }),
        edit([4, 5], failed),
        edit([4, 5]),
      ],
      shots,
    )
    expect(lane.map(({ name, row }) => [name, row])).toEqual([
      ['镜头 2–3 · 第 1 次', 0],
      ['镜头 2–3 · 第 2 次', 1],
      ['镜头 5', 0],
    ])
  })
})

describe('failedEditsOf', () => {
  it('每个区间只看最近的一次：它失败了才算，之后对完全相同的区间又提交过（在跑、完成、再失败）前面的就不算', () => {
    const superseded = edit([1, 3], failed)
    const rerun = edit([1, 3], { status: 'submitted', outputUrl: null })
    const replaced = edit([0, 1], failed)
    const again = edit([0, 1], failed)
    const pending = edit([4, 5], failed)
    expect(
      failedEditsOf('root', [superseded, rerun, replaced, again, pending, edit([3, 4])], shots).map(
        (item) => item.job.id,
      ),
    ).toEqual([again.id, pending.id])
  })

  it('碰到的镜头相同、区间不同的生成不算重新提交', () => {
    const midShot = edit([1.5, 2.6], failed)
    const wholeShots = edit([1, 3], { status: 'submitted', outputUrl: null })
    expect(failedEditsOf('root', [midShot, wholeShots], shots).map((item) => item.job.id)).toEqual([
      midShot.id,
    ])
  })
})

describe('editStateOf', () => {
  const index = { keyframes: [0, 1, 2], duration: 3 }
  it.each<[string, Partial<GenerationJob>, KeyframeRead | undefined, unknown]>([
    ['在跑', { status: 'submitted' }, undefined, { kind: 'running' }],
    ['关键帧读取中', {}, { data: undefined, isError: false }, { kind: 'measuring' }],
    ['关键帧读不出', {}, { data: undefined, isError: true }, { kind: 'unreadable' }],
    [
      '按自己的关键帧切段，读到的时长就是它的时长',
      {},
      { data: index, isError: false },
      {
        kind: 'ready',
        duration: 3,
        parts: [
          { seg: 1, b0: 0, b1: 1 },
          { seg: 2, b0: 1, b1: 2 },
          { seg: 3, b0: 2, b1: 3 },
        ],
      },
    ],
    [
      '没有关键帧就是一整段',
      {},
      { data: { keyframes: [], duration: 2 }, isError: false },
      { kind: 'ready', duration: 2, parts: [{ seg: 1, b0: 0, b1: 2 }] },
    ],
  ])('%s', (_, spec, read, expected) => {
    expect(editStateOf(edit([1, 2], spec), read)).toEqual(expected)
  })
})

describe('lanePartsOf', () => {
  it('完成的每段占它那条宽度里按时长比例的一份；在跑的整条一块', () => {
    const done = edit([1, 3])
    const running = edit([4, 6], { status: 'submitted', outputUrl: null })
    const blocks = editBlocksOf(laneEditsOf('root', [done, running], shots), () => ({
      data: { keyframes: [0, 1], duration: 4 },
      isError: false,
    }))
    expect(lanePartsOf(blocks).map(({ id, at, len }) => [id, at, len])).toEqual([
      [`${done.id}#1`, 1, 0.5],
      [`${done.id}#2`, 1.5, 1.5],
      [running.id, 4, 2],
    ])
  })
})
