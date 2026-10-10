/** 输入卡左下角的「+」：弹出本组的图片（分镜页叫帧，含当前这一帧 @1），点一张插到光标处；下面一行「从电脑上传」。
 *
 * 带勾只表示正文里已引用，再点照样插入，提交时按地址去重。 */

import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { FrameTile } from '../components/frame-tile'
import type { EditFrame } from './image-edit-types'

type EditAddPopoverProps = {
  /** 本组的图片，下标 + 1 即编号。 */
  frames: readonly EditFrame[]
  /** 它们的统称：分镜页叫帧，制作页叫图。 */
  group: string
  ratio: number
  /** 这张图正文里已经引用了。 */
  referenced: (url: string) => boolean
  /** 这一张此刻不能插（图片已到上限）时给出原因。 */
  blockedReason: (url: string) => string | undefined
  onInsert: (frame: number) => void
  /** 没有上传权限时为 undefined，不给「从电脑上传」。 */
  onUpload: (() => void) | undefined
}

export function EditAddPopover({
  blockedReason,
  frames,
  group,
  onInsert,
  onUpload,
  ratio,
  referenced,
}: EditAddPopoverProps) {
  const [open, setOpen] = useState(false)
  // 插了图焦点已回到正文，关弹层时不再还给「+」。
  const [inserted, setInserted] = useState(false)

  return (
    <PopupRoot
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setInserted(false)
      }}
      open={open}
    >
      <PopupTrigger asChild>
        <IconButton label="添加参考图" name="add" size="md" />
      </PopupTrigger>
      <PopupSurface
        align="start"
        aria-label="添加参考图"
        className="max-w-[min(30rem,calc(100vw-32px))] p-1.5"
        collisionPadding={12}
        onCloseAutoFocus={(event) => {
          if (inserted) event.preventDefault()
        }}
        side="top"
        sideOffset={8}
      >
        <ul aria-label={`本组的${group}`} className="flex max-h-60 flex-wrap gap-1 overflow-y-auto">
          {frames.map(({ name, number, url }, index) => {
            // `frame` 是在列表里的先后，插入时按它取；图块上写的编号以图自己给的为准。
            const frame = index + 1
            const used = referenced(url)
            const blocked = blockedReason(url)
            return (
              <li className="relative" key={frame}>
                <FrameTile
                  aria-label={`插入${name}${used ? '（已引用）' : ''}`}
                  className="disabled:cursor-not-allowed disabled:opacity-(--state-disabled-content)"
                  disabled={blocked !== undefined}
                  frame={number ?? frame}
                  onClick={() => {
                    setInserted(true)
                    setOpen(false)
                    onInsert(frame)
                  }}
                  outlined={used}
                  ratio={ratio}
                  title={blocked ?? (used ? '正文中已引用，再次点击仍会插入' : '插入到光标处')}
                  url={url}
                />
                {used ? (
                  <span
                    aria-hidden
                    className="absolute top-2 right-2 grid size-4 place-items-center rounded-full bg-inverse-surface text-inverse-on-surface"
                  >
                    <Icon decorative name="check" size="xs" />
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
        {onUpload === undefined ? null : (
          <>
            <div className="mx-1.5 my-1 h-px bg-outline-variant" role="presentation" />
            <button
              className="flex h-9 w-full ui-state cursor-pointer items-center gap-2 rounded-sm px-2.5 text-body-sm text-on-surface ui-focus"
              onClick={() => {
                setOpen(false)
                onUpload()
              }}
              type="button"
            >
              <Icon decorative name="add-file" size="sm" />
              从电脑上传
            </button>
          </>
        )}
      </PopupSurface>
    </PopupRoot>
  )
}
