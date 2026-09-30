import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from './storyboard.api'
import { takeActionsOf, takeCardSize, takesOfShot } from './takes'

const job = (spec: Partial<GenerationJob> & { id: string }): GenerationJob =>
  makeGenerationJob({ createdAt: '2026-09-01T10:00:00Z', shotIndex: 2, ...spec })

const HISTORY_SHOT = {
  global_settings: '保持一致。',
  timeline: [{ image_indexes: [1], prompt: '走向镜头 @Image1。', timestamps: [0, 4] }],
}

describe('takesOfShot', () => {
  it('只挑本组出片（排除图片、其它组、编辑段与合成），按提交时间从新到旧，不管接口给的顺序', () => {
    const jobs = [
      job({ createdAt: '2026-09-01T10:04:00Z', id: 'a', outputUrl: 'a.mp4' }),
      job({ createdAt: '2026-09-01T12:20:00Z', id: 'c', status: 'submitted' }),
      job({ createdAt: '2026-09-01T09:00:00Z', id: 'other-shot', shotIndex: 3 }),
      job({ createdAt: '2026-09-01T11:40:00Z', id: 'b', status: 'failed' }),
      job({ createdAt: '2026-09-01T13:00:00Z', id: 'image', kind: 'image', shotIndex: null }),
      job({ id: 'edited', outputUrl: 'edited.mp4', rootJobId: 'a', sourceJobId: 'a' }),
      job({ id: 'composite', operation: 'compose', rootJobId: 'a', sourceJobId: 'edited' }),
    ]
    expect(takesOfShot(jobs, 2, '9:16').map((take) => take.job.id)).toEqual(['c', 'b', 'a'])
  })

  it.each([
    { expected: 'running', status: 'pending' },
    { expected: 'running', status: 'submitting' },
    { expected: 'running', status: 'submitted' },
    { expected: 'completed', status: 'completed' },
    { expected: 'failed', status: 'failed' },
  ] as const)('状态 $status 画成 $expected', ({ expected, status }) => {
    expect(takesOfShot([job({ id: 'x', status })], 2, '9:16')[0]?.state).toBe(expected)
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

  it('角标取值：分辨率与模型读请求原样，片长读实测，编辑次数数成功的编辑；缺了就是 undefined', () => {
    const [full, bare] = takesOfShot(
      [
        job({
          createdAt: '2026-09-01T10:05:00Z',
          durationMs: 11_000,
          id: 'full',
          outputUrl: 'full.mp4',
          request: { model: 'vendor-a-seedance-2-5', resolution: '1080p' },
        }),
        // 空白的模型名与缺失同样算没记；请求秒数不拿来充片长。
        job({ id: 'bare', outputUrl: 'bare.mp4', request: { model: '  ', seconds: 6 } }),
        ...['edit-1', 'edit-2'].map((id) =>
          job({ id, rangeEndMs: 3000, rangeStartMs: 0, rootJobId: 'full', sourceJobId: 'full' }),
        ),
        // 还在跑的编辑不算。
        job({
          id: 'edit-running',
          rangeEndMs: 3000,
          rangeStartMs: 0,
          rootJobId: 'full',
          sourceJobId: 'full',
          status: 'submitted',
        }),
      ],
      2,
      '9:16',
    )
    expect(full).toMatchObject({
      durationSeconds: 11,
      editCount: 2,
      model: 'vendor-a-seedance-2-5',
      resolution: '1080p',
    })
    expect(bare).toMatchObject({
      durationSeconds: undefined,
      editCount: 0,
      model: undefined,
      resolution: undefined,
    })
  })

  it('画幅读请求，请求里没有就用分镜的', () => {
    const takes = takesOfShot(
      [
        job({ createdAt: '2026-09-01T10:05:00Z', id: 'wide', request: { aspect_ratio: '16:9' } }),
        job({ createdAt: '2026-09-01T10:04:00Z', id: 'unset', request: {} }),
      ],
      2,
      '1:1',
    )
    expect(takes.map((take) => take.aspect)).toEqual([
      { h: 9, w: 16 },
      { h: 1, w: 1 },
    ])
  })

  it('带结构化 shot 的记录能回填，只有正文的不能；失败带服务端原话', () => {
    const [structured, textOnly, failed] = takesOfShot(
      [
        job({
          createdAt: '2026-09-01T10:05:00Z',
          id: 'structured',
          request: { prompt: '拼好的正文', shot: HISTORY_SHOT },
        }),
        job({ createdAt: '2026-09-01T10:04:00Z', id: 'text', request: { prompt: '只有正文。' } }),
        job({
          createdAt: '2026-09-01T10:03:00Z',
          errorMessage: '上游返回了空结果。',
          id: 'failed',
          status: 'failed',
        }),
      ],
      2,
      '9:16',
    )
    expect(structured?.history).toEqual(HISTORY_SHOT)
    expect(textOnly?.history).toBeUndefined()
    expect(failed?.error).toBe('上游返回了空结果。')
    expect(structured?.error).toBeUndefined()
  })
})

describe('takeActionsOf', () => {
  const take = (spec: Partial<GenerationJob>) => {
    const [only] = takesOfShot([job({ id: 'x', ...spec })], 2, '9:16')
    if (only === undefined) throw new Error('缺成片')
    return only
  }
  const enabled = { kind: 'enabled' }
  const hidden = { kind: 'hidden' }
  const blocked = (reason: string) => ({ kind: 'blocked', reason })
  const refillBlocked = blocked('这条出片没记分镜结构，回填不了')

  it.each([
    {
      expected: { download: enabled, editVideo: enabled, refill: enabled },
      spec: { outputUrl: 'take.mp4', request: { shot: HISTORY_SHOT } },
      when: '成功且记了镜头组：三样都能用',
    },
    {
      expected: { download: enabled, editVideo: enabled, refill: refillBlocked },
      spec: { outputUrl: 'take.mp4', request: { prompt: '只有正文。' } },
      when: '成功但只有正文：回填置灰，下载与编辑照旧',
    },
    {
      expected: { download: hidden, editVideo: hidden, refill: enabled },
      spec: { request: { shot: HISTORY_SHOT }, status: 'submitted' as const },
      when: '在途：只有回填',
    },
    {
      expected: {
        download: blocked('生成失败，没有视频可下载'),
        editVideo: blocked('生成失败，没有视频可编辑'),
        refill: enabled,
      },
      spec: { request: { shot: HISTORY_SHOT }, status: 'failed' as const },
      when: '失败：下载与编辑置灰说原因，回填照旧',
    },
    {
      expected: {
        download: blocked('没有返回视频地址'),
        editVideo: blocked('没有返回视频地址'),
        refill: refillBlocked,
      },
      spec: { outputUrl: '  ' },
      when: '成功却没给地址：下载与编辑置灰',
    },
  ])('$when', ({ expected, spec }) => {
    expect(takeActionsOf(take(spec), { readOnly: false })).toEqual(expected)
  })

  it('只读时没有编辑视频与回填，下载照旧', () => {
    const completed = take({ outputUrl: 'take.mp4', request: { shot: HISTORY_SHOT } })
    expect(takeActionsOf(completed, { readOnly: true })).toEqual({
      download: enabled,
      editVideo: hidden,
      refill: hidden,
    })
  })
})

describe('takeCardSize', () => {
  it.each([
    {
      aspect: { h: 16, w: 9 },
      expected: { height: 176, width: 99 },
      visible: 400,
      when: '竖屏按行高',
    },
    {
      aspect: { h: 1, w: 1 },
      expected: { height: 176, width: 176 },
      visible: 300,
      when: '方形不封顶',
    },
    {
      aspect: { h: 9, w: 16 },
      expected: { height: 176, width: 313 },
      visible: 800,
      when: '横屏没超 48%',
    },
    // 可见 400 的 48% 是 192，等比缩到 192 × 108。
    {
      aspect: { h: 9, w: 16 },
      expected: { height: 108, width: 192 },
      visible: 400,
      when: '横屏超了等比缩',
    },
    {
      aspect: { h: 9, w: 21 },
      expected: { height: 176, width: 411 },
      visible: 0,
      when: '还没量出宽度时不封顶',
    },
  ])('$when', ({ aspect, expected, visible }) => {
    expect(takeCardSize(aspect, visible)).toEqual(expected)
  })
})
