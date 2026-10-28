import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { groupConversationVideos } from '../conversation-videos/video-groups'
import type { GenerationJob } from '../storyboard.api'
import { materialCatalog } from '../whole-film/materials'
import {
  composingOf,
  editCountsByRoot,
  nextCompositeLabel,
  projectVersions,
  rootVersionGroup,
  unfinishedComposites,
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

/** 合成：来源是基底，镜号抄原作；请求里的片段不影响投影，给一份读不出来的也一样。 */
const composite = (id: string, base: string, spec: Partial<GenerationJob> = {}): GenerationJob =>
  job({
    id,
    operation: 'compose',
    rootJobId: 'root',
    sourceJobId: base,
    shotIndex: 2,
    request: { segments: 'not-a-list' },
    outputUrl: `https://oss.example/${id}.mp4`,
    ...spec,
  })

const root = job({ id: 'root', outputUrl: 'https://oss.example/root.mp4', shotIndex: 2 })

/** 只有这条原作时，整条的各版 */
const ownVersions = (chain: readonly GenerationJob[]) =>
  projectVersions(root, rootVersionGroup(root, chain, [root]))

describe('projectVersions', () => {
  it('原片与完成的合成一起按完成时刻编号，原片带「原片」二字，记着基于哪一版', () => {
    const versions = ownVersions([
      composite('late', 'root', { createdAt: at('10:01:00'), finishedAt: at('10:09:00') }),
      composite('early', 'root', { createdAt: at('10:02:00'), finishedAt: at('10:03:00') }),
      // 来源可以分叉：基于 V2 再合成一版。
      composite('branch', 'early', { createdAt: at('10:04:00'), finishedAt: at('10:05:00') }),
      edit('e1', 'root', [1, 2], { outputUrl: 'https://oss.example/e1.mp4' }),
    ])

    expect(versions).toEqual([
      {
        jobId: 'root',
        label: 'V1 原片',
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
    const versions = ownVersions([
      composite('running', 'root', { status: 'submitting', outputUrl: null }),
      composite('failed', 'root', { status: 'failed', outputUrl: null }),
      composite('no-finish', 'root', { createdAt: at('10:01:00') }),
      composite('finished', 'root', { createdAt: at('09:00:00'), finishedAt: at('10:02:00') }),
    ])

    expect(versions.map((version) => version.jobId)).toEqual(['root', 'no-finish', 'finished'])
  })

  it('原作没出片就没有版本', () => {
    const silent = { ...root, outputUrl: null }
    expect(projectVersions(silent, rootVersionGroup(silent, [], []))).toEqual([])
  })
})

describe('同一镜头组里有几条原作', () => {
  // 镜头组 2 里两条原作 A、B，完成先后交错：A、B、A 的合成、B 的合成。
  const takeA = job({ id: 'a', outputUrl: 'https://oss.example/a.mp4', shotIndex: 2 })
  const takeB = job({
    id: 'b',
    outputUrl: 'https://oss.example/b.mp4',
    shotIndex: 2,
    finishedAt: at('10:01:00'),
  })
  const compositeOf = (id: string, take: string, finish: string, spec = {}) =>
    composite(id, take, { rootJobId: take, shotIndex: 2, finishedAt: at(finish), ...spec })
  const a2 = compositeOf('a2', 'a', '10:02:00')
  const b2 = compositeOf('b2', 'b', '10:03:00')
  const conversation = [
    b2,
    a2,
    takeB,
    takeA,
    job({ id: 'other-shot', outputUrl: 'x', shotIndex: 3 }),
  ]

  it('整条只列本条原作的版本，编号沿用版本组，可以不连续', () => {
    const group = rootVersionGroup(takeB, [b2], conversation)

    expect(projectVersions(takeB, group).map((version) => version.label)).toEqual(['V2 原片', 'V4'])
  })

  it('再合成一版预计拿到组里下一个编号；未完成的合成依次占在前面', () => {
    const running = compositeOf('b3', 'b', '10:04:00', { status: 'submitted', outputUrl: null })
    const done = rootVersionGroup(takeB, [b2], conversation)
    const busy = rootVersionGroup(takeB, [b2, running], conversation)

    expect(nextCompositeLabel(done, [b2])).toBe('V5')
    expect(unfinishedComposites(busy, [b2, running]).map(({ label }) => label)).toEqual(['V5'])
    expect(nextCompositeLabel(busy, [b2, running])).toBe('V6')
  })

  it('本条原作的合成以编辑链为准：对话记录还没刷到完成也照样编号', () => {
    const stale = conversation.map((item) =>
      item.id === 'b2' ? { ...item, status: 'submitted' as const, outputUrl: null } : item,
    )

    const group = rootVersionGroup(takeB, [b2], stale)
    expect(projectVersions(takeB, group).map((version) => version.label)).toEqual(['V2 原片', 'V4'])
  })

  it('同一条素材片在成片素材区与编辑器里是同一个版本名', () => {
    const catalog = materialCatalog(groupConversationVideos(conversation))
    for (const take of [takeA, takeB]) {
      const chain = conversation.filter((item) => item.rootJobId === take.id)
      for (const version of projectVersions(take, rootVersionGroup(take, chain, conversation)))
        expect(catalog.byJob.get(version.jobId)?.version).toBe(version.label)
    }
    expect([...catalog.byJob.values()].map((item) => item.version)).toEqual([
      'V1 原片',
      'V3',
      'V2 原片',
      'V4',
      'V1 原片',
    ])
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

  it('在跑的合成取这一版最近提交的那条', () => {
    expect(composingOf(jobs, 'root')?.id).toBe('m2')
    expect(composingOf(jobs, 'm1')).toBeUndefined()
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
