import type { IconName } from '@/shared/icons'

type MediaKind = 'file' | 'image' | 'video'

export type MediaUploadState =
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready' }
  | { readonly status: 'uploading'; readonly progress: number | undefined }

export type MediaDescriptor = {
  readonly kind: MediaKind
  readonly name: string
  readonly size?: number | undefined
  readonly previewUrl?: string | undefined
  readonly upload?: MediaUploadState | undefined
}

export const MEDIA_KIND_ICON: Record<MediaKind, IconName> = {
  file: 'file',
  image: 'image',
  video: 'video',
}

const MEDIA_KIND_NAME: Record<MediaKind, string> = {
  file: '附件',
  image: '图片',
  video: '视频',
}

export const mediaDisplayName = (media: MediaDescriptor): string =>
  media.name === '' ? MEDIA_KIND_NAME[media.kind] : media.name
