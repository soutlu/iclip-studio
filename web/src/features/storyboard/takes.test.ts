import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from './storyboard.api'
import { takesOfShot } from './takes'

const job = (spec: Partial<GenerationJob> & { id: string }): GenerationJob =>
  makeGenerationJob({ createdAt: '2026-09-01T10:00:00Z', shotIndex: 2, ...spec })

describe('takesOfShot', () => {
  it('只挑本组出片（排除图片、其它组、编辑段与合成），按提交时间从新到旧，不管接口给的顺序', () => {
    const jobs = [
      job({ createdAt: '2026-09-01T10:04:00Z', id: 'a', outputUrl: 'a.mp4' }),
      job({ createdAt: '2026-09-01T12:20:00Z', id: 'c', status: 'submitted' }),
      job({ createdAt: '2026-09-01T09:00:00Z', id: 'other-shot', shotIndex: 3 }),
      job({ createdAt: '2026-09-01T11:40:00Z', id: 'b', status: 'failed' }),
      job({ createdAt: '2026-09-01T13:00:00Z', id: 'image', kind: 'image', shotIndex: null }),
      job({ id: 'edited', outputUrl: 'edited.mp4', rootJobId: 'a', sourceJobId: 'a' }),
      job({ id: 'composite', operation: 'compose', rootJobId: 'a', sourceJobId: 'a' }),
    ]
    expect(takesOfShot(jobs, 2, '9:16').map((take) => take.job.id)).toEqual(['c', 'b', 'a'])
  })

  it('只有成功且地址不空的出片可播可编辑', () => {
    const takes = takesOfShot(
      [
        job({ createdAt: '2026-09-01T10:05:00Z', id: 'ok', outputUrl: 'take.mp4' }),
        job({
          createdAt: '2026-09-01T10:04:00Z',
          id: 'running',
          outputUrl: 'x.mp4',
          status: 'submitted',
        }),
        job({
          createdAt: '2026-09-01T10:03:00Z',
          id: 'failed',
          outputUrl: 'x.mp4',
          status: 'failed',
        }),
        job({ createdAt: '2026-09-01T10:02:00Z', id: 'no-url', outputUrl: null }),
        job({ createdAt: '2026-09-01T10:01:00Z', id: 'blank-url', outputUrl: '  ' }),
      ],
      2,
      '9:16',
    )
    expect(takes.map((take) => [take.job.id, take.outputUrl])).toEqual([
      ['ok', 'take.mp4'],
      ['running', undefined],
      ['failed', undefined],
      ['no-url', undefined],
      ['blank-url', undefined],
    ])
  })

  it('卡显示这条出片最新完成的合成：地址与片长都取它；在跑、失败、没地址的合成与别的出片的合成不算；合成不成卡、卡序不变', () => {
    const composite = (spec: Partial<GenerationJob> & { id: string }) =>
      job({ operation: 'compose', rootJobId: 'a', sourceJobId: 'a', ...spec })
    const jobs = [
      // 提交晚、完成早：按完成时刻排在 v3 前面。
      composite({
        createdAt: '2026-09-01T10:30:00Z',
        durationMs: 9000,
        finishedAt: '2026-09-01T10:35:00Z',
        id: 'a-slow',
        outputUrl: 'a-slow.mp4',
      }),
      job({
        createdAt: '2026-09-01T09:00:00Z',
        durationMs: 12_000,
        finishedAt: '2026-09-01T09:02:00Z',
        id: 'a',
        outputUrl: 'a.mp4',
        request: { model: 'vendor-a-seedance-2-5', resolution: '1080p' },
      }),
      composite({
        createdAt: '2026-09-01T10:10:00Z',
        durationMs: 8000,
        finishedAt: '2026-09-01T10:12:00Z',
        id: 'a-v2',
        outputUrl: 'a-v2.mp4',
      }),
      // 基于上一版合成再剪的：来源是 a-v2，原作仍是 a。
      composite({
        createdAt: '2026-09-01T10:20:00Z',
        durationMs: 7000,
        finishedAt: '2026-09-01T10:40:00Z',
        id: 'a-v3',
        outputUrl: 'a-v3.mp4',
        sourceJobId: 'a-v2',
      }),
      composite({ createdAt: '2026-09-01T11:00:00Z', id: 'a-running', status: 'submitted' }),
      composite({
        createdAt: '2026-09-01T11:10:00Z',
        finishedAt: '2026-09-01T11:15:00Z',
        id: 'a-failed',
        outputUrl: 'a-failed.mp4',
        status: 'failed',
      }),
      composite({ finishedAt: '2026-09-01T11:20:00Z', id: 'a-no-url', outputUrl: '  ' }),
      job({ createdAt: '2026-09-01T09:30:00Z', id: 'b', outputUrl: 'b.mp4' }),
      composite({
        durationMs: 5000,
        finishedAt: '2026-09-01T12:00:00Z',
        id: 'b-v2',
        outputUrl: 'b-v2.mp4',
        rootJobId: 'b',
        sourceJobId: 'b',
      }),
      job({ createdAt: '2026-09-01T09:45:00Z', durationMs: 6000, id: 'c', outputUrl: 'c.mp4' }),
    ]
    const takes = takesOfShot(jobs, 2, '9:16')
    expect(
      takes.map((take) => [take.job.id, take.shown.id, take.outputUrl, take.durationSeconds]),
    ).toEqual([
      ['c', 'c', 'c.mp4', 6],
      ['b', 'b-v2', 'b-v2.mp4', 5],
      ['a', 'a-v3', 'a-v3.mp4', 7],
    ])
    // 卡上其余几样仍读出片本身。
    expect(takes[2]).toMatchObject({
      model: 'vendor-a-seedance-2-5',
      resolution: '1080p',
      state: 'completed',
    })
  })
})
