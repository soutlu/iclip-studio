/** 参考 Kimi attachment-pill：NodeView 管理外层与选中态，React portal 渲染共用媒体内容；删除由原子节点退格操作处理。
 *  正常与上传中的 pill 悬停出预览卡、点击放大；失败的 pill 改为点开失败卡片，就地重试或移除。 */

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { MediaLightbox } from '@/shared/ui/media-lightbox'
import {
  MediaChipContent,
  type MediaDescriptor,
  MediaPreviewCard,
  type MediaUploadState,
  useHoverPreview,
} from '@/shared/ui/media-preview'
import { AttachmentFailureCard } from './attachment-failure-card'
import type { ComposerAttachment, ComposerAttachmentKind } from './use-composer-attachments'

type ComposerAttachmentPillProps = {
  hostEl: HTMLElement
  kind: ComposerAttachmentKind
  name: string
  /** 首帧尚未登记上传条目时为 undefined。 */
  entry: ComposerAttachment | undefined
  /** 失败卡片与悬停预览卡的挂载点：composer 根节点，见 AttachmentFailureCard。 */
  layerContainer: HTMLElement | null
  /** 失败卡片的开合由 composer 持有，编辑器里选中 pill 按 Enter 也能打开。 */
  failureCardOpen: boolean
  /** 键盘打开时焦点移进卡片。 */
  failureCardTakesFocus: boolean
  /** 点 pill 打开或关闭；打开时焦点留在编辑器。 */
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

  useEffect(() => {
    hostEl.classList.toggle('attachment-error', failed)
    hostEl.classList.toggle('attachment-uploading', entry?.status === 'uploading')
    return () => hostEl.classList.remove('attachment-error', 'attachment-uploading')
  }, [hostEl, entry?.status, failed])

  // NodeView span 使用原生监听；锚点与预览卡共用进入和离开回调。失败的 pill 由卡片代替预览，转失败时收起已开的预览。
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

  // 点 pill 本身：可预览的与卡上「放大」同一入口，失败的切换失败卡片。
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
      {tip.open && !viewing && entry !== undefined && !failed ? (
        <MediaPreviewCard
          anchorEl={hostEl}
          container={layerContainer}
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
        ? // 灯箱挂在 body，避免继承 contenteditable 样式。
          createPortal(
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
