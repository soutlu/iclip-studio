import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import { VIDEO_CLIP_MODELS } from '@/testing/video-models'
import { submitClipGeneration } from './video-editor.api'

const modelById = (id: string) => {
  const model = VIDEO_CLIP_MODELS.find((item) => item.id === id)
  if (model === undefined) throw new Error(`缺少测试模型 ${id}`)
  return model
}

describe('submitClipGeneration', () => {
  const conversationId = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'
  const sourceJobId = '0d6b2f0e-1c4f-4a0e-9a2b-0f2f3a4b5c6d'
  let requests: string[]
  let edited: unknown

  beforeEach(() => {
    requests = []
    edited = undefined
    server.events.removeAllListeners('request:start')
    server.events.on('request:start', ({ request }) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
    })
    server.use(
      http.post('*/api/generations/video-edits', async ({ request }) => {
        edited = await request.json()
        return HttpResponse.json(
          { generation: makeGenerationJob({ status: 'pending', sourceJobId }) },
          { status: 202 },
        )
      }),
    )
  })

  it('编辑模式只提交生成方式与基底区间，不制作也不上传参考视频', async () => {
    await submitClipGeneration({
      conversationId,
      taskId: null,
      sourceJobId,
      generation: { mode: 'edit' },
      range: { start: 1.917, end: 6.5 },
      model: modelById('wan3.0-video'),
      prompt: '换成浅灰背景',
      referenceImageUrls: ['https://cdn.example.com/ref.png'],
    })

    expect(requests).toEqual(['POST /api/generations/video-edits'])
    expect(edited).toEqual({
      conversation_id: conversationId,
      task_id: null,
      source_job_id: sourceJobId,
      range_start_ms: 1917,
      range_end_ms: 6500,
      mode: 'edit',
      model: 'wan3.0-video',
      prompt: '换成浅灰背景',
      reference_image_urls: ['https://cdn.example.com/ref.png'],
    })
  })

  it.each(['vendor-a-seedance-2-5-flash', 'vendor-a-seedance-2-5', 'wan3.0-video'])(
    '%s 图生提交生成方式、正文图片与生成时长',
    async (id) => {
      await submitClipGeneration({
        conversationId,
        taskId: null,
        sourceJobId,
        range: { start: 2, end: 3 },
        model: modelById(id),
        prompt: '人物向前走两步',
        referenceImageUrls: ['https://cdn.example.com/ref.png'],
        generation: { mode: 'image', seconds: 5 },
      })

      expect(requests).toEqual(['POST /api/generations/video-edits'])
      expect(edited).toEqual({
        conversation_id: conversationId,
        task_id: null,
        source_job_id: sourceJobId,
        range_start_ms: 2000,
        range_end_ms: 3000,
        mode: 'image',
        model: id,
        prompt: '人物向前走两步',
        reference_image_urls: ['https://cdn.example.com/ref.png'],
        seconds: 5,
      })
    },
  )

  it.each([
    ['vendor-a-seedance-2-5-flash', 3],
    ['vendor-a-seedance-2-5-flash', 31],
    ['vendor-a-seedance-2-5-flash', 5.5],
    ['vendor-a-seedance-2-5', 3],
    ['vendor-a-seedance-2-5', 31],
    ['vendor-a-seedance-2-5', 5.5],
    ['wan3.0-video', 1],
    ['wan3.0-video', 31],
    ['wan3.0-video', 5.5],
  ])('%s 图生时长 %s 秒越界或不是整数时不发送请求', async (id, seconds) => {
    await expect(
      submitClipGeneration({
        conversationId,
        taskId: null,
        sourceJobId,
        range: { start: 2, end: 3 },
        model: modelById(id),
        prompt: '人物向前走两步',
        referenceImageUrls: ['https://cdn.example.com/ref.png'],
        generation: { mode: 'image', seconds },
      }),
    ).rejects.toThrow(/时长/)

    expect(requests).toEqual([])
    expect(edited).toBeUndefined()
  })

  it('图生没有正文图片时不发送请求', async () => {
    await expect(
      submitClipGeneration({
        conversationId,
        taskId: null,
        sourceJobId,
        range: { start: 2, end: 3 },
        model: modelById('vendor-a-seedance-2-5'),
        prompt: '人物向前走两步',
        referenceImageUrls: [],
        generation: { mode: 'image', seconds: 5 },
      }),
    ).rejects.toThrow('请在描述中引用至少一张图片')

    expect(requests).toEqual([])
    expect(edited).toBeUndefined()
  })

  it.each([
    ['vendor-a-seedance-2-5', 3.999],
    ['vendor-a-seedance-2-5', 30.001],
    ['wan3.0-video', 0.999],
    ['wan3.0-video', 15.001],
  ])('%s 编辑区间 %s 秒越界时不发送请求', async (id, seconds) => {
    await expect(
      submitClipGeneration({
        conversationId,
        taskId: null,
        sourceJobId,
        range: { start: 2, end: 2 + seconds },
        model: modelById(id),
        prompt: '人物向前走两步',
        referenceImageUrls: [],
        generation: { mode: 'edit' },
      }),
    ).rejects.toThrow(/至少|最多/)

    expect(requests).toEqual([])
    expect(edited).toBeUndefined()
  })

  it.each([
    { id: 'vendor-a-seedance-2-5', start: 0.1, end: 4.1 },
    { id: 'wan3.0-video', start: 1.1, end: 16.1 },
  ])('$id 的毫秒精度合法边界 $start–$end 秒不会被浮点误差拒绝', async ({ id, start, end }) => {
    await submitClipGeneration({
      conversationId,
      taskId: null,
      sourceJobId,
      range: { start, end },
      model: modelById(id),
      prompt: '保持人物造型',
      referenceImageUrls: [],
      generation: { mode: 'edit' },
    })

    expect(edited).toMatchObject({
      mode: 'edit',
      model: id,
      range_start_ms: Math.round(start * 1000),
      range_end_ms: Math.round(end * 1000),
    })
  })
})
