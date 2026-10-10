/** 制作页正文 `@` 选图的弹层：向上弹出（放不下时 Radix 翻到下方），列这组参考图列表里能插入的图（机位图随选用进出列表，
 * 不在这里列），每格写 @N；有上传权限时末格「+」从电脑上传。格子与分镜页 `@` 选图同一种（`FrameTile`）。
 *
 * 焦点始终留在编辑器里：格子不可聚焦、按下不抢焦点，键盘由编辑器插件转发过来；`active` 是键盘停在的那格。 */

import type { Ref, RefObject } from 'react'
import type { CaretAnchor } from '@/shared/ui/composer/mention'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import { FrameAddTile, FrameTile } from '../components/frame-tile'
import type { FilmFrame } from './film.api'

type FilmMentionMenuProps = {
  anchor: RefObject<CaretAnchor>
  /** 能插入的图，都有编号。 */
  frames: readonly FilmFrame[]
  ratio: number
  /** 键盘停在第几格；等于 `frames.length` 时停在「+」。 */
  active: number
  /** 末格「+」：从电脑上传；没有上传权限时为 undefined，不给这一格。 */
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
