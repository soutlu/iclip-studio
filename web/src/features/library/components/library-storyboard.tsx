import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '@/shared/icons'
import { aspectOf } from '@/shared/lib/aspect-ratio'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { useHoverPreview } from '@/shared/ui/media-preview'
import { PopupAnchor, PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import type { LibraryVideo } from '../library.api'
import { snapshotWidthFor } from '../library-layout'
import { cutCountOf, formatClock, formatSecond, keyframesOf, type Keyframe } from '../library-media'

const canHover = () => window.matchMedia('(hover: hover)').matches

type StoryboardVideo = Pick<LibraryVideo, 'face' | 'take'>

type StoryboardBadgeProps = {
  video: StoryboardVideo
  seconds: number | null
  compact: boolean
  onFocusFrame: (at: number | null) => void
  onPickFrame: (at: number) => void
}

export function StoryboardBadge({
  video,
  seconds,
  compact,
  onFocusFrame,
  onPickFrame,
}: StoryboardBadgeProps) {
  const hover = useHoverPreview()
  const [pinned, setPinned] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const frames = keyframesOf(video.take, seconds)
  const cuts = cutCountOf(video.take)
  if (frames.length === 0) return null

  const open = pinned || hover.open
  const close = () => {
    setPinned(false)
    hover.close()
  }
  const pick = (at: number) => {
    close()
    setSheetOpen(false)
    onPickFrame(at)
  }
  const hovering = (event: React.PointerEvent) => event.pointerType !== 'touch' && canHover()
  const hoverProps = {
    onPointerEnter: (event: React.PointerEvent) => {
      if (hovering(event)) hover.onEnter()
    },
    onPointerLeave: (event: React.PointerEvent) => {
      if (hovering(event)) hover.onLeave()
    },
  }
  const label = `故事板：${cuts === null ? `${frames.length} 段` : `${cuts} 镜`}${seconds === null ? '' : `，${formatClock(seconds)}`}`

  return (
    <>
      <PopupRoot
        onOpenChange={(next) => {
          if (next) setPinned(true)
          else close()
        }}
        open={open}
      >
        <PopupTrigger asChild>
          <button
            aria-label={label}
            className="library-card-badge library-storyboard-badge absolute top-2 right-2 cursor-pointer ui-focus"
            onClick={(event) => {
              if (canHover()) return
              event.preventDefault()
              setSheetOpen(true)
            }}
            type="button"
            {...hoverProps}
          >
            <Icon decorative name="grid" size="xs" />
            {cuts === null ? null : `${cuts} 镜`}
            {cuts !== null && seconds !== null && !compact ? (
              <span aria-hidden className="library-card-badge-divider" />
            ) : null}
            {seconds === null || (compact && cuts !== null) ? null : formatClock(seconds)}
          </button>
        </PopupTrigger>
        <PopupAnchor className="pointer-events-none absolute inset-0" />
        {open ? (
          <PopupSurface
            align="start"
            aria-label="故事板"
            className="w-max max-w-[min(760px,calc(100vw-24px))] min-w-70 p-3.5 pb-3"
            collisionPadding={12}
            onOpenAutoFocus={(event) => {
              if (!pinned) event.preventDefault()
            }}
            side="right"
            sideOffset={12}
            {...hoverProps}
          >
            <StoryboardStrip
              frames={frames}
              heading
              onFocusFrame={onFocusFrame}
              onPick={pick}
              seconds={seconds}
              video={video}
            />
          </PopupSurface>
        ) : null}
      </PopupRoot>

      <DialogRoot onOpenChange={setSheetOpen} open={sheetOpen}>
        {sheetOpen ? (
          <DialogSurface aria-describedby={undefined}>
            <DialogHeader closeLabel="关闭故事板" title="故事板" />
            <DialogBody className="px-4 pt-3 pb-5">
              <StoryboardStrip
                frames={frames}
                heading={false}
                onFocusFrame={onFocusFrame}
                onPick={pick}
                seconds={seconds}
                video={video}
              />
            </DialogBody>
          </DialogSurface>
        ) : null}
      </DialogRoot>
    </>
  )
}

type StoryboardStripProps = {
  video: StoryboardVideo
  frames: readonly Keyframe[]
  seconds: number | null
  heading: boolean
  onFocusFrame: (at: number | null) => void
  onPick: (at: number) => void
}

function StoryboardStrip({
  video,
  frames,
  seconds,
  heading,
  onFocusFrame,
  onPick,
}: StoryboardStripProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(0)
  const { w, h } = aspectOf(video.take.aspectRatio)
  const frameHeight = w < h ? 132 : 96
  const snapshotWidth = snapshotWidthFor((frameHeight * w) / h, window.devicePixelRatio || 1)
  const scripted = video.take.script !== null
  const total = frames.at(-1)?.end ?? seconds ?? 0
  const current = frames[focused] ?? frames[0]

  const focusFrame = (order: number) => {
    const frame = frames[order]
    if (frame === undefined || order === focused) return
    setFocused(order)
    onFocusFrame(frame.at)
  }

  const announce = useEffectEvent((mounted: boolean) =>
    onFocusFrame(mounted ? (frames[0]?.at ?? null) : null),
  )
  useEffect(() => {
    announce(true)
    return () => announce(false)
  }, [])

  // React onWheel 默认使用被动监听器，需通过原生非被动监听器调用 preventDefault。
  useEffect(() => {
    const root = rootRef.current
    const strip = stripRef.current
    if (root === null || strip === null) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      strip.scrollLeft += delta * unit
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [])

  const onFrameKeyDown = (event: KeyboardEvent<HTMLButtonElement>, order: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const buttons = stripRef.current?.querySelectorAll('button')
    const next = buttons?.item(order + (event.key === 'ArrowRight' ? 1 : -1))
    if (next === undefined || next === null) return
    event.preventDefault()
    next.focus()
  }

  return (
    <div className="library-storyboard" ref={rootRef}>
      <div className="mb-2.5 flex items-baseline justify-between gap-4">
        {heading ? <b className="text-body-sm font-semibold text-on-surface">故事板</b> : null}
        <span className="text-caption whitespace-nowrap text-on-surface-faint">
          {scripted ? `${frames.length} 镜` : `${frames.length} 段`} · {formatSecond(total)} 秒
          {scripted ? '' : ' · 均匀取帧'}
        </span>
      </div>
      <div aria-hidden className="mb-2.5 flex h-1 gap-0.5">
        {frames.map((frame, order) => (
          <span
            className={cn(
              'rounded-full ui-motion-s',
              order === focused ? 'bg-on-surface' : 'bg-surface-container-highest',
            )}
            key={frame.index}
            style={{ flex: `${frame.end - frame.start} 1 0` }}
          />
        ))}
      </div>
      <div className="library-storyboard-strip flex gap-1.5 overflow-x-auto pb-1" ref={stripRef}>
        {frames.map((frame, order) => {
          const src = videoSnapshotUrl(video.face.outputUrl, snapshotWidth, frame.at)
          return (
            <button
              aria-label={`${scripted ? '镜头' : '第'} ${frame.index}${scripted ? '' : ' 段'}，${formatSecond(frame.start)} 秒起，打开详情`}
              className="library-storyboard-frame shrink-0 cursor-pointer rounded-sm text-left ui-focus"
              data-current={order === focused || undefined}
              key={frame.index}
              onClick={() => onPick(frame.start)}
              onFocus={() => focusFrame(order)}
              onKeyDown={(event) => onFrameKeyDown(event, order)}
              onPointerEnter={() => focusFrame(order)}
              type="button"
            >
              <span
                className="library-storyboard-thumb relative block overflow-hidden rounded-sm bg-thumb-fallback"
                style={{ aspectRatio: `${w} / ${h}`, height: frameHeight }}
              >
                {src === undefined ? null : (
                  <img alt="" className="size-full object-contain" loading="lazy" src={src} />
                )}
                <span className="library-card-badge absolute top-1 left-1">{frame.index}</span>
              </span>
              <span className="mt-1 block font-mono text-caption text-on-surface-faint">
                {formatSecond(frame.start)}–{formatSecond(frame.end)}s
              </span>
            </button>
          )
        })}
      </div>
      {current === undefined ? null : (
        <p className="mt-2 line-clamp-2 min-h-11.5 border-t border-hairline pt-2.5 text-caption text-on-surface-variant">
          <b className="mr-1.5 font-semibold text-on-surface">
            {scripted ? `镜头 ${current.index}` : `第 ${current.index} 段`}
          </b>
          <span className="mr-1.5 font-mono text-on-surface-faint">
            {formatSecond(current.start)}–{formatSecond(current.end)}s
          </span>
          {current.prompt === null
            ? '该视频没有分镜脚本，已按时长均匀取帧'
            : current.prompt.replace(/@Image\d+\s?/g, '')}
        </p>
      )}
    </div>
  )
}
