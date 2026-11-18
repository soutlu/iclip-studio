import type { MediaUpload } from '@/shared/api/media-upload'

/** 上传台账里的一条，给确认上传、列上传的答复用；没给的项取一张图片上传的样子。 */
export const makeMediaUpload = (overrides: Partial<MediaUpload> = {}): MediaUpload => ({
  contentType: 'image/png',
  conversationId: null,
  createdAt: '2026-09-01T12:00:00Z',
  durationMs: null,
  height: 1600,
  id: crypto.randomUUID(),
  kind: 'image',
  sizeBytes: 1024,
  url: 'https://cdn.test/iclip/agent/uploads/upload.png',
  width: 1200,
  ...overrides,
})
