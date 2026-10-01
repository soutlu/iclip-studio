/** 输入框芯片的内容；外观见 media-preview.css 的 `.media-chip`。缩略图不可用时显示媒体类型图标；上传中在缩略图上叠进度，失败换成警示图标。 */

import { Icon } from '@/shared/icons'
import { imageThumbnailUrl, videoSnapshotUrl } from '@/shared/lib/media-url'
import { ellipsizeAttachmentName } from './attachment-format'
import { MEDIA_KIND_ICON, type MediaDescriptor, mediaDisplayName } from './media-descriptor'
import { UploadRing } from './upload-ring'

/** 图片取缩略图，视频取 OSS 首帧；blob 视频与非 OSS 视频返回 undefined。 */
export const mediaThumbnailUrl = (media: MediaDescriptor): string | undefined => {
  if (media.previewUrl === undefined || media.kind === 'file') return undefined
  return media.kind === 'image'
    ? imageThumbnailUrl(media.previewUrl)
    : videoSnapshotUrl(media.previewUrl)
}

export function MediaChipContent({ media }: { media: MediaDescriptor }) {
  const thumbnail = mediaThumbnailUrl(media)
  const { upload } = media

  return (
    <>
      <span className="media-chip-icon">
        {upload?.status === 'error' ? (
          <Icon label="上传失败" name="alert" size="sm" />
        ) : thumbnail === undefined ? (
          <Icon decorative name={MEDIA_KIND_ICON[media.kind]} size="sm" />
        ) : (
          <img alt="" src={thumbnail} />
        )}
        {upload?.status === 'uploading' ? (
          <span
            aria-label="上传中"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={
              upload.progress === undefined ? undefined : Math.round(upload.progress * 100)
            }
            className="media-chip-veil"
            role="progressbar"
          >
            <UploadRing progress={upload.progress} size="sm" />
          </span>
        ) : null}
      </span>
      <span className="media-chip-name">{ellipsizeAttachmentName(mediaDisplayName(media))}</span>
    </>
  )
}
