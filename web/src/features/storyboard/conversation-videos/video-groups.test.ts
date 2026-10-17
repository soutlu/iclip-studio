import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import { groupConversationVideos } from './video-groups'

const job = (id: string, overrides: Partial<GenerationJob> = {}): GenerationJob =>
  makeGenerationJob({
    id,
    outputUrl: `${id}.mp4`,
    shotIndex: 1,
    createdAt: '2026-09-01T10:00:00Z',
    ...overrides,
  })

/** 基于 `source` 拼出来的合成，镜号抄原作。 */
const composite = (id: string, source: string, overrides: Partial<GenerationJob> = {}) =>
  job(id, { operation: 'compose', rootJobId: source, sourceJobId: source, ...overrides })

const ids = (groups: ReturnType<typeof groupConversationVideos>) =>
  groups.map((group) => group.videos.map((video) => video.id))

describe('groupConversationVideos', () => {
  it('只收成片：完成、有地址的出片与有基底的合成；图片、编辑段、在途与失败的都不算', () => {
    const groups = groupConversationVideos([
      job('original'),
      job('image', { kind: 'image' }),
      job('failed', { status: 'failed' }),
      job('submitted', { status: 'submitted' }),
      job('empty', { outputUrl: null }),
      job('blank', { outputUrl: '  ' }),
      // 镜号照样落在这一组上，靠来源认出它不是出片。
      job('edited', {
        rootJobId: 'original',
        sourceJobId: 'original',
        rangeStartMs: 0,
        rangeEndMs: 3000,
      }),
      composite('composite', 'original', { createdAt: '2026-09-01T10:05:00Z' }),
      composite('composing', 'original', { status: 'submitted', outputUrl: null }),
    ])

    expect(ids(groups)).toEqual([['original', 'composite']])
  })

  it('按镜号归组排序，组内按完成时刻从旧到新，缺完成时刻按创建时刻，同刻按 id', () => {
    const records = [
      job('second-shot', { shotIndex: 2 }),
      job('c', { createdAt: '2026-09-01T09:00:00Z', finishedAt: '2026-09-01T12:00:00Z' }),
      job('b', { createdAt: '2026-09-01T11:00:00Z' }),
      job('a', { createdAt: '2026-09-01T11:00:00Z' }),
      composite('d', 'a', { finishedAt: '2026-09-01T11:30:00Z' }),
    ]
    const groups = groupConversationVideos(records)

    expect(groups.map((group) => group.label)).toEqual(['镜头组 1', '镜头组 2'])
    expect(groups[0]?.videos.map((video) => video.id)).toEqual(['a', 'b', 'd', 'c'])
    expect(groupConversationVideos(records.toReversed())).toEqual(groups)
  })

  it('没有镜号的出片各自一组，同原作的合成跟着它', () => {
    const groups = groupConversationVideos([
      job('a', { shotIndex: null }),
      job('b', { shotIndex: null, createdAt: '2026-09-01T10:01:00Z' }),
      composite('a2', 'a', { shotIndex: null, createdAt: '2026-09-01T10:02:00Z' }),
    ])

    expect(groups.map((group) => group.label)).toEqual(['视频 1', '视频 2'])
    expect(ids(groups)).toEqual([['a', 'a2'], ['b']])
  })
})
