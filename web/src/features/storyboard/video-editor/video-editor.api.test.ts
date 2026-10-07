import { QueryClient } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import {
  editTriggerOf,
  editableModels,
  pickEditModel,
  seedVideoEditJob,
  spliceSegments,
  submitVideoComposite,
  videoEditChainKey,
} from './video-editor.api'

describe('submitVideoComposite', () => {
  const conversationId = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'
  const baseJobId = '0d6b2f0e-1c4f-4a0e-9a2b-0f2f3a4b5c6d'
  const editJobId = '7e1c3a9b-2d4f-4b1e-8c3d-1f2e3a4b5c6d'

  it.each([
    [
      '从中间改起：基底前段、编辑段整条、基底后段，毫秒换成秒',
      { rangeStartMs: 1500, rangeEndMs: 4250 },
      [
        { sourceJobId: baseJobId, start: 0, end: 1.5 },
        { sourceJobId: editJobId, start: 0 },
        { sourceJobId: baseJobId, start: 4.25 },
      ],
    ],
    [
      '从头改起没有前段',
      { rangeStartMs: 0, rangeEndMs: 3000 },
      [
        { sourceJobId: editJobId, start: 0 },
        { sourceJobId: baseJobId, start: 3 },
      ],
    ],
  ])('%s', async (_name, range, segments) => {
    let body: unknown
    const accepted = makeGenerationJob({
      operation: 'compose',
      status: 'pending',
      sourceJobId: baseJobId,
    })
    server.use(
      http.post('*/api/generations/video-composites', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ generation: accepted }, { status: 202 })
      }),
    )

    const result = await submitVideoComposite({
      conversationId,
      taskId: null,
      baseJobId,
      segments: spliceSegments({ baseJobId, editJobId, ...range }),
    })

    expect(body).toEqual({ conversationId, taskId: null, baseJobId, segments })
    expect(result.id).toBe(accepted.id)
  })
})

describe('seedVideoEditJob', () => {
  const conversationId = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'
  const chainKey = videoEditChainKey(conversationId, 'root-job')
  const segment = makeGenerationJob({
    status: 'pending',
    rootJobId: 'root-job',
    sourceJobId: 'root-job',
    rangeStartMs: 0,
    rangeEndMs: 2000,
  })

  it('这条链还没读过就只有这一条', () => {
    const queryClient = new QueryClient()

    seedVideoEditJob(queryClient, conversationId, 'root-job', segment)

    expect(queryClient.getQueryData(chainKey)).toEqual({ items: [segment] })
  })

  it('放进这条链最前面、同一条替换不重复，并失效本对话全部编辑链', () => {
    const queryClient = new QueryClient()
    const earlier = makeGenerationJob()
    const otherChain = videoEditChainKey(conversationId, 'other-root')
    queryClient.setQueryData(chainKey, { items: [segment, earlier] })
    queryClient.setQueryData(otherChain, { items: [] })
    const accepted = { ...segment, status: 'submitted' as const }

    seedVideoEditJob(queryClient, conversationId, 'root-job', accepted)

    expect(queryClient.getQueryData(chainKey)).toEqual({ items: [accepted, earlier] })
    expect(queryClient.getQueryState(otherChain)?.isInvalidated).toBe(true)
  })
})

describe('编辑器用哪个模型', () => {
  const models = ['vendor-a-seedance-2-5', 'wan3.0-video']

  it.each([
    ['选过的还在允许表里就用它', 'wan3.0-video', 'vendor-a-seedance-2-5', 'wan3.0-video'],
    ['选过的不在了退回默认', 'gone-model', 'vendor-a-seedance-2-5', 'vendor-a-seedance-2-5'],
    [
      '默认模型不支持编辑就取第一个支持的',
      undefined,
      'vendor-a-seedance-2-0',
      'vendor-a-seedance-2-5',
    ],
  ])('%s', (_name, wanted, fallback, expected) => {
    expect(pickEditModel(models, wanted, fallback)).toBe(expected)
  })

  it('一个都没有就没有模型', () => {
    expect(pickEditModel([], 'x', 'y')).toBeUndefined()
  })
})

describe('模型怎么触发编辑，按名字认', () => {
  it('Seedance 2.5 走 provider_options 开关，网关的两种前缀都认', () => {
    expect(editTriggerOf('vendor-a-seedance-2-5')).toEqual({
      providerOptions: { omni_reference_task_type: 'edit' },
    })
    expect(editTriggerOf('vendor-b-seedance-2-5')).toEqual(editTriggerOf('vendor-a-seedance-2-5'))
  })

  it('万相 3.0 靠正文前缀', () => {
    expect(editTriggerOf('wan3.0-video-prime')).toEqual({ promptPrefix: '编辑视频，' })
  })

  it('不认识的模型做不了编辑，下拉里不列', () => {
    expect(editTriggerOf('vendor-a-seedance-2-0')).toBeUndefined()
    expect(
      editableModels(['vendor-a-seedance-2-0', 'vendor-a-seedance-2-5', 'wan3.0-video']),
    ).toEqual(['vendor-a-seedance-2-5', 'wan3.0-video'])
  })
})
