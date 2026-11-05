import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import { IconButton } from '@/shared/ui/button'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { FrameTile } from './frame-tile'

export type FrameGallery = {
  urls: readonly string[]
  current: number | undefined
  position: { index: number; count: number } | undefined
  fresh: ReadonlySet<number>
  usageOf: (frame: number) => string
  onPick: (frame: number) => void
  onPreview: (frame: number) => void
}

type FrameCounterProps = {
  aspectRatio: string
  gallery: FrameGallery
}

export function FrameCounter({ aspectRatio, gallery }: FrameCounterProps) {
  const [open, setOpen] = useState(false)
  const { current, fresh, position, urls } = gallery
  const freshElsewhere = [...fresh].some((frame) => frame !== current)
  const ratio = aspectValueOf(aspectRatio)
  return (
    <PopupRoot onOpenChange={setOpen} open={open}>
      <PopupTrigger asChild>
        <button
          aria-label={`${position === undefined ? '' : `第 ${position.index} / ${position.count} 帧，`}查看本组全部图片${freshElsewhere ? '，有新结果' : ''}`}
          className="storyboard-stage-glass storyboard-stage-counter ui-state ui-focus"
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
        align="center"
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
        </ul>
      </PopupSurface>
    </PopupRoot>
  )
}
