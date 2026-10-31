import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { errorMessageOf, UserFacingError } from '@/shared/api/client'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import { VIDEO_CLIP_MODELS } from '@/testing/video-models'
import { submitClipGeneration } from './video-editor.api'

const modelById = (id: string) => {
  const model = VIDEO_CLIP_MODELS.find((item) => item.id === id)
  if (model === undefined) throw new Error(`缺少测试模型 ${id}`)
  return model
}

/** 一块解出来的音频：从 `timestamp` 秒起，各声道的样本。 */
type FakeAudio = { timestamp: number; sampleRate: number; channels: number[][] }

/** mediabunny 边界替身：提供媒体样本，记录裁剪范围与送入编码器的时钟，不执行真实编解码。 */
const media = vi.hoisted(() => ({
  keyframes: [] as number[],
  duration: 0,
  /** `null` 是没有音轨，`'undecodable'` 是有音轨却解不了。 */
  audio: null as FakeAudio[] | null | 'undecodable',
  failEncoding: false,
  events: [] as string[],
  sources: [] as string[],
  trims: [] as { mediaUrl: string; start: number; end: number }[],
  videoSamples: [] as { timestamp: number; duration: number }[],
  disposed: 0,
}))

vi.mock('mediabunny', () => {
  type Packet = { timestamp: number }
  class UrlSource {
    readonly url: string
    constructor(url: string) {
      this.url = url
      media.sources.push(url)
    }
  }
  class VideoTrack {
    readonly url: string
    constructor(url: string) {
      this.url = url
    }
    canDecode = () => Promise.resolve(true)
    computeDuration = () => Promise.resolve(media.duration)
    getDisplayWidth = () => Promise.resolve(1280)
    getDisplayHeight = () => Promise.resolve(720)
  }
  class Input {
    private source: UrlSource
    constructor(options: { source: UrlSource }) {
      this.source = options.source
    }
    getPrimaryVideoTrack = () => Promise.resolve(new VideoTrack(this.source.url))
    getPrimaryAudioTrack = () =>
      Promise.resolve(
        media.audio === null
          ? null
          : { canDecode: () => Promise.resolve(media.audio !== 'undecodable') },
      )
    computeDuration = () => Promise.resolve(media.duration)
    dispose = () => {
      media.disposed += 1
    }
  }
  class AudioSampleSink {
    async *samples() {
      for (const block of Array.isArray(media.audio) ? media.audio : []) {
        yield {
          timestamp: block.timestamp,
          sampleRate: block.sampleRate,
          numberOfFrames: block.channels[0]?.length ?? 0,
          numberOfChannels: block.channels.length,
          copyTo: (target: Float32Array, options: { planeIndex: number }) =>
            target.set(block.channels[options.planeIndex] ?? []),
          close: () => {},
        }
      }
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
  class VideoSampleSink {
    private track: VideoTrack
    constructor(track: VideoTrack) {
      this.track = track
    }
    async *samples(start: number, end: number) {
      media.trims.push({ mediaUrl: this.track.url, start, end })
      yield {
        timestamp: start,
        duration: end - start,
        setTimestamp(value: number) {
          this.timestamp = value
        },
        setDuration(value: number) {
          this.duration = value
        },
        close: () => {},
      }
    }
  }
  class VideoSampleSource {
    add = (sample: { timestamp: number; duration: number }) => {
      if (media.failEncoding) throw new Error('video encoder failed')
      media.videoSamples.push({ timestamp: sample.timestamp, duration: sample.duration })
      return Promise.resolve()
    }
    close = () => {}
  }
  class Output {
    target: BufferTarget
    state = 'pending'
    constructor(options: { target: BufferTarget }) {
      this.target = options.target
    }
    addVideoTrack = () => {}
    start = () => {
      this.state = 'started'
      return Promise.resolve()
    }
    finalize = () => {
      media.events.push('encode')
      this.target.buffer = new TextEncoder().encode('\0\0\0\x18ftypisom').buffer
      this.state = 'finalized'
      return Promise.resolve()
    }
    cancel = () => {
      this.state = 'canceled'
      return Promise.resolve()
    }
  }
  class AudioSample {}
  class AudioSampleSource {}
  class Mp4OutputFormat {}
  class Quality {}
  return {
    AudioSample,
    AudioSampleSink,
    AudioSampleSource,
    BufferTarget,
    canEncodeAudio: () => Promise.resolve(true),
    canEncodeVideo: () => Promise.resolve(true),
    EncodedPacketSink,
    Input,
    MP4: {},
    Mp4OutputFormat,
    Output,
    QTFF: {},
    Quality,
    UrlSource,
    VideoSampleSink,
    VideoSampleSource,
  }
})

describe('submitClipGeneration', () => {
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
      audio: null,
      failEncoding: false,
      events: [],
      sources: [],
      trims: [],
      videoSamples: [],
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
    submitClipGeneration({
      conversationId,
      taskId: null,
      sourceJobId,
      generation: {
        mode: 'edit',
        referenceClips: [{ mediaUrl: baseMediaUrl, start: 1.917, end: 6.5 }],
      },
      // 两端正好是基底的关键帧（取整到毫秒的读数）。
      range: { start: 1.917, end: 6.5 },
      model: modelById('wan3.0-video'),
      prompt: '换成浅灰背景',
      referenceImageUrls: ['https://cdn.example.com/ref.png'],
    })

  it('先编码选用的参考片段，再上传，最后带着参考地址与基底区间提交编辑', async () => {
    await submit()

    expect(media.events).toEqual([
      'encode',
      'POST /api/uploads/sign',
      `PUT /mock-oss/${uploadId}`,
      `POST /api/uploads/${uploadId}/confirm`,
      'POST /api/generations/video-edits',
    ])
    expect(media.sources).toEqual([baseMediaUrl])
    expect(media.trims).toEqual([{ mediaUrl: baseMediaUrl, start: 1.917, end: 6.5 }])
    expect(signed).toEqual({ contentType: 'video/mp4', height: null, width: null })
    expect(edited).toEqual({
      conversation_id: conversationId,
      task_id: null,
      source_job_id: sourceJobId,
      range_start_ms: 1917,
      range_end_ms: 6500,
      reference_video_urls: [clipUrl],
      model: 'wan3.0-video',
      prompt: '换成浅灰背景',
      reference_image_urls: ['https://cdn.example.com/ref.png'],
      seconds: -1,
    })
    expect(media.disposed).toBe(1)
  })

  it('当前选用结果和相邻基底拼成 5 秒参考，替换位置仍是基底 2–6 秒', async () => {
    const editedMediaUrl = 'https://oss.example.com/edited.mp4'
    const referenceClips = [
      { mediaUrl: editedMediaUrl, start: 0, end: 3 },
      { mediaUrl: baseMediaUrl, start: 4, end: 6 },
    ]

    await submitClipGeneration({
      conversationId,
      taskId: null,
      sourceJobId,
      generation: { mode: 'edit', referenceClips },
      range: { start: 2, end: 6 },
      model: modelById('wan3.0-video'),
      prompt: '继续修改选中的内容',
      referenceImageUrls: [],
    })

    expect(media.sources).toEqual([editedMediaUrl, baseMediaUrl])
    expect(media.trims).toEqual(referenceClips)
    expect(media.videoSamples).toEqual([
      { timestamp: 0, duration: 3 },
      { timestamp: 3, duration: 2 },
    ])
    expect(edited).toMatchObject({
      source_job_id: sourceJobId,
      range_start_ms: 2000,
      range_end_ms: 6000,
      reference_video_urls: [clipUrl],
      seconds: -1,
    })
    expect(media.disposed).toBe(2)
  })

  it('参考编码失败就报错，不上传、不提交', async () => {
    media.failEncoding = true

    const error = await submit().then(
      () => undefined,
      (reason: unknown) => reason,
    )

    expect(error).toBeInstanceOf(UserFacingError)
    expect(errorMessageOf(error, '兜底')).toBe('参考片段制作失败，请稍后重试')
    expect(media.events).toEqual([])
    expect(media.disposed).toBe(1)
  })

  it.each(['vendor-a-seedance-2-0', 'vendor-a-seedance-2-5', 'wan3.0-video'])(
    '%s 图生仅提交正文图片与生成时长，不编码或上传参考视频',
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

      expect(media.events).toEqual(['POST /api/generations/video-edits'])
      expect(media.sources).toEqual([])
      expect(media.trims).toEqual([])
      expect(signed).toBeUndefined()
      expect(edited).toEqual({
        conversation_id: conversationId,
        task_id: null,
        source_job_id: sourceJobId,
        range_start_ms: 2000,
        range_end_ms: 3000,
        model: id,
        prompt: '人物向前走两步',
        reference_image_urls: ['https://cdn.example.com/ref.png'],
        reference_video_urls: [],
        seconds: 5,
      })
    },
  )

  it.each([
    ['vendor-a-seedance-2-0', 3],
    ['vendor-a-seedance-2-0', 16],
    ['vendor-a-seedance-2-0', 5.5],
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

    expect(media.events).toEqual([])
    expect(media.sources).toEqual([])
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

    expect(media.events).toEqual([])
    expect(media.sources).toEqual([])
    expect(edited).toBeUndefined()
  })

  it.each([
    ['vendor-a-seedance-2-5', 3.999],
    ['vendor-a-seedance-2-5', 30.001],
    ['wan3.0-video', 0.999],
    ['wan3.0-video', 15.001],
  ])('%s 编辑参考时长 %s 秒越界时，在读取或编码视频前拦截', async (id, seconds) => {
    await expect(
      submitClipGeneration({
        conversationId,
        taskId: null,
        sourceJobId,
        range: { start: 2, end: 7 },
        model: modelById(id),
        prompt: '人物向前走两步',
        referenceImageUrls: [],
        generation: {
          mode: 'edit',
          referenceClips: [{ mediaUrl: baseMediaUrl, start: 0, end: seconds }],
        },
      }),
    ).rejects.toThrow(/至少|最多/)

    expect(media.events).toEqual([])
    expect(media.sources).toEqual([])
    expect(media.trims).toEqual([])
    expect(edited).toBeUndefined()
  })

  it('两个相邻的 2 秒结果按参考总长 4 秒交给 Seedance 编辑，基底替换区间仍可为 1 秒', async () => {
    const referenceClips = [
      { mediaUrl: baseMediaUrl, start: 0, end: 2 },
      { mediaUrl: baseMediaUrl, start: 2, end: 4 },
    ]
    await submitClipGeneration({
      conversationId,
      taskId: null,
      sourceJobId,
      range: { start: 6, end: 7 },
      model: modelById('vendor-a-seedance-2-5'),
      prompt: '人物向前走两步',
      referenceImageUrls: [],
      generation: { mode: 'edit', referenceClips },
    })

    expect(media.trims).toEqual(referenceClips)
    expect(media.videoSamples).toEqual([
      { timestamp: 0, duration: 2 },
      { timestamp: 2, duration: 2 },
    ])
    expect(edited).toMatchObject({
      range_start_ms: 6000,
      range_end_ms: 7000,
      reference_video_urls: [clipUrl],
      prompt: '人物向前走两步',
      seconds: -1,
    })
  })

  it.each([
    { id: 'vendor-a-seedance-2-5', start: 0.1, end: 4.1 },
    { id: 'wan3.0-video', start: 1.1, end: 16.1 },
  ])('$id 的毫秒精度合法边界 $start–$end 秒不会被浮点误差拒绝', async ({ id, start, end }) => {
    media.duration = end
    const referenceClips = [{ mediaUrl: baseMediaUrl, start, end }]

    await submitClipGeneration({
      conversationId,
      taskId: null,
      sourceJobId,
      range: { start, end },
      model: modelById(id),
      prompt: '保持人物造型',
      referenceImageUrls: [],
      generation: { mode: 'edit', referenceClips },
    })

    expect(media.trims).toEqual(referenceClips)
    expect(media.events).toEqual([
      'encode',
      'POST /api/uploads/sign',
      `PUT /mock-oss/${uploadId}`,
      `POST /api/uploads/${uploadId}/confirm`,
      'POST /api/generations/video-edits',
    ])
    expect(edited).toMatchObject({
      model: id,
      range_start_ms: Math.round(start * 1000),
      range_end_ms: Math.round(end * 1000),
      reference_video_urls: [clipUrl],
      seconds: -1,
    })
  })
})
