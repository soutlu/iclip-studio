import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/shared/icons'
import { MediaLightbox } from '@/shared/ui/media-lightbox'
import {
  MediaChipContent,
  type MediaDescriptor,
  MediaPreviewCard,
  type MediaPreviewCrop,
  type MediaUploadState,
  useHoverPreview,
} from '@/shared/ui/media-preview'
import { AttachmentFailureCard } from './attachment-failure-card'
import type { ComposerAttachment, ComposerAttachmentKind } from './use-composer-attachments'

export type ComposerAttachmentPreview = {
  details?: string | undefined
  crop?: MediaPreviewCrop | undefined
}

type ComposerAttachmentPillProps = {
  hostEl: HTMLElement
  kind: ComposerAttachmentKind
  name: string
  entry: ComposerAttachment | undefined
  preview: ComposerAttachmentPreview | undefined
  layerContainer: HTMLElement | null
  failureCardOpen: boolean
  failureCardTakesFocus: boolean
  onFailureCardOpenChange: (open: boolean) => void
  onRetry: () => void
  onRemove: () => void
  focusEditor: () => void
}

const UPLOAD_FAILED = '上传失败'

const uploadStateOf = (entry: ComposerAttachment): MediaUploadState => {
  if (entry.status === 'uploading') return { progress: entry.progress, status: 'uploading' }
  if (entry.status === 'ready') return { status: 'ready' }
  return { message: entry.error ?? UPLOAD_FAILED, status: 'error' }
}

export function ComposerAttachmentPill({
  entry,
  failureCardOpen,
  failureCardTakesFocus,
  focusEditor,
  hostEl,
  kind,
  layerContainer,
  name,
  onFailureCardOpenChange,
  onRemove,
  onRetry,
  preview,
}: ComposerAttachmentPillProps) {
  const [viewing, setViewing] = useState(false)
  const tip = useHoverPreview()
  const { close, onEnter, onLeave } = tip
  const failed = entry?.status === 'error'
  const previewable = kind !== 'file' && entry?.previewUrl !== undefined && !failed
  const view = useCallback(() => {
    close()
    setViewing(true)
  }, [close])

  const needsCrop = preview?.crop !== undefined
  const neededCropRef = useRef(needsCrop)
  const autoOpenedRef = useRef(false)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const dismissArmedRef = useRef(false)
  useEffect(() => {
    const appeared = needsCrop && !neededCropRef.current
    neededCropRef.current = needsCrop
    if (!appeared || autoOpenedRef.current) return
    autoOpenedRef.current = true
    dismissArmedRef.current = true
    onEnter()
  }, [needsCrop, onEnter])
  useEffect(() => {
    if (!tip.open || !dismissArmedRef.current) return undefined
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && (hostEl.contains(target) || cardRef.current?.contains(target)))
        return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      dismissArmedRef.current = false
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [close, hostEl, tip.open])

  useEffect(() => {
    hostEl.classList.toggle('attachment-error', failed)
    hostEl.classList.toggle('attachment-uploading', entry?.status === 'uploading')
    return () => hostEl.classList.remove('attachment-error', 'attachment-uploading')
  }, [hostEl, entry?.status, failed])

  useEffect(() => {
    if (failed) {
      close()
      return undefined
    }
    hostEl.addEventListener('mouseenter', onEnter)
    hostEl.addEventListener('mouseleave', onLeave)
    return () => {
      hostEl.removeEventListener('mouseenter', onEnter)
      hostEl.removeEventListener('mouseleave', onLeave)
    }
  }, [close, failed, hostEl, onEnter, onLeave])

  useEffect(() => {
    if (failed) {
      const toggle = () => onFailureCardOpenChange(!failureCardOpen)
      hostEl.addEventListener('click', toggle)
      return () => hostEl.removeEventListener('click', toggle)
    }
    if (!previewable) return undefined
    hostEl.addEventListener('click', view)
    return () => hostEl.removeEventListener('click', view)
  }, [failed, failureCardOpen, hostEl, onFailureCardOpenChange, previewable, view])

  const upload = entry === undefined ? undefined : uploadStateOf(entry)
  const media: MediaDescriptor = {
    kind,
    name,
    previewUrl: entry?.previewUrl,
    size: entry?.size,
    upload,
  }

  return (
    <>
      <MediaChipContent media={media} />
      {needsCrop ? (
        <Icon className="media-chip-badge" label="已裁切" name="crop" size="xs" />
      ) : null}
      {tip.open && !viewing && entry !== undefined && !failed ? (
        <MediaPreviewCard
          anchorEl={hostEl}
          cardRef={cardRef}
          container={layerContainer}
          crop={preview?.crop}
          details={preview?.details}
          media={media}
          onEnter={onEnter}
          onLeave={onLeave}
          onEnlarge={view}
        />
      ) : null}
      {upload?.status === 'error' ? (
        <AttachmentFailureCard
          container={layerContainer}
          hostEl={hostEl}
          kind={kind}
          message={upload.message}
          name={name}
          onOpenChange={onFailureCardOpenChange}
          onRemove={onRemove}
          onRetry={entry?.file === undefined ? undefined : onRetry}
          onReturnFocus={focusEditor}
          open={failureCardOpen}
          takeFocus={failureCardTakesFocus}
        />
      ) : null}
      {viewing && media.previewUrl !== undefined
        ? createPortal(
            <MediaLightbox
              media={{
                kind: kind === 'video' ? 'video' : 'image',
                name,
                url: media.previewUrl,
              }}
              onClose={() => setViewing(false)}
            />,
            document.body,
          )
        : null}
    </>
  )
}
