import { http, HttpResponse } from 'msw'
import type { MediaUpload } from '@/shared/api/media-upload'

const signedUploads = new Map<string, string>()
const storedBytes = new Map<string, { body: ArrayBuffer; contentType: string }>()
const confirmedUploads = new Map<string, string>()
const ledger = new Map<string, MediaUpload>()

const uploadUrlOf = (uploadId: string) => `http://localhost/mock-oss/${uploadId}`

export const resetMockUploads = () => {
  signedUploads.clear()
  storedBytes.clear()
  confirmedUploads.clear()
  ledger.clear()
}

export const isMockVideoUpload = (url: string): boolean =>
  confirmedUploads.get(url)?.startsWith('video/') ?? false

export const mockConfirmedUpload = (
  uploadId: string,
): { url: string; contentType: string; body: ArrayBuffer | undefined } | undefined => {
  const url = uploadUrlOf(uploadId)
  const contentType = confirmedUploads.get(url)
  if (contentType === undefined) return undefined
  return { body: storedBytes.get(uploadId)?.body, contentType, url }
}

const kindOf = (contentType: string): MediaUpload['kind'] =>
  contentType.startsWith('video/') ? 'video' : contentType.startsWith('audio/') ? 'audio' : 'image'

/** 往上传台账里放一条，列上传时会列出来。 */
export const addMockUpload = (upload: MediaUpload) => {
  ledger.set(upload.id, upload)
  return upload
}

export const uploadHandlers = [
  http.get('*/api/conversations/:conversationId/uploads', ({ params, request }) => {
    const conversationId = String(params['conversationId'])
    const kind = new URL(request.url).searchParams.get('kind')
    const items = [...ledger.values()]
      .filter(
        (upload) =>
          upload.conversationId === conversationId && (kind === null || upload.kind === kind),
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    return HttpResponse.json({ items })
  }),

  http.post('*/api/uploads/sign', async ({ request }) => {
    const body = (await request.json()) as { contentType: string }
    const uploadId = crypto.randomUUID()
    signedUploads.set(uploadId, body.contentType)
    return HttpResponse.json({
      uploadId,
      upload: {
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        headers: { 'Content-Type': body.contentType },
        url: uploadUrlOf(uploadId),
      },
    })
  }),

  http.put('*/mock-oss/:uploadId', async ({ params, request }) => {
    storedBytes.set(String(params['uploadId']), {
      body: await request.arrayBuffer(),
      contentType: request.headers.get('Content-Type') ?? 'application/octet-stream',
    })
    return new HttpResponse(null, { status: 200 })
  }),
  http.get('*/mock-oss/:uploadId', ({ params }) => {
    const stored = storedBytes.get(String(params['uploadId']))
    return stored
      ? new HttpResponse(stored.body, { headers: { 'Content-Type': stored.contentType } })
      : new HttpResponse(null, { status: 404 })
  }),

  http.post('*/api/uploads/:uploadId/confirm', async ({ params, request }) => {
    const uploadId = params['uploadId'] as string
    const recorded = ledger.get(uploadId)
    if (recorded !== undefined) return HttpResponse.json(recorded)
    const contentType = signedUploads.get(uploadId) ?? 'image/png'
    const url = uploadUrlOf(uploadId)
    confirmedUploads.set(url, contentType)
    const text = await request.text()
    const body =
      text === ''
        ? {}
        : (JSON.parse(text) as {
            conversationId?: string | null
            width?: number | null
            height?: number | null
          })
    const kind = kindOf(contentType)
    // 照后端：确认时不量时长，只有图片记报上来的宽高
    const upload = addMockUpload({
      contentType,
      conversationId: body.conversationId ?? null,
      createdAt: new Date().toISOString(),
      durationMs: null,
      height: kind === 'image' ? (body.height ?? null) : null,
      id: uploadId,
      kind,
      sizeBytes: storedBytes.get(uploadId)?.body.byteLength ?? 1024,
      url,
      width: kind === 'image' ? (body.width ?? null) : null,
    })
    return HttpResponse.json(upload)
  }),
]
