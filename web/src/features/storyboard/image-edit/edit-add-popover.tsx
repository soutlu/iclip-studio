import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { FrameTile } from '../components/frame-tile'
import type { EditFrame } from './image-edit-types'

type EditAddPopoverProps = {
  frames: readonly EditFrame[]
  group: string
  ratio: number
  referenced: (url: string) => boolean
  blockedReason: (url: string) => string | undefined
  onInsert: (frame: number) => void
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
