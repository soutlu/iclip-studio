import { http, HttpResponse } from 'msw'

const signedUploads = new Map<string, string>()
const storedBytes = new Map<string, { body: ArrayBuffer; contentType: string }>()
const confirmedUploads = new Map<string, string>()

const uploadUrlOf = (uploadId: string) => `http://localhost/mock-oss/${uploadId}`

export const resetMockUploads = () => {
  signedUploads.clear()
  storedBytes.clear()
  confirmedUploads.clear()
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

type ConfirmListener = (upload: {
  uploadId: string
  url: string
  contentType: string
  conversationId: string | null
}) => void

let confirmListener: ConfirmListener | null = null

export const onMockUploadConfirmed = (listener: ConfirmListener) => {
  confirmListener = listener
}

export const uploadHandlers = [
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
    const contentType = signedUploads.get(uploadId) ?? 'image/png'
    const url = uploadUrlOf(uploadId)
    confirmedUploads.set(url, contentType)
    const text = await request.text()
    const body = text === '' ? {} : (JSON.parse(text) as { conversationId?: string | null })
    confirmListener?.({ uploadId, url, contentType, conversationId: body.conversationId ?? null })
    return HttpResponse.json({ contentType, sizeBytes: 1024, url })
  }),
]
