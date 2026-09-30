/** 舞台右下的帧计数「1 / 2」：数的是当前段引用的帧；点开列出本组全部图片（含未被引用的），可切画面、开大图、添加图片。 */

import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import { IconButton } from '@/shared/ui/button'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { FrameAddTile, FrameTile, type FrameAdd } from './frame-tile'
import { workbenchControl } from './workbench-control'

export type FrameGallery = {
  /** 本组全部图片，下标 + 1 即帧号。 */
  urls: readonly string[]
  /** 舞台上正在看的帧。 */
  current: number | undefined
  /** 当前帧在当前段里排第几、这段共几帧；这段没有帧时为 undefined。 */
  position: { index: number; count: number } | undefined
  /** 图片任务有新结果、还没看过的帧。 */
  fresh: ReadonlySet<number>
  /** 这一帧被哪些段用着，放在格子的说明里。 */
  usageOf: (frame: number) => string
  onPick: (frame: number) => void
  onPreview: (frame: number) => void
}

type FrameCounterProps = {
  aspectRatio: string
  gallery: FrameGallery
  /** 弹层末尾的「+」，与舞台工具组里那个同一入口。 */
  add: FrameAdd
}

export function FrameCounter({ add, aspectRatio, gallery }: FrameCounterProps) {
  const [open, setOpen] = useState(false)
  const { current, fresh, position, urls } = gallery
  // 舞台上这张自己挂着角标；点只替看不到的那些亮。
  const freshElsewhere = [...fresh].some((frame) => frame !== current)
  const ratio = aspectValueOf(aspectRatio)
  return (
    <PopupRoot onOpenChange={setOpen} open={open}>
      <PopupTrigger asChild>
        <button
          aria-label={`${position === undefined ? '' : `第 ${position.index} / ${position.count} 帧，`}查看本组全部图片${freshElsewhere ? '，有新结果' : ''}`}
          className={workbenchControl({ shape: 'label', size: 'sm' })}
          title="本组全部图片"
          type="button"
        >
          {position === undefined ? (
            <Icon decorative name="image" size="sm" />
          ) : (
            `${position.index} / ${position.count}`
          )}
          {freshElsewhere ? <span aria-hidden className="storyboard-dot" /> : null}
          <Icon decorative name="expand" size="xs" />
        </button>
      </PopupTrigger>
      <PopupSurface
        align="end"
        aria-label="本组全部图片"
        className="max-h-[min(20rem,var(--radix-popover-content-available-height))] max-w-[min(28rem,calc(100vw-32px))] overflow-y-auto overscroll-contain p-1.5"
        collisionPadding={12}
        side="top"
        sideOffset={8}
      >
        <ul className="flex flex-wrap items-end gap-1">
          {urls.map((url, position) => {
            const frame = position + 1
            const selected = frame === current
            return (
              <li className="storyboard-gallery-item relative" key={frame}>
                <FrameTile
                  aria-current={selected ? 'true' : undefined}
                  aria-label={`第 ${frame} 帧${fresh.has(frame) ? '，有新结果' : ''}`}
                  frame={frame}
                  onClick={() => {
                    setOpen(false)
                    gallery.onPick(frame)
                  }}
                  outlined={selected}
                  ratio={ratio}
                  title={`@${frame} · ${gallery.usageOf(frame)}`}
                  url={url}
                />
                {fresh.has(frame) ? (
                  <span aria-hidden className="storyboard-dot absolute top-2 right-2" />
                ) : null}
                <IconButton
                  className="storyboard-gallery-zoom absolute right-2 bottom-7 size-5 rounded-xs bg-chip-bg-glass text-on-surface backdrop-blur-md"
                  label={`查看第 ${frame} 帧大图`}
                  name="zoom"
                  onClick={() => {
                    setOpen(false)
                    gallery.onPreview(frame)
                  }}
                  size="xs"
                />
              </li>
            )
          })}
          <li className="p-1 pb-6">
            <FrameAddTile
              blocker={add.blocker}
              onAdd={() => {
                setOpen(false)
                add.onAdd()
              }}
            />
          </li>
        </ul>
      </PopupSurface>
    </PopupRoot>
  )
}
