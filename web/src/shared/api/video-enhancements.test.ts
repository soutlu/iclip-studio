import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { enhanceBadge, enhanceTierRows, type EnhanceTierRow } from './video-enhancements'

const running: EnhanceTierRow = {
  resolution: '1080p',
  since: '2026-10-20T09:00:00Z',
  state: 'running',
}
const none: EnhanceTierRow = { resolution: '1080p', state: 'none' }
const done = (jobId: string, mine = true): EnhanceTierRow => ({
  jobId,
  mine,
  resolution: '1080p',
  state: 'done',
  url: 'https://downloads.example.test/hd.mp4',
})
const failed = (jobId: string, mine = true): EnhanceTierRow => ({
  jobId,
  mine,
  resolution: '720p',
  state: 'failed',
})

const NOTHING_SEEN: ReadonlySet<string> = new Set()

describe('enhanceBadge', () => {
  it.each([
    {
      expected: 'running',
      name: '有一档在做，压过没看过的失败与完成',
      rows: [running, failed('f')],
    },
    { expected: 'failed', name: '没在做的：没看过的失败压过完成', rows: [done('d'), failed('f')] },
    { expected: 'done', name: '只有没看过的完成', rows: [done('d'), none] },
    { expected: null, name: '都没做', rows: [none, none] },
    { expected: null, name: '没有档', rows: [] },
  ] as const)('$name → $expected', ({ expected, rows }) => {
    expect(enhanceBadge(rows, NOTHING_SEEN)).toBe(expected)
  })

  it('别人的记录：在做照样转圈，做好、没做成都不出点', () => {
    expect(enhanceBadge([{ ...running }, done('d', false)], NOTHING_SEEN)).toBe('running')
    expect(enhanceBadge([done('d', false), failed('f', false)], NOTHING_SEEN)).toBeNull()
  })

  it('看过的不出点；看过失败、没看过完成时出完成的点', () => {
    expect(enhanceBadge([done('d'), failed('f')], new Set(['d', 'f']))).toBeNull()
    expect(enhanceBadge([done('d'), failed('f')], new Set(['f']))).toBe('done')
  })
})

describe('enhanceTierRows', () => {
  it('有结果的档带上记录 id 与 mine；完成却没有地址按没做成算', () => {
    const ok = makeGenerationJob({ outputUrl: 'https://downloads.example.test/hd.mp4' })
    const empty = makeGenerationJob({ outputUrl: null })
    expect(
      enhanceTierRows(
        [
          { job: ok, mine: true, resolution: '1080p' },
          { job: empty, mine: false, resolution: '720p' },
        ],
        [],
      ),
    ).toEqual([
      { jobId: ok.id, mine: true, resolution: '1080p', state: 'done', url: ok.outputUrl },
      { jobId: empty.id, mine: false, resolution: '720p', state: 'failed' },
    ])
  })
})
