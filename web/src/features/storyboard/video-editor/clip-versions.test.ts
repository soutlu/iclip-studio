import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import { baseRangeForClip, groupForClip, groupForRange, groupsForBase } from './clip-versions'

const edit = (
  id: string,
  sourceJobId: string,
  [start, end]: [number, number],
  overrides: Partial<GenerationJob> = {},
): GenerationJob =>
  makeGenerationJob({
    id,
    sourceJobId,
    rootJobId: 'base',
    rangeStartMs: start,
    rangeEndMs: end,
    ...overrides,
  })

describe('groupsForBase', () => {
  it('按精确基底区间分组，重叠区间各自保留候选', () => {
    const short = edit('short', 'base', [2000, 4000])
    const wide = edit('wide', 'base', [2000, 6000])
    const adjacent = edit('adjacent', 'base', [4000, 6000])

    expect(groupsForBase('base', [wide, adjacent, short])).toEqual([
      { key: 'base@2000-4000', baseJobId: 'base', start: 2, end: 4, edits: [short] },
      { key: 'base@2000-6000', baseJobId: 'base', start: 2, end: 6, edits: [wide] },
      { key: 'base@4000-6000', baseJobId: 'base', start: 4, end: 6, edits: [adjacent] },
    ])
    expect(groupsForBase('base', [])).toEqual([])
  })

  it('全部尝试按提交时间和 id 排序，完成顺序与状态变化不改变版本号', () => {
    const first = edit('first', 'base', [1000, 3000], {
      createdAt: '2026-10-15T10:00:00Z',
      finishedAt: '2026-10-15T10:04:00Z',
      outputUrl: 'https://oss.example/first.mp4',
    })
    const failed = edit('second', 'base', [1000, 3000], {
      createdAt: '2026-10-15T10:01:00Z',
      finishedAt: '2026-10-15T10:02:00Z',
      status: 'failed',
    })
    const pending = edit('third', 'base', [1000, 3000], {
      createdAt: '2026-10-15T10:01:00Z',
      status: 'submitted',
    })
    const jobs = [pending, failed, first]

    expect(groupsForBase('base', jobs)[0]?.edits).toEqual([first, failed, pending])
    expect(
      groupsForBase('base', [
        { ...pending, status: 'completed', outputUrl: 'https://oss.example/third.mp4' },
        failed,
        first,
      ])[0]?.edits.map((job) => job.id),
    ).toEqual(['first', 'second', 'third'])
    expect(jobs).toEqual([pending, failed, first])
  })

  it('只接收直接来自基底的编辑段，其他基底、媒体与操作不混入', () => {
    const first = edit('first', 'base', [2542, 5042])
    const otherBase = edit('other', 'composite', [2542, 5042])
    const jobs = [
      first,
      otherBase,
      edit('image', 'base', [0, 1000], { kind: 'image' }),
      edit('composite', 'base', [0, 1000], { operation: 'compose' }),
      edit('without-range', 'base', [0, 1000], { rangeEndMs: null }),
    ]

    expect(groupsForBase('base', jobs)[0]?.edits).toEqual([first])
    expect(groupsForBase('base', jobs)).toHaveLength(1)
    expect(groupsForBase('composite', jobs)[0]?.edits).toEqual([otherBase])
  })
})

describe('片段与区间定位', () => {
  const first = edit('first', 'base', [2000, 4000], { durationMs: 3000 })
  const second = edit('second', 'base', [2000, 4000], { durationMs: 4000 })
  const partial = edit('partial', 'base', [3000, 4000], { durationMs: 1500 })
  const jobs = [first, second, partial]

  it('按基底精确区间查组，不按包含关系混用候选', () => {
    expect(groupForRange({ start: 2, end: 4 }, 'base', jobs)?.edits).toEqual([first, second])
    expect(groupForRange({ start: 2, end: 3 }, 'base', jobs)).toBeUndefined()
    expect(groupForClip({ sourceJobId: 'base', start: 2, end: 4 }, 'base', jobs)?.key).toBe(
      'base@2000-4000',
    )
  })

  it('完整结果和裁剪结果按实际生成时长映射到不同的基底范围', () => {
    expect(baseRangeForClip({ sourceJobId: 'first', start: 0, end: 3 }, 'base', jobs)).toEqual({
      start: 2,
      end: 4,
    })
    expect(groupForClip({ sourceJobId: 'first', start: 0, end: 3 }, 'base', jobs)?.edits).toEqual([
      first,
      second,
    ])
    expect(baseRangeForClip({ sourceJobId: 'first', start: 1.5, end: 3 }, 'base', jobs)).toEqual({
      start: 3,
      end: 4,
    })
    expect(groupForClip({ sourceJobId: 'first', start: 1.5, end: 3 }, 'base', jobs)?.edits).toEqual(
      [partial],
    )
    expect(groupForClip({ sourceJobId: 'first', start: 0, end: 1.5 }, 'base', jobs)).toBeUndefined()
    expect(baseRangeForClip({ sourceJobId: 'second', start: 1, end: 3 }, 'base', jobs)).toEqual({
      start: 2.5,
      end: 3.5,
    })
  })

  it('时长缺失时等待探测，不用已裁剪片段长度猜测整个编辑范围', () => {
    const unknown = edit('unknown', 'base', [2000, 4000])
    const clip = { sourceJobId: 'unknown', start: 0.5, end: 1.5 }
    expect(baseRangeForClip(clip, 'base', [unknown])).toBeUndefined()
    expect(baseRangeForClip(clip, 'base', [unknown], () => 2)).toEqual({ start: 2.5, end: 3.5 })
    expect(baseRangeForClip(clip, 'base', [unknown], () => 0)).toBeUndefined()
    expect(baseRangeForClip(clip, 'base', [unknown], () => 1)).toBeUndefined()
    expect(baseRangeForClip(clip, 'base', [])).toBeUndefined()
  })
})
