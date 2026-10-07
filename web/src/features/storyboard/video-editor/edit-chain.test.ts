import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import {
  composingOf,
  editCountsByRoot,
  editsOf,
  projectVersions,
  rebuildCandidates,
} from './edit-chain'

const at = (time: string) => `2026-09-15T${time}Z`

const job = (spec: Partial<GenerationJob> & { id: string }): GenerationJob =>
  makeGenerationJob({ createdAt: at('10:00:00'), ...spec })

/** 编辑段：原作号一律指根，来源是这次的基底（根或某次合成）；区间按秒给。 */
const edit = (
  id: string,
  source: string,
  [start, end]: [number, number],
  spec: Partial<GenerationJob> = {},
): GenerationJob =>
  job({
    id,
    rootJobId: 'root',
    sourceJobId: source,
    rangeStartMs: start * 1000,
    rangeEndMs: end * 1000,
    ...spec,
  })

/** 合成：来源是基底；请求里的片段不影响投影，给一份读不出来的也一样。 */
const composite = (id: string, base: string, spec: Partial<GenerationJob> = {}): GenerationJob =>
  job({
    id,
    operation: 'compose',
    rootJobId: 'root',
    sourceJobId: base,
    request: { segments: 'not-a-list' },
    outputUrl: `https://oss.example/${id}.mp4`,
    ...spec,
  })

const root = job({ id: 'root', outputUrl: 'https://oss.example/root.mp4', shotIndex: 2 })

describe('projectVersions', () => {
  it('原作是 V1；完成的合成不论片段什么形状，都按完成时刻接着编号，记着基于哪一版', () => {
    const versions = projectVersions(root, [
      composite('late', 'root', { createdAt: at('10:01:00'), finishedAt: at('10:09:00') }),
      composite('early', 'root', { createdAt: at('10:02:00'), finishedAt: at('10:03:00') }),
      // 来源可以分叉：基于 V2 再合成一版。
      composite('branch', 'early', { createdAt: at('10:04:00'), finishedAt: at('10:05:00') }),
      edit('e1', 'root', [1, 2], { outputUrl: 'https://oss.example/e1.mp4' }),
    ])

    expect(versions).toEqual([
      {
        jobId: 'root',
        label: 'V1',
        mediaUrl: 'https://oss.example/root.mp4',
        sourceJobId: undefined,
      },
      {
        jobId: 'early',
        label: 'V2',
        mediaUrl: 'https://oss.example/early.mp4',
        sourceJobId: 'root',
      },
      {
        jobId: 'branch',
        label: 'V3',
        mediaUrl: 'https://oss.example/branch.mp4',
        sourceJobId: 'early',
      },
      { jobId: 'late', label: 'V4', mediaUrl: 'https://oss.example/late.mp4', sourceJobId: 'root' },
    ])
  })

  it('在跑与失败的合成不算版本；缺完成时刻的按创建时刻排', () => {
    const versions = projectVersions(root, [
      composite('running', 'root', { status: 'submitting', outputUrl: null }),
      composite('failed', 'root', { status: 'failed', outputUrl: null }),
      composite('no-finish', 'root', { createdAt: at('10:01:00') }),
      composite('finished', 'root', { createdAt: at('09:00:00'), finishedAt: at('10:02:00') }),
    ])

    expect(versions.map((version) => version.jobId)).toEqual(['root', 'no-finish', 'finished'])
  })

  it('原作没出片就没有版本', () => {
    expect(projectVersions({ ...root, outputUrl: null }, [])).toEqual([])
  })
})

describe('一版名下的编辑段与合成', () => {
  const jobs = [
    edit('e2', 'root', [2, 3], { createdAt: at('10:05:00'), status: 'submitted' }),
    edit('e1', 'root', [1, 2], { createdAt: at('10:01:00') }),
    edit('other', 'm1', [0, 1], { createdAt: at('10:02:00') }),
    composite('m1', 'root', { createdAt: at('10:03:00'), finishedAt: at('10:04:00') }),
    composite('m2', 'root', { createdAt: at('10:06:00'), status: 'submitting', outputUrl: null }),
  ]

  it('编辑段只认来源是这一版的，按提交先后', () => {
    expect(editsOf(jobs, 'root').map((item) => item.id)).toEqual(['e1', 'e2'])
    expect(editsOf(jobs, 'm1').map((item) => item.id)).toEqual(['other'])
  })

  it('在跑的合成取这一版最近提交的那条', () => {
    expect(composingOf(jobs, 'root')?.id).toBe('m2')
    expect(composingOf(jobs, 'm1')).toBeUndefined()
  })

  it('重建只认这一版最近一次完成的合成之后提交的编辑段，之前的已经拼进去了', () => {
    expect(rebuildCandidates(jobs, 'root').map((item) => item.id)).toEqual(['e2'])
    expect(rebuildCandidates(jobs, 'm1').map((item) => item.id)).toEqual(['other'])
  })
})

describe('editCountsByRoot', () => {
  it('只数各根名下完成的编辑段：合成与失败的不算', () => {
    const jobs = [
      edit('e1', 'root', [0, 1], { outputUrl: 'x' }),
      edit('e2', 'm1', [0, 1], { outputUrl: 'y' }),
      edit('e3', 'root', [1, 2], { status: 'failed' }),
      composite('m1', 'root'),
    ]
    expect([...editCountsByRoot(jobs)]).toEqual([['root', 2]])
  })
})
