import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { errorMessageOf, UserFacingError } from './client'
import { checkUploadFile, uploadContentTypeOf, uploadMediaFile } from './media-upload'

const FALLBACK = '兜底文案'

const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )

describe('uploadMediaFile 视频', () => {
  const uploadId = 'f40a7a4b-90ec-438b-8bf0-9bde53a290fc'
  const uploadUrl = `http://localhost/mock-oss/${uploadId}`
  const assetUrl = 'https://assets.example.com/reference.mp4'
  const requests: string[] = []
  let signedBody: unknown

  const videoFile = (type: string, size: number) => {
    const file = new File(['video'], '参考视频.mp4', { type })
    Object.defineProperty(file, 'size', { value: size })
    return file
  }

  beforeEach(() => {
    signedBody = undefined
    requests.length = 0
    server.events.on('request:start', ({ request }) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
    })
    server.use(
      http.post('*/api/uploads/sign', async ({ request }) => {
        signedBody = await request.json()
        return HttpResponse.json({
          uploadId,
          upload: {
            expiresAt: '2026-09-06T12:00:00Z',
            headers: { 'Content-Type': 'video/mp4' },
            url: uploadUrl,
          },
        })
      }),
      http.put(uploadUrl, () => new HttpResponse(null, { status: 200 })),
      http.post('*/api/uploads/:uploadId/confirm', () =>
        HttpResponse.json({ contentType: 'video/mp4', sizeBytes: 5, url: assetUrl }),
      ),
    )
  })

  it.each([
    ['video/mp4', 5],
    ['video/quicktime', 5],
  ])('上传 %s 后确认并返回永久地址与上传 id，尺寸保留空值', async (type, size) => {
    await expect(uploadMediaFile(videoFile(type, size), 'video')).resolves.toEqual({
      uploadId,
      url: assetUrl,
    })
    expect(signedBody).toEqual({ contentType: type, height: null, width: null })
    expect(requests).toEqual([
      'POST /api/uploads/sign',
      `PUT /mock-oss/${uploadId}`,
      `POST /api/uploads/${uploadId}/confirm`,
    ])
  })

  it.each([
    ['video/webm', 5],
    ['image/png', 5],
    ['', 5],
  ])('不上传不支持的类型：%s / %i 字节，错误可直接展示', async (type, size) => {
    const error = await rejectionOf(uploadMediaFile(videoFile(type, size), 'video'))
    expect(error).toBeInstanceOf(UserFacingError)
    expect(errorMessageOf(error, FALLBACK)).not.toBe(FALLBACK)
    expect(requests).toEqual([])
  })

  it('给了 onProgress 时经直传回报进度，传完是 1', async () => {
    const ratios: number[] = []
    await expect(
      uploadMediaFile(videoFile('video/mp4', 5), 'video', {
        onProgress: (ratio) => ratios.push(ratio),
      }),
    ).resolves.toMatchObject({ url: assetUrl })
    expect(ratios.at(-1)).toBe(1)
  })

  it.each([
    ['对象存储拒绝', () => new HttpResponse(null, { status: 403 }), '上传失败'],
    ['断网', () => HttpResponse.error(), '上传失败：网络连接失败，请检查网络后重试'],
  ])('直传失败（%s）给出与接口错误同格式的中文，不再确认', async (_case, respond, message) => {
    server.use(http.put(uploadUrl, respond))

    const error = await rejectionOf(uploadMediaFile(videoFile('video/mp4', 5), 'video'))

    expect(error).toBeInstanceOf(UserFacingError)
    expect(errorMessageOf(error, FALLBACK)).toBe(message)
    expect(requests).toEqual(['POST /api/uploads/sign', `PUT /mock-oss/${uploadId}`])
  })
})

describe('uploadMediaFile 图片', () => {
  const uploadId = 'f40a7a4b-90ec-438b-8bf0-9bde53a290fc'
  const uploadUrl = `http://localhost/mock-oss/${uploadId}`
  const assetUrl = 'https://assets.example.com/replacement.png'
  const requests: string[] = []
  const decode = vi.fn<typeof createImageBitmap>()
  const close = vi.fn()
  let signedBody: unknown
  let uploadHeaders: Record<string, string | null> | undefined

  const imageFile = (type = 'image/png', size = 4) =>
    new File([new Uint8Array(size)], '本地图片.png', { type })

  beforeEach(() => {
    requests.length = 0
    signedBody = undefined
    uploadHeaders = undefined
    close.mockReset()
    decode.mockReset().mockResolvedValue({ close, height: 1200, width: 800 })
    vi.stubGlobal('createImageBitmap', decode)
    server.events.on('request:start', ({ request }) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
    })
    server.use(
      http.post('*/api/uploads/sign', async ({ request }) => {
        signedBody = await request.json()
        return HttpResponse.json({
          uploadId,
          upload: {
            expiresAt: '2026-09-06T12:00:00Z',
            headers: { 'Content-Type': 'image/png', 'x-upload-token': 'test-ticket' },
            url: uploadUrl,
          },
        })
      }),
      http.put(uploadUrl, ({ request }) => {
        uploadHeaders = {
          'Content-Type': request.headers.get('Content-Type'),
          'x-upload-token': request.headers.get('x-upload-token'),
        }
        return new HttpResponse(null, { status: 200 })
      }),
      http.post('*/api/uploads/:uploadId/confirm', () =>
        HttpResponse.json({ contentType: 'image/png', sizeBytes: 4, url: assetUrl }),
      ),
    )
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ['image/jpeg', 300, 6000, 4],
    ['image/png', 6000, 300, 16 * 1024 * 1024],
    ['image/webp', 800, 1200, 4],
  ])('用解码尺寸签名，直传后才确认 %s 图片', async (type, width, height, size) => {
    decode.mockResolvedValue({ close, height, width })
    const file = imageFile(type, size)

    await expect(uploadMediaFile(file, 'image')).resolves.toMatchObject({ url: assetUrl })

    expect(decode).toHaveBeenCalledWith(file)
    expect(close).toHaveBeenCalledOnce()
    expect(signedBody).toEqual({ contentType: type, height, width })
    expect(uploadHeaders).toEqual({ 'Content-Type': 'image/png', 'x-upload-token': 'test-ticket' })
    expect(requests).toEqual([
      'POST /api/uploads/sign',
      `PUT /mock-oss/${uploadId}`,
      `POST /api/uploads/${uploadId}/confirm`,
    ])
  })

  it.each([
    ['image/gif', 4],
    ['text/plain', 4],
    ['', 4],
    ['image/png', 16 * 1024 * 1024 + 1],
  ])('类型或大小不合规时不解码、不上传：%s / %i 字节', async (type, size) => {
    await expect(uploadMediaFile(imageFile(type, size), 'image')).rejects.toThrow()
    expect(decode).not.toHaveBeenCalled()
    expect(requests).toEqual([])
  })

  it('图片解码失败时保留错误，不请求上传签名', async () => {
    decode.mockRejectedValue(new DOMException('Invalid image', 'InvalidStateError'))

    await expect(uploadMediaFile(imageFile(), 'image')).rejects.toThrow('图片读取失败')
    expect(requests).toEqual([])
  })

  it.each([
    [299, 1200],
    [800, 299],
    [6001, 300],
    [300, 6001],
  ])('图片尺寸 %i × %i 不合规时释放解码资源，不请求签名', async (width, height) => {
    decode.mockResolvedValue({ close, height, width })

    await expect(uploadMediaFile(imageFile(), 'image')).rejects.toThrow('图片尺寸不符，无法上传')
    expect(close).toHaveBeenCalledOnce()
    expect(requests).toEqual([])
  })

  it('签名失败时停止上传，返回后端错误', async () => {
    server.use(
      http.post('*/api/uploads/sign', () =>
        HttpResponse.json({ detail: '签名服务不可用' }, { status: 503 }),
      ),
    )

    await expect(uploadMediaFile(imageFile(), 'image')).rejects.toThrow('签名服务不可用')
    expect(requests).toEqual(['POST /api/uploads/sign'])
  })

  it('确认失败时不返回上传地址', async () => {
    server.use(
      http.post('*/api/uploads/:uploadId/confirm', () =>
        HttpResponse.json({ detail: '图片确认失败' }, { status: 422 }),
      ),
    )

    await expect(uploadMediaFile(imageFile(), 'image')).rejects.toThrow('图片确认失败')
    expect(requests).toEqual([
      'POST /api/uploads/sign',
      `PUT /mock-oss/${uploadId}`,
      `POST /api/uploads/${uploadId}/confirm`,
    ])
  })
})

describe('音乐的类型', () => {
  it.each([
    ['夏日.m4a', 'audio/x-m4a', 'audio/mp4'],
    ['夏日.M4A', '', 'audio/mp4'],
    ['夏日.m4a', 'audio/mp4', 'audio/mp4'],
    ['夏日.wav', 'audio/x-wav', 'audio/wav'],
    ['夏日.wav', 'audio/wave', 'audio/wav'],
    ['夏日.mp3', 'audio/mp3', 'audio/mpeg'],
    ['夏日.mp3', '', 'audio/mpeg'],
    ['夏日', 'audio/x-m4a', 'audio/mp4'],
    ['夏日.audio', 'audio/x-wav', 'audio/wav'],
    ['夏日.mp3', 'audio/x-wav', 'audio/mpeg'],
  ])('%s（浏览器报 %s）按 %s 签名', (name, type, expected) => {
    expect(uploadContentTypeOf({ name, type }, 'audio')).toBe(expected)
  })

  it.each([
    ['夏日.ogg', 'audio/ogg'],
    ['夏日.flac', ''],
    ['夏日', ''],
  ])('%s（%s）认不出', (name, type) => {
    expect(uploadContentTypeOf({ name, type }, 'audio')).toBeUndefined()
  })
})

describe('上传校验表', () => {
  const MIB = 1024 * 1024
  const fileOf = (name: string, type: string, size: number) => ({ name, type, size })

  it.each([
    ['video', fileOf('片头.mp4', 'video/mp4', 1), 'video/mp4'],
    ['video', fileOf('片头', 'video/quicktime', 512 * MIB), 'video/quicktime'],
  ] as const)('%s 收下 %o，按 %s 签名', (kind, file, contentType) => {
    expect(checkUploadFile(file, kind)).toBe(contentType)
  })

  it.each([
    ['video', fileOf('片头.mp4', 'video/webm', 1), 'MP4 或 MOV'],
    ['video', fileOf('片头.mp4', 'video/mp4', 512 * MIB + 1), '512 MiB'],
  ] as const)('%s 拒收 %o，原因含「%s」', (kind, file, reason) => {
    expect(() => checkUploadFile(file, kind)).toThrow(UserFacingError)
    expect(() => checkUploadFile(file, kind)).toThrow(reason)
  })
})

describe('uploadMediaFile 音乐', () => {
  const uploadId = 'b3c2b0a1-4a0e-4b8e-9a43-2a1f7c0d9e11'
  const uploadUrl = `http://localhost/mock-oss/${uploadId}`
  const requests: string[] = []
  let signedBody: unknown
  let putType: string | null

  const audioFile = (name: string, type: string, size = 5) => {
    const file = new File(['music'], name, { type })
    Object.defineProperty(file, 'size', { value: size })
    return file
  }

  beforeEach(() => {
    requests.length = 0
    signedBody = undefined
    putType = null
    server.events.on('request:start', ({ request }) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
    })
    server.use(
      http.post('*/api/uploads/sign', async ({ request }) => {
        signedBody = await request.json()
        return HttpResponse.json({
          uploadId,
          upload: {
            expiresAt: '2026-09-06T12:00:00Z',
            headers: { 'Content-Type': (signedBody as { contentType: string }).contentType },
            url: uploadUrl,
          },
        })
      }),
      http.put(uploadUrl, ({ request }) => {
        putType = request.headers.get('Content-Type')
        return new HttpResponse(null, { status: 200 })
      }),
      http.post('*/api/uploads/:uploadId/confirm', () =>
        HttpResponse.json({ contentType: 'audio/mp4', sizeBytes: 5, url: uploadUrl }),
      ),
    )
  })

  it('浏览器报 audio/x-m4a 的 m4a 按 audio/mp4 签名与直传，不报宽高', async () => {
    await expect(uploadMediaFile(audioFile('夏日.m4a', 'audio/x-m4a'), 'audio')).resolves.toEqual({
      uploadId,
      url: uploadUrl,
    })
    expect(signedBody).toEqual({ contentType: 'audio/mp4', height: null, width: null })
    expect(putType).toBe('audio/mp4')
  })

  it.each([
    ['认不出的类型', audioFile('夏日.ogg', 'audio/ogg'), 'MP3、WAV 或 M4A'],
    ['超过 50 MiB', audioFile('夏日.mp3', 'audio/mpeg', 50 * 1024 * 1024 + 1), '50 MiB'],
  ])('%s：给出可展示的原因，不上传', async (_, file, reason) => {
    const error = await rejectionOf(uploadMediaFile(file, 'audio'))
    expect(error).toBeInstanceOf(UserFacingError)
    expect(errorMessageOf(error, FALLBACK)).toContain(reason)
    expect(requests).toEqual([])
  })
})
