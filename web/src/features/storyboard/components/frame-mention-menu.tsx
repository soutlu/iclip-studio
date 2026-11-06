import type { Ref, RefObject } from 'react'
import type { CaretAnchor } from '@/shared/ui/composer/mention'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import { FrameAddTile, FrameTile } from './frame-tile'

type FrameMentionMenuProps = {
  anchor: RefObject<CaretAnchor>
  frames: readonly string[]
  ratio: number
  active: number
  onAdd: () => void
  listRef: Ref<HTMLUListElement>
  onPick: (frame: number) => void
  onClose: () => void
}

const keepEditorFocus = (event: { preventDefault: () => void }) => event.preventDefault()

export function FrameMentionMenu({
  active,
  anchor,
  frames,
  listRef,
  onAdd,
  onClose,
  onPick,
  ratio,
}: FrameMentionMenuProps) {
  return (
    <PopupRoot onOpenChange={(open) => !open && onClose()} open>
      <PopupAnchor virtualRef={anchor} />
      <PopupSurface
        align="start"
        aria-label="插入参考图"
        className="max-h-[min(20rem,var(--radix-popover-content-available-height))] max-w-[min(28rem,calc(100vw-32px))] overflow-y-auto overscroll-contain p-1.5"
        collisionPadding={12}
        onCloseAutoFocus={keepEditorFocus}
        onOpenAutoFocus={keepEditorFocus}
        side="bottom"
        sideOffset={4}
      >
        <ul
          aria-label="插入参考图"
          className="flex flex-wrap items-end gap-1"
          ref={listRef}
          role="listbox"
        >
          {frames.map((url, index) => {
            const frame = index + 1
            return (
              <li key={frame} role="presentation">
                <FrameTile
                  aria-label={`插入第 ${frame} 帧`}
                  aria-selected={index === active}
                  frame={frame}
                  onClick={() => onPick(frame)}
                  onPointerDown={keepEditorFocus}
                  ratio={ratio}
                  role="option"
                  tabIndex={-1}
                  url={url}
                />
              </li>
            )
          })}
          <li className="p-1 pb-6" role="presentation">
            <FrameAddTile
              aria-selected={active === frames.length}
              onClick={onAdd}
              onPointerDown={keepEditorFocus}
              role="option"
              tabIndex={-1}
            />
          </li>
        </ul>
      </PopupSurface>
    </PopupRoot>
  )
}
