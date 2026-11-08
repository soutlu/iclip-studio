import { useMemo } from 'react'
import { Icon } from '@/shared/icons'
import { MEDIA_KIND_ICON, mediaDisplayName } from '@/shared/ui/media-preview'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import type { ComposerAttachmentKind } from './use-composer-attachments'

type AttachmentFailureCardProps = {
  hostEl: HTMLElement
  container: HTMLElement | null
  kind: ComposerAttachmentKind
  name: string
  message: string
  open: boolean
  takeFocus: boolean
  onOpenChange: (open: boolean) => void
  onRetry: (() => void) | undefined
  onRemove: () => void
  onReturnFocus: () => void
}

export function AttachmentFailureCard({
  container,
  hostEl,
  kind,
  message,
  name,
  onOpenChange,
  onRemove,
  onRetry,
  onReturnFocus,
  open,
  takeFocus,
}: AttachmentFailureCardProps) {
  const anchorRef = useMemo(() => ({ current: hostEl }), [hostEl])
  const displayName = mediaDisplayName({ kind, name })

  return (
    <PopupRoot onOpenChange={onOpenChange} open={open}>
      <PopupAnchor virtualRef={anchorRef} />
      <PopupSurface
        aria-label={`${displayName}上传失败`}
        arrowClassName="fill-inverse-surface"
        className="w-[196px] rounded-md border-0 bg-inverse-surface p-1.5 text-body-sm text-inverse-on-surface backdrop-blur-none"
        collisionPadding={12}
        container={container}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (document.activeElement === null || document.activeElement === document.body) {
            onReturnFocus()
          }
        }}
        onOpenAutoFocus={(event) => {
          if (!takeFocus) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (event.target instanceof Node && hostEl.contains(event.target)) event.preventDefault()
        }}
        showArrow
        side="top"
        sideOffset={4}
      >
        <div className="flex min-w-0 items-center gap-1">
          <Icon
            className="media-tip-ink shrink-0"
            decorative
            name={MEDIA_KIND_ICON[kind]}
            size="sm"
          />
          <span className="min-w-0 truncate font-semibold" title={displayName}>
            {displayName}
          </span>
        </div>
        <p className="media-tip-danger mt-0.5 pl-0.5 font-medium">上传失败</p>
        <p className="media-tip-error mt-1.5">{message}</p>
        <div className="mt-1.5 flex gap-1.5">
          {onRetry === undefined ? null : (
            <button className="media-tip-open" onClick={onRetry} type="button">
              <Icon decorative name="redo" size="sm" />
              重试
            </button>
          )}
          <button className="media-tip-open" onClick={onRemove} type="button">
            <Icon decorative name="close" size="sm" />
            移除
          </button>
        </div>
      </PopupSurface>
    </PopupRoot>
  )
}
