/** 失败附件的就地卡片：原因 +「重试」「移除」。外观沿用悬停预览卡的反相底，挂在 composer 内，不进 body。 */

import { useMemo } from 'react'
import { Icon } from '@/shared/icons'
import { MEDIA_KIND_ICON, mediaDisplayName } from '@/shared/ui/media-preview'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import type { ComposerAttachmentKind } from './use-composer-attachments'

type AttachmentFailureCardProps = {
  hostEl: HTMLElement
  /** 卡片挂载点：composer 根节点。编辑区会滚动裁切，模态弹窗外又点不到，所以不挂 chip 里也不挂 body。 */
  container: HTMLElement | null
  kind: ComposerAttachmentKind
  name: string
  message: string
  open: boolean
  /** 打开时是否把焦点移进卡片（落在第一个按钮上）。 */
  takeFocus: boolean
  onOpenChange: (open: boolean) => void
  /** 没有原文件可重传时为 undefined，不给「重试」。 */
  onRetry: (() => void) | undefined
  onRemove: () => void
  /** 卡片没有 Trigger，Radix 关闭后不还焦点，由这里交回编辑器。 */
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
          // 点到别的控件时焦点已经有去处，不抢回来。
          if (document.activeElement === null || document.activeElement === document.body) {
            onReturnFocus()
          }
        }}
        onOpenAutoFocus={(event) => {
          if (!takeFocus) event.preventDefault()
        }}
        // 再点 chip 由 chip 自己切换开合，免得这里先关、chip 的 click 又打开。
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
