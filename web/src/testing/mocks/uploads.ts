import { http, HttpResponse } from 'msw'

// 上传协议的 mock：签名、直传与确认共用上传类型记录，保持确认响应与签名一致。
// mock 里只有一个登录人，确认过的上传都算他本人的。

/** 按 uploadId 记录签名时的 contentType，确认响应复用此信息。 */
const signedUploads = new Map<string, string>()
const storedBytes = new Map<string, { body: ArrayBuffer; contentType: string }>()
/** 确认过的上传：地址 → contentType。 */
const confirmedUploads = new Map<string, string>()

const uploadUrlOf = (uploadId: string) => `http://localhost/mock-oss/${uploadId}`

export const resetMockUploads = () => {
  signedUploads.clear()
  storedBytes.clear()
  confirmedUploads.clear()
}

/** 这个地址是不是确认过的一条视频上传；编辑段的参考片段要是它。 */
export const isMockVideoUpload = (url: string): boolean =>
  confirmedUploads.get(url)?.startsWith('video/') ?? false

/** 确认过的一次上传：地址、类型与直传上来的字节；没确认过是 undefined。建参考视频按它认人认内容。 */
export const mockConfirmedUpload = (
  uploadId: string,
): { url: string; contentType: string; body: ArrayBuffer | undefined } | undefined => {
  const url = uploadUrlOf(uploadId)
  const contentType = confirmedUploads.get(url)
  if (contentType === undefined) return undefined
  return { body: storedBytes.get(uploadId)?.body, contentType, url }
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

  http.post('*/api/uploads/:uploadId/confirm', ({ params }) => {
    const uploadId = params['uploadId'] as string
    const contentType = signedUploads.get(uploadId) ?? 'image/png'
    const url = uploadUrlOf(uploadId)
    confirmedUploads.set(url, contentType)
    return HttpResponse.json({ contentType, sizeBytes: 1024, url })
  }),
]
