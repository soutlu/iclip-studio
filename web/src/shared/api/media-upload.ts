/** 合同见 contract/conventions.md §10。 */

import type { z } from 'zod'
import { apiFetch, NETWORK_FAILURE, UserFacingError } from './client'
import { zUploadConfirmedOut, zUploadTicketOut } from './generated/zod.gen'

const MIB = 1024 * 1024

export type UploadKind = 'image' | 'video' | 'audio' | 'font'

type UploadRule = {
  byExtension: Readonly<Record<string, string>>
  byType: Readonly<Record<string, string>>
  maxBytes: number
  formatError: string
  sizeError: string
}

const sameType = (types: readonly string[]) => Object.fromEntries(types.map((type) => [type, type]))

const UPLOAD_RULES: Readonly<Record<UploadKind, UploadRule>> = {
  image: {
    byExtension: {},
    byType: sameType(['image/jpeg', 'image/png', 'image/webp']),
    maxBytes: 16 * MIB,
    formatError: '文件格式不受支持，无法上传；请选择 JPEG、PNG 或 WebP 图片',
    sizeError: '图片超过 16 MiB，无法上传；请选择更小的文件',
  },
  video: {
    byExtension: {},
    byType: sameType(['video/mp4', 'video/quicktime']),
    maxBytes: 512 * MIB,
    formatError: '文件格式不受支持，无法上传；请选择 MP4 或 MOV 视频',
    sizeError: '视频超过 512 MiB，无法上传；请选择更小的文件',
  },
  // 同一种音乐浏览器各报各的（m4a 常报 audio/x-m4a），签名与直传要用后端认的那一种。
  audio: {
    byExtension: { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav' },
    byType: {
      'audio/mp4': 'audio/mp4',
      'audio/x-m4a': 'audio/mp4',
      'audio/m4a': 'audio/mp4',
      'audio/mpeg': 'audio/mpeg',
      'audio/mp3': 'audio/mpeg',
      'audio/wav': 'audio/wav',
      'audio/x-wav': 'audio/wav',
      'audio/wave': 'audio/wav',
    },
    maxBytes: 50 * MIB,
    formatError: '文件格式不受支持，无法上传；请选择 MP3、WAV 或 M4A 音乐',
    sizeError: '音乐超过 50 MiB，无法上传；请选择更小的文件',
  },
  font: {
    byExtension: { ttf: 'font/ttf', otf: 'font/otf' },
    byType: {},
    maxBytes: 32 * MIB,
    formatError: '文件格式不受支持，无法上传；请选择 TTF 或 OTF 字体',
    sizeError: '字体超过 32 MiB，无法上传；请选择更小的文件',
  },
}

const acceptOf = ({ byExtension, byType }: UploadRule): string =>
  [...Object.keys(byExtension).map((extension) => `.${extension}`), ...Object.keys(byType)].join(
    ',',
  )

export const MEDIA_IMAGE_ACCEPT = acceptOf(UPLOAD_RULES.image)
export const MEDIA_VIDEO_ACCEPT = acceptOf(UPLOAD_RULES.video)
export const MEDIA_AUDIO_ACCEPT = acceptOf(UPLOAD_RULES.audio)
export const FONT_ACCEPT = acceptOf(UPLOAD_RULES.font)

export const uploadContentTypeOf = (
  file: Pick<File, 'name' | 'type'>,
  kind: UploadKind,
): string | undefined => {
  const { byExtension, byType } = UPLOAD_RULES[kind]
  const extension = /\.([^./]+)$/.exec(file.name)?.[1]?.toLowerCase()
  return (
    (extension === undefined ? undefined : byExtension[extension]) ??
    byType[file.type.toLowerCase()]
  )
}

export const checkUploadFile = (file: Pick<File, 'name' | 'type' | 'size'>, kind: UploadKind) => {
  const rule = UPLOAD_RULES[kind]
  const contentType = uploadContentTypeOf(file, kind)
  if (contentType === undefined) throw new UserFacingError(rule.formatError)
  if (file.size > rule.maxBytes) throw new UserFacingError(rule.sizeError)
  return contentType
}

const UPLOAD_FAILED = '上传失败'

type MediaKind = Exclude<UploadKind, 'font'>
type SignedMedia = { contentType: string; width: number | null; height: number | null }

const signedMediaOf = async (file: File, kind: MediaKind): Promise<SignedMedia> => {
  const contentType = checkUploadFile(file, kind)
  if (kind !== 'image') return { contentType, height: null, width: null }
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
  return { contentType, height, width }
}

type UploadTicket = z.infer<typeof zUploadTicketOut>

const putToStorage = (
  upload: UploadTicket['upload'],
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

export const uploadFontFile = async (
  file: File,
  sign: (contentType: string) => Promise<UploadTicket>,
  onProgress?: (ratio: number) => void,
): Promise<string> => {
  const ticket = await sign(checkUploadFile(file, 'font'))
  await putToStorage(ticket.upload, file, onProgress)
  return ticket.uploadId
}

export type UploadedMedia = { url: string; uploadId: string }

export const uploadMediaFile = async (
  file: File,
  kind: MediaKind,
  { onProgress }: { onProgress?: (ratio: number) => void } = {},
): Promise<UploadedMedia> => {
  const signed = await signedMediaOf(file, kind)
  const ticket = await apiFetch('/uploads/sign', zUploadTicketOut, {
    body: signed,
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
