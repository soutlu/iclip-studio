import {
  type RefObject,
  type SyntheticEvent,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
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
import { MediaCropper, type MediaPreviewCrop } from './media-cropper'
import { MEDIA_KIND_ICON, type MediaDescriptor, mediaDisplayName } from './media-descriptor'
import { UploadRing } from './upload-ring'

type MediaIntrinsic = { width: number; height: number; duration: number | undefined }

const TIP_GAP_PX = 6
const TIP_VIEWPORT_MARGIN_PX = 12
const POSTER_WIDTH_PX = 600

type TipPlacement = {
  left: number
  top: number
  side: 'bottom' | 'top'
  caretX: number
}

type MediaPreviewCardProps = {
  anchorEl: HTMLElement
  container?: HTMLElement | null
  media: MediaDescriptor
  details?: string | undefined
  crop?: MediaPreviewCrop | undefined
  cardRef?: RefObject<HTMLDivElement | null> | undefined
  onEnter: () => void
  onLeave: () => void
  onEnlarge: () => void
}

export function MediaPreviewCard({
  anchorEl,
  container = null,
  media,
  details: givenDetails,
  crop,
  cardRef,
  onEnter,
  onLeave,
  onEnlarge,
}: MediaPreviewCardProps) {
  const draggingRef = useRef(false)
  const hoveringRef = useRef(false)
  const enterTip = () => {
    hoveringRef.current = true
    onEnter()
  }
  const leaveTip = () => {
    hoveringRef.current = false
    if (!draggingRef.current) onLeave()
  }
  const endDrag = () => {
    draggingRef.current = false
    if (!hoveringRef.current) onLeave()
  }
  const [placement, setPlacement] = useState<TipPlacement | null>(null)
  const tipElRef = useRef<HTMLDivElement | null>(null)
  const originRef = useRef<{ x: number; y: number } | null>(null)
  const tipRef = (el: HTMLDivElement | null) => {
    tipElRef.current = el
    if (cardRef !== undefined) cardRef.current = el
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
    const top = side === 'top' ? anchor.top - rect.height - TIP_GAP_PX : anchor.bottom + TIP_GAP_PX
    originRef.current ??= { x: rect.left, y: rect.top }
    const origin = originRef.current
    const next: TipPlacement = {
      caretX: Math.min(Math.max(anchorCenterX - left, 12), rect.width - 12),
      left: left - origin.x,
      side,
      top: top - origin.y,
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
  const remeasure = useEffectEvent(() => measure(tipElRef.current))
  useLayoutEffect(() => remeasure(), [intrinsic])

  const name = mediaDisplayName(media)
  const isMedia = media.kind !== 'file'
  const { previewUrl, upload } = media
  const canEnlarge = isMedia && previewUrl !== undefined
  const details =
    givenDetails ??
    [
      intrinsic === null ? null : formatDimensions(intrinsic.width, intrinsic.height),
      intrinsic?.duration === undefined ? null : formatDuration(intrinsic.duration),
      media.size === undefined || media.kind === 'video' ? null : formatAttachmentSize(media.size),
    ]
      .filter((part) => part !== null)
      .join(' · ')
  const mediaSizeClass = cn(
    'block max-w-[300px] rounded-sm object-contain',
    intrinsic !== null && intrinsic.height > intrinsic.width ? 'max-h-[320px]' : 'max-h-[220px]',
  )
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
      onMouseEnter={enterTip}
      onMouseLeave={leaveTip}
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
            ) : media.kind === 'image' && crop !== undefined ? (
              <MediaCropper
                alt={name}
                className={mediaSizeClass}
                crop={crop}
                onDragEnd={endDrag}
                onDragStart={() => {
                  draggingRef.current = true
                }}
                onImageLoad={onImageLoad}
                src={previewUrl}
              />
            ) : media.kind === 'image' ? (
              <img alt={name} className={mediaSizeClass} onLoad={onImageLoad} src={previewUrl} />
            ) : (
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
    container ?? document.body,
  )
}
