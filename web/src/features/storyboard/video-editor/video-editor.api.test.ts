import { QueryClient } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { errorMessageOf, UserFacingError } from '@/shared/api/client'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import {
  editTriggerOf,
  editableModels,
  pickEditModel,
  seedVideoEditJob,
  spliceSegments,
  submitVideoComposite,
  submitVideoEdit,
  videoEditChainKey,
} from './video-editor.api'

/** mediabunny 的替身：不解码，只按 `media` 里写好的关键帧表与时长回答，记下切了哪一段。 */
const media = vi.hoisted(() => ({
  keyframes: [] as number[],
  duration: 0,
  discarded: [] as { reason: string }[],
  events: [] as string[],
  sources: [] as string[],
  trims: [] as unknown[],
  disposed: 0,
}))

vi.mock('mediabunny', () => {
  type Packet = { timestamp: number }
  class UrlSource {
    constructor(url: string) {
      media.sources.push(url)
    }
  }
  class Input {
    getPrimaryVideoTrack = () => Promise.resolve({})
    computeDuration = () => Promise.resolve(media.duration)
    dispose = () => {
      media.disposed += 1
    }
  }
  class EncodedPacketSink {
    getFirstKeyPacket = () => Promise.resolve(this.at(0))
    getNextKeyPacket = (packet: Packet) =>
      Promise.resolve(this.at(media.keyframes.indexOf(packet.timestamp) + 1))
    private at = (index: number): Packet | null => {
      const timestamp = media.keyframes[index]
      return timestamp === undefined ? null : { timestamp }
    }
  }
  class BufferTarget {
    buffer: ArrayBuffer | null = null
  }
  class Output {
    target: BufferTarget
    constructor(options: { target: BufferTarget }) {
      this.target = options.target
    }
  }
  class Mp4OutputFormat {}
  const Conversion = {
    init: (options: { output: Output; trim: unknown }) => {
      media.trims.push(options.trim)
      return Promise.resolve({
        isValid: media.discarded.length === 0,
        discardedTracks: media.discarded,
        execute: () => {
          media.events.push('cut')
          // 只要像个 MP4 就行：ftyp 盒子开头。
          options.output.target.buffer = new TextEncoder().encode('\0\0\0\x18ftypisom').buffer
          return Promise.resolve()
        },
      })
    },
  }
  return {
    BufferTarget,
    Conversion,
    EncodedPacketSink,
    Input,
    MP4: {},
    Mp4OutputFormat,
    Output,
    QTFF: {},
    UrlSource,
  }
})

describe('submitVideoEdit', () => {
  const conversationId = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'
  const sourceJobId = '0d6b2f0e-1c4f-4a0e-9a2b-0f2f3a4b5c6d'
  const baseMediaUrl = 'https://oss.example.com/take.mp4'
  const uploadId = '5a1d8c2e-7b3f-4c9d-8e1a-2b3c4d5e6f70'
  const uploadUrl = `http://localhost/mock-oss/${uploadId}`
  const clipUrl = `https://oss.example.com/iclip/agent/uploads/${uploadId}.mp4`
  let signed: unknown
  let edited: unknown

  beforeEach(() => {
    Object.assign(media, {
      // 24fps 的模型出片：关键帧在镜头切点上，间隔不等。
      keyframes: [0, 1.916667, 4.208333, 6.5],
      duration: 8.042,
      discarded: [],
      events: [],
      sources: [],
      trims: [],
      disposed: 0,
    })
    signed = undefined
    edited = undefined
    server.events.removeAllListeners('request:start')
    server.events.on('request:start', ({ request }) => {
      media.events.push(`${request.method} ${new URL(request.url).pathname}`)
    })
    server.use(
      http.post('*/api/uploads/sign', async ({ request }) => {
        signed = await request.json()
        return HttpResponse.json({
          uploadId,
          upload: {
            expiresAt: '2026-10-07T12:00:00Z',
            headers: { 'Content-Type': 'video/mp4' },
            url: uploadUrl,
          },
        })
      }),
      http.put(uploadUrl, () => new HttpResponse(null, { status: 200 })),
      http.post('*/api/uploads/:uploadId/confirm', () =>
        HttpResponse.json({ contentType: 'video/mp4', sizeBytes: 16, url: clipUrl }),
      ),
      http.post('*/api/generations/video-edits', async ({ request }) => {
        edited = await request.json()
        return HttpResponse.json(
          { generation: makeGenerationJob({ status: 'pending', sourceJobId }) },
          { status: 202 },
        )
      }),
    )
  })

  const submit = () =>
    submitVideoEdit({
      conversationId,
      taskId: null,
      sourceJobId,
      baseMediaUrl,
      // 选段落在关键帧之间：起点退到 1.916667，终点进到 6.5。
      range: { start: 2.5, end: 5 },
      model: 'wan3.0-video',
      prompt: '换成浅灰背景',
      referenceImageUrls: ['https://cdn.example.com/ref.png'],
    })

  it('先在基底上按关键帧切片，再传上去，最后带着片段地址与吸附后的区间提交编辑', async () => {
    await submit()

    expect(media.events).toEqual([
      'cut',
      'POST /api/uploads/sign',
      `PUT /mock-oss/${uploadId}`,
      `POST /api/uploads/${uploadId}/confirm`,
      'POST /api/generations/video-edits',
    ])
    expect(media.sources).toEqual([baseMediaUrl])
    expect(media.trims).toEqual([{ start: 1.916667, end: 6.5 }])
    expect(signed).toEqual({ contentType: 'video/mp4', height: null, width: null })
    expect(edited).toEqual({
      conversation_id: conversationId,
      task_id: null,
      source_job_id: sourceJobId,
      // 吸附后的秒数四舍五入到毫秒。
      range_start_ms: 1917,
      range_end_ms: 6500,
      reference_video_urls: [clipUrl],
      model: 'wan3.0-video',
      prompt: '编辑视频，换成浅灰背景',
      reference_image_urls: ['https://cdn.example.com/ref.png'],
      seconds: -1,
    })
    expect(media.disposed).toBe(1)
  })

  it('有轨道拷不进 MP4 就报错，不转码、不上传、不提交', async () => {
    media.discarded = [{ reason: 'cannot_copy' }]

    const error = await submit().then(
      () => undefined,
      (reason: unknown) => reason,
    )

    expect(error).toBeInstanceOf(UserFacingError)
    expect(errorMessageOf(error, '兜底')).toBe('参考片段没切出来，请稍后重试')
    expect(media.events).toEqual([])
    expect(media.disposed).toBe(1)
  })
})

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
