import type { Ref, RefObject } from 'react'
import type { CaretAnchor } from '@/shared/ui/composer/mention'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import { FrameAddTile, FrameTile } from '../components/frame-tile'
import type { FilmFrame } from './film.api'

type FilmMentionMenuProps = {
  anchor: RefObject<CaretAnchor>
  frames: readonly FilmFrame[]
  ratio: number
  active: number
  onUpload: (() => void) | undefined
  listRef: Ref<HTMLUListElement>
  onPick: (index: number) => void
  onClose: () => void
}

const keepEditorFocus = (event: { preventDefault: () => void }) => event.preventDefault()

export function FilmMentionMenu({
  active,
  anchor,
  frames,
  listRef,
  onClose,
  onPick,
  onUpload,
  ratio,
}: FilmMentionMenuProps) {
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
        side="top"
        sideOffset={8}
      >
        <ul
          aria-label="插入参考图"
          className="flex flex-wrap items-end gap-1"
          ref={listRef}
          role="listbox"
        >
          {frames.map((frame, index) => (
            <li key={frame.node} role="presentation">
              <FrameTile
                aria-label={`插入${frame.label}`}
                aria-selected={index === active}
                frame={frame.number ?? 0}
                onClick={() => onPick(index)}
                onPointerDown={keepEditorFocus}
                ratio={ratio}
                role="option"
                tabIndex={-1}
                title={frame.label}
                url={frame.url}
              />
            </li>
          ))}
          {onUpload === undefined ? null : (
            <li className="p-1 pb-6" role="presentation">
              <FrameAddTile
                aria-label="从电脑上传"
                aria-selected={active === frames.length}
                onClick={onUpload}
                onPointerDown={keepEditorFocus}
                role="option"
                tabIndex={-1}
              />
            </li>
          )}
        </ul>
      </PopupSurface>
    </PopupRoot>
  )
}
