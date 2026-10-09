/** 上传协议的唯一实现：本地校验 → 签名 → 直传对象存储 → 确认；合同见 contract/conventions.md §10。 */

import type { z } from 'zod'
import { apiFetch, NETWORK_FAILURE, UserFacingError } from './client'
import { zUploadConfirmedOut, zUploadTicketOut } from './generated/zod.gen'

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const VIDEO_TYPES = ['video/mp4', 'video/quicktime']
export const MEDIA_IMAGE_ACCEPT = IMAGE_TYPES.join(',')
export const MEDIA_VIDEO_ACCEPT = VIDEO_TYPES.join(',')

const UPLOAD_FAILED = '上传失败'

/** 文件选择与拖放共用校验；图片尺寸须解码后才能用于签名。 */
const mediaDimensions = async (file: File, kind: 'image' | 'video') => {
  if (kind === 'video') {
    if (!VIDEO_TYPES.includes(file.type))
      throw new UserFacingError('文件格式不受支持，无法上传；请选择 MP4 或 MOV 视频')
    if (file.size > 512 * 1024 * 1024) throw new UserFacingError('视频超过 512 MiB，无法上传')
    return { height: null, width: null }
  }
  if (!IMAGE_TYPES.includes(file.type))
    throw new UserFacingError('文件格式不受支持，无法上传；请选择 JPEG、PNG 或 WebP 图片')
  if (file.size > 16 * 1024 * 1024) throw new UserFacingError('图片超过 16 MiB，无法上传')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch (cause) {
    throw new UserFacingError('图片读取失败，请选择有效的图片文件', { cause })
  }
  const { width, height } = bitmap
  bitmap.close()
  if (Math.min(width, height) < 300 || Math.max(width, height) > 6000) {
    throw new UserFacingError(
      '图片尺寸不符，无法上传；请使用短边至少 300 像素、长边不超过 6000 像素的图片',
    )
  }
  return { height, width }
}

type UploadInstruction = z.infer<typeof zUploadTicketOut>['upload']

/** 用 XHR 直传以便取进度；签名里的 headers 必须原样发送。失败文案与 apiFetch 同格式：断网时带原因，其余只给前缀、不外露状态码。 */
const putToStorage = (
  upload: UploadInstruction,
  file: File,
  onProgress: ((ratio: number) => void) | undefined,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open(upload.method, upload.url)
    for (const [name, value] of Object.entries(upload.headers)) {
      request.setRequestHeader(name, value)
    }
    if (onProgress !== undefined) {
      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
      })
    }
    // loadend 在成功、HTTP 错误、断网与中断后都会到；拿不到响应时 status 为 0。
    request.addEventListener('loadend', () => {
      if (request.status >= 200 && request.status < 300) {
        resolve()
        return
      }
      reject(
        new UserFacingError(
          request.status === 0 ? `${UPLOAD_FAILED}：${NETWORK_FAILURE}` : UPLOAD_FAILED,
        ),
      )
    })
    request.send(file)
  })

type UploadMediaOptions = {
  /** 直传进度 0–1，浏览器算得出总量时才回调；节流由调用方决定。 */
  onProgress?: (ratio: number) => void
}

/** 确认过的一次上传：可持久化的地址，以及把它交给别的端点（如建参考视频）时用的上传 id。 */
export type UploadedMedia = { url: string; uploadId: string }

/**
 * 校验、签名、直传并确认；服务端按桶里的对象核对通过后才返回可持久化的地址。
 *
 * 本地校验与直传失败抛 {@link UserFacingError}，签名与确认失败抛 ApiError；两者的 message 都可直接展示。
 */
export const uploadMediaFile = async (
  file: File,
  kind: 'image' | 'video',
  { onProgress }: UploadMediaOptions = {},
): Promise<UploadedMedia> => {
  const dimensions = await mediaDimensions(file, kind)
  const ticket = await apiFetch('/uploads/sign', zUploadTicketOut, {
    body: { contentType: file.type, ...dimensions },
    fallbackErrorMessage: UPLOAD_FAILED,
    method: 'POST',
  })
  await putToStorage(ticket.upload, file, onProgress)
  const confirmed = await apiFetch(`/uploads/${ticket.uploadId}/confirm`, zUploadConfirmedOut, {
    fallbackErrorMessage: UPLOAD_FAILED,
    method: 'POST',
  })
  return { uploadId: ticket.uploadId, url: confirmed.url }
}
