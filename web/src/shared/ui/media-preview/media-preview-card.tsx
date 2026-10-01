/** 参考 Kimi mention-tip；锚点与卡共用悬停时序，hover 桥覆盖二者间隙。 */

import { type SyntheticEvent, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import {
  ellipsizeAttachmentName,
  formatAttachmentSize,
  formatDimensions,
  formatDuration,
} from './attachment-format'
import { MEDIA_KIND_ICON, type MediaDescriptor, mediaDisplayName } from './media-descriptor'
import { UploadRing } from './upload-ring'

/** 媒体元素加载后读到的像素尺寸；时长只有视频有。 */
type MediaIntrinsic = { width: number; height: number; duration: number | undefined }

/** 卡与锚点间距，同时作为 hover 桥高度。 */
const TIP_GAP_PX = 6
/** 视口边距参考 Kimi --p-mention-tip-vmargin。 */
const TIP_VIEWPORT_MARGIN_PX = 12
/** 300px 预览区使用两倍分辨率 poster。 */
const POSTER_WIDTH_PX = 600

type TipPlacement = {
  left: number
  top: number
  side: 'bottom' | 'top'
  caretX: number
}

type MediaPreviewCardProps = {
  anchorEl: HTMLElement
  media: MediaDescriptor
  onEnter: () => void
  onLeave: () => void
  onEnlarge: () => void
}

export function MediaPreviewCard({
  anchorEl,
  media,
  onEnter,
  onLeave,
  onEnlarge,
}: MediaPreviewCardProps) {
  // 隐藏状态下测量后定位；挂载与媒体加载回调负责重新测量。
  const [placement, setPlacement] = useState<TipPlacement | null>(null)
  const tipElRef = useRef<HTMLDivElement | null>(null)
  const tipRef = (el: HTMLDivElement | null) => {
    tipElRef.current = el
    measure(el)
  }

  const measure = (tip: HTMLDivElement | null) => {
    if (tip === null) return
    const anchor = anchorEl.getBoundingClientRect()
    const rect = tip.getBoundingClientRect()
    const anchorCenterX = anchor.left + anchor.width / 2
    const left = Math.min(
      Math.max(anchorCenterX - rect.width / 2, TIP_VIEWPORT_MARGIN_PX),
      window.innerWidth - rect.width - TIP_VIEWPORT_MARGIN_PX,
    )
    const side = anchor.top >= rect.height + TIP_GAP_PX + TIP_VIEWPORT_MARGIN_PX ? 'top' : 'bottom'
    const next: TipPlacement = {
      caretX: Math.min(Math.max(anchorCenterX - left, 12), rect.width - 12),
      left,
      side,
      top: side === 'top' ? anchor.top - rect.height - TIP_GAP_PX : anchor.bottom + TIP_GAP_PX,
    }
    setPlacement((prev) =>
      prev !== null &&
      prev.left === next.left &&
      prev.top === next.top &&
      prev.side === next.side &&
      prev.caretX === next.caretX
        ? prev
        : next,
    )
  }

  // 宽高与时长从已加载的媒体元素上读，合同里的附件不带这些信息。
  const [intrinsic, setIntrinsic] = useState<MediaIntrinsic | null>(null)
  const onImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = event.currentTarget
    if (naturalWidth > 0 && naturalHeight > 0) {
      setIntrinsic({ width: naturalWidth, height: naturalHeight, duration: undefined })
    }
    measure(tipElRef.current)
  }
  const onVideoMetadata = (event: SyntheticEvent<HTMLVideoElement>) => {
    const { videoWidth, videoHeight, duration } = event.currentTarget
    if (videoWidth > 0 && videoHeight > 0) {
      setIntrinsic({
        width: videoWidth,
        height: videoHeight,
        duration: Number.isFinite(duration) ? duration : undefined,
      })
    }
    measure(tipElRef.current)
  }
  // 竖屏判定会改变媒体封顶高度；尺寸类名生效后重新定位，避免沿用旧卡高。
  const remeasure = useEffectEvent(() => measure(tipElRef.current))
  useLayoutEffect(() => remeasure(), [intrinsic])

  const name = mediaDisplayName(media)
  const isMedia = media.kind !== 'file'
  const { previewUrl, upload } = media
  const canEnlarge = isMedia && previewUrl !== undefined
  const details = [
    intrinsic === null ? null : formatDimensions(intrinsic.width, intrinsic.height),
    intrinsic?.duration === undefined ? null : formatDuration(intrinsic.duration),
    // 视频第二行只报尺寸与时长。
    media.size === undefined || media.kind === 'video' ? null : formatAttachmentSize(media.size),
  ]
    .filter((part) => part !== null)
    .join(' · ')
  // 只有竖屏放宽封顶高度；读到像素尺寸前按方形与横屏的 220 渲染。
  const mediaSizeClass = cn(
    'block max-w-[300px] rounded-sm object-contain',
    intrinsic !== null && intrinsic.height > intrinsic.width ? 'max-h-[320px]' : 'max-h-[220px]',
  )
  // 失败态由输入框的失败卡片承担，悬停卡只报上传中。
  const uploading = upload?.status === 'uploading' ? upload : undefined
  const hasSecondRow = uploading !== undefined || details !== '' || canEnlarge
  const meta = (
    <div className="media-tip-meta flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-1">
        <Icon
          className="media-tip-ink shrink-0"
          decorative
          name={MEDIA_KIND_ICON[media.kind]}
          size="sm"
        />
        <span className="min-w-0 truncate font-semibold" title={name}>
          {ellipsizeAttachmentName(name)}
        </span>
      </div>
      {hasSecondRow ? (
        <div className="flex min-w-0 items-center gap-2 pl-0.5">
          {uploading === undefined ? (
            <span className="media-tip-ink min-w-0 flex-1 truncate tabular-nums">{details}</span>
          ) : (
            <span className="media-tip-ink flex min-w-0 flex-1 items-center gap-1.5 truncate font-medium">
              <UploadRing progress={uploading.progress} size="xs" />
              {uploading.progress === undefined
                ? '上传中'
                : `上传中 ${Math.round(uploading.progress * 100)}%`}
            </span>
          )}
          {canEnlarge ? (
            <button className="media-tip-open ml-auto flex-none" onClick={onEnlarge} type="button">
              <Icon decorative name="zoom" size="sm" />
              放大
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )

  return createPortal(
    <div
      className={cn(
        'media-tip layer-popup fixed max-w-[min(320px,100vw-24px)] rounded-sm bg-inverse-surface text-body-sm text-inverse-on-surface',
        isMedia && 'media-tip-media-card rounded-md',
        placement === null ? 'pointer-events-none opacity-0' : 'opacity-100',
      )}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      ref={tipRef}
      role="tooltip"
      style={
        placement === null ? { left: 0, top: 0 } : { left: placement.left, top: placement.top }
      }
    >
      {isMedia ? (
        <div className="flex flex-col gap-1.5">
          <div className="media-tip-preview">
            {previewUrl === undefined ? (
              <div className="media-tip-hint">
                <Icon decorative name={MEDIA_KIND_ICON[media.kind]} size="lg" />
                <span>预览不可用</span>
              </div>
            ) : media.kind === 'image' ? (
              <img alt={name} className={mediaSizeClass} onLoad={onImageLoad} src={previewUrl} />
            ) : (
              // 仅展示静音首帧，不提供播放控件。
              <video
                aria-label={name}
                className={mediaSizeClass}
                muted
                onLoadedMetadata={onVideoMetadata}
                playsInline
                poster={videoSnapshotUrl(previewUrl, POSTER_WIDTH_PX)}
                preload="metadata"
                src={previewUrl}
              />
            )}
          </div>
          {meta}
        </div>
      ) : (
        meta
      )}
      {placement === null ? null : (
        <span
          aria-hidden
          className={cn(
            'media-tip-caret',
            placement.side === 'top' ? 'media-tip-caret-down' : 'media-tip-caret-up',
          )}
          style={{ left: placement.caretX }}
        />
      )}
    </div>,
    document.body,
  )
}
