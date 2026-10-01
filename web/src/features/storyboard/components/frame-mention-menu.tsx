/** 正文 `@` 选图的弹层：挂在光标下方（放不下时 Radix 翻到上方），列本组全部图片，末格「+」添加图片。
 *
 * 焦点始终留在编辑器里：格子不可聚焦、按下不抢焦点，键盘由编辑器插件转发过来；`active` 是键盘停在的那格。 */

import type { Ref, RefObject } from 'react'
import type { CaretAnchor } from '@/shared/ui/composer/mention'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import { FrameAddTile, FrameTile, type FrameAdd } from './frame-tile'

type FrameMentionMenuProps = {
  anchor: RefObject<CaretAnchor>
  /** 本组全部图片，下标 + 1 即帧号。 */
  frames: readonly string[]
  ratio: number
  /** 键盘停在第几格；等于 `frames.length` 时停在「+」。 */
  active: number
  add: FrameAdd
  listRef: Ref<HTMLUListElement>
  onPick: (frame: number) => void
  onClose: () => void
}

const keepEditorFocus = (event: { preventDefault: () => void }) => event.preventDefault()

export function FrameMentionMenu({
  active,
  add,
  anchor,
  frames,
  listRef,
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
            // 帧号就是这格的身份：同一张图可以占两个编号。
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
              blocker={add.blocker}
              onAdd={add.onAdd}
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
