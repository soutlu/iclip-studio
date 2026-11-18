import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import type { TimeSpan } from '@/shared/lib/time-spans'
import { useElementSize } from '@/shared/lib/use-element-size'
import { cn } from '@/shared/lib/utils'
import { bubbleAlign } from './bubble-align'
import type { PeaksState } from './media-analysis'
import type { PlaySegment } from './play-layout'
import { acquire } from './thumbnail-queue'
import { roundSeconds, timeLabel } from './time-label'
import { releasePointer, type Edge } from './timeline-drag'
import './timeline.css'

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60]

type TimelineRulerProps = {
  scale: number
  tickScale?: number | undefined
  total: number
  currentTime: number
  buffered?: readonly TimeSpan[] | undefined
  viewportRef: RefObject<HTMLDivElement | null>
  disabled?: boolean | undefined
  clockAt: (clientX: number) => number
  onSeek: (clock: number) => void
  onScrub: () => void
  /** 悬停、按住拖动时在时间尺上方出不出写着时间的气泡；不出时悬停照样画虚线。默认出。 */
  timeBubble?: boolean | undefined
  /** 给了时按住拖动定位改调它（可以吸附），键盘定位照旧调 `onSeek`。 */
  onPointerSeek?: ((clock: number) => void) | undefined
  /** 按住拖动定位松手或被取消。 */
  onSeekEnd?: (() => void) | undefined
}

export function TimelineRuler({
  scale,
  tickScale = scale,
  total,
  currentTime,
  buffered = [],
  viewportRef,
  disabled = false,
  clockAt,
  onSeek,
  onScrub,
  timeBubble = true,
  onPointerSeek,
  onSeekEnd,
}: TimelineRulerProps) {
  const [seekByPointer, setSeekByPointer] = useState(false)
  const [seeking, setSeeking] = useState(false)
  const seekPointerRef = useRef<number | null>(null)
  const [preview, setPreview] = useState<{
    time: number
    left: number
    top: number
  } | null>(null)
  useEffect(() => {
    const hide = () => setPreview(null)
    const hideOnScroll = (event: Event) => {
      if (
        event.target === window ||
        (event.target instanceof Node && event.target.contains(viewportRef.current))
      )
        hide()
    }
    window.addEventListener('scroll', hideOnScroll, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('scroll', hideOnScroll, true)
      window.removeEventListener('resize', hide)
    }
  }, [viewportRef])
  const previewAt = (event: PointerEvent<HTMLInputElement>) => {
    const time = Math.max(0, Math.min(total, clockAt(event.clientX)))
    const ruler = event.currentTarget.getBoundingClientRect()
    const viewport = viewportRef.current?.getBoundingClientRect() ?? ruler
    const width = 112
    const min = Math.max(8, viewport.left + 4)
    const max = Math.min(window.innerWidth - width - 8, viewport.right - width - 4)
    setPreview({
      time,
      left: Math.max(min, Math.min(max, ruler.left + (time / scale) * ruler.width - width / 2)),
      top: Math.max(8, ruler.top - 30),
    })
    return time
  }
  const tickStep =
    TICK_STEPS.find((step) => step >= tickScale / 8) ?? Math.ceil(tickScale / 8 / 60) * 60
  const ticks = Array.from({ length: Math.floor(scale / tickStep) + 1 }, (_, at) => at * tickStep)
  const boundedTime = Math.max(0, Math.min(total, currentTime))
  const seekPointer = (event: PointerEvent<HTMLInputElement>) => {
    const seek = onPointerSeek ?? onSeek
    seek(previewAt(event))
  }
  const finishSeek = (event: PointerEvent<HTMLInputElement>) => {
    if (seekPointerRef.current !== event.pointerId) return
    seekPointerRef.current = null
    setSeeking(false)
    setPreview(null)
    releasePointer(event)
    onSeekEnd?.()
  }
  return (
    <>
      <div className="timeline-ruler">
        {ticks.map((time) => (
          <span
            aria-hidden="true"
            className={cn(
              'timeline-tick',
              time === 0 && 'is-first',
              time + tickStep > scale && time > 0 && 'is-last',
            )}
            key={time}
            style={{ left: `${(time / scale) * 100}%` }}
          >
            {roundSeconds(time)}s
          </span>
        ))}
        {buffered.map(({ start, end }) => (
          <span
            aria-hidden="true"
            className="timeline-buffered"
            data-testid="timeline-buffered"
            key={start}
            style={{
              left: `${(start / scale) * 100}%`,
              width: `${((Math.min(end, total) - start) / scale) * 100}%`,
            }}
          />
        ))}
        <input
          aria-label="时间线播放位置"
          aria-valuetext={timeLabel(boundedTime)}
          className="timeline-seek"
          data-pointer={seekByPointer ? '' : undefined}
          data-seeking={seeking ? '' : undefined}
          disabled={disabled}
          max={scale}
          min={0}
          onBlur={() => {
            setSeekByPointer(false)
            setPreview(null)
          }}
          onChange={(event) => {
            onScrub()
            onSeek(Math.min(total, Number(event.target.value)))
          }}
          onKeyDown={() => {
            setSeekByPointer(false)
            setPreview(null)
          }}
          onPointerDown={(event) => {
            if (disabled || event.button !== 0) return
            event.preventDefault()
            event.stopPropagation()
            setSeekByPointer(true)
            setSeeking(true)
            event.currentTarget.focus()
            event.currentTarget.setPointerCapture(event.pointerId)
            seekPointerRef.current = event.pointerId
            onScrub()
            seekPointer(event)
          }}
          onPointerMove={(event) => {
            if (seekPointerRef.current === event.pointerId) seekPointer(event)
            else if (!disabled && event.pointerType !== 'touch') previewAt(event)
          }}
          onPointerLeave={() => {
            if (seekPointerRef.current === null) setPreview(null)
          }}
          onPointerUp={finishSeek}
          onPointerCancel={finishSeek}
          step={0.01}
          type="range"
          value={boundedTime}
        />
        {preview === null || !timeBubble
          ? null
          : createPortal(
              <span
                aria-hidden="true"
                className="timeline-time-preview"
                style={{ left: preview.left, top: preview.top }}
              >
                <span>{seeking ? '定位' : '预览'}</span>
                <b>{timeLabel(preview.time)}</b>
              </span>,
              document.body,
            )}
      </div>
      {preview !== null && !seeking ? (
        <span
          aria-hidden="true"
          className="timeline-hover-guide"
          data-testid="timeline-hover-guide"
          style={{ left: `${(preview.time / scale) * 100}%` }}
        />
      ) : null}
    </>
  )
}

/**
 * 播放头，不接收指针。编辑器自己让人按住竖线拖着定位时给出 `dragging`（final-cut），拖着时头画成按下的样子；
 * 不给时（编辑视频）没有这个状态。
 */
export function TimelinePlayhead({
  style,
  dragging,
}: {
  style: CSSProperties
  dragging?: boolean | undefined
}) {
  if (dragging === undefined)
    return <span aria-hidden="true" className="timeline-playhead" style={style} />
  return (
    <span
      aria-hidden="true"
      className="timeline-playhead"
      data-dragging={dragging ? '' : undefined}
      data-testid="timeline-playhead"
      style={style}
    />
  )
}

type LimitBubbleProps = {
  text: string
  left: string
  viewportRef: RefObject<HTMLElement | null>
}

export function LimitBubble({ text, left, viewportRef }: LimitBubbleProps) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const bubble = ref.current
    const viewport = viewportRef.current
    const parent = bubble?.offsetParent
    if (bubble === null || viewport === null || parent === null || parent === undefined) return
    const view = viewport.getBoundingClientRect()
    const align = bubbleAlign(
      parent.getBoundingClientRect().left + bubble.offsetLeft - view.left,
      view.width,
    )
    bubble.classList.toggle('is-start', align === 'is-start')
    bubble.classList.toggle('is-end', align === 'is-end')
  })
  return (
    <span className="timeline-limit-bubble" ref={ref} role="status" style={{ left }}>
      <Icon decorative name="blocked" size="xs" />
      {text}
    </span>
  )
}

const MAX_FRAMES = 24
const FRAME_STEP = 0.5
const FRAME_SNAP = FRAME_STEP / 2
const MIN_FRAME_PX = 48

/** 一张缩略图盖多少秒素材：从 0.5 秒起翻倍，到每张至少 `MIN_FRAME_PX` 宽、整段不超过 `MAX_FRAMES` 张为止。 */
const frameStepOf = (length: number, width: number) => {
  let step = FRAME_STEP
  while (step * width < MIN_FRAME_PX * length || Math.ceil(length / step) + 1 > MAX_FRAMES)
    step *= 2
  return step
}

/**
 * 格子对齐在素材时间的整格上，裁剪时中间的格子不动；每格取它落在这一段里那一截的正中，
 * 图不会来自这一段以外的画面。
 */
const frameCells = (part: PlaySegment, step: number) => {
  const first = Math.floor(part.start / step)
  const last = Math.max(first, Math.ceil(part.end / step) - 1)
  return Array.from({ length: last - first + 1 }).flatMap((_, at) => {
    const from = (first + at) * step
    const shown = (Math.max(from, part.start) + Math.min(from + step, part.end)) / 2
    const src = videoSnapshotUrl(part.mediaUrl, 96, Math.round(shown / FRAME_SNAP) * FRAME_SNAP)
    return src === undefined ? [] : [{ from, src }]
  })
}

export function Frames({ part }: { part: PlaySegment }) {
  const [frames, { width }] = useElementSize<HTMLSpanElement>()
  const length = Math.max(0, part.end - part.start)
  const step = width > 0 ? frameStepOf(length, width) : undefined
  const cells = step === undefined ? [] : frameCells(part, step)
  const percent = (seconds: number) => `${length > 0 ? (seconds / length) * 100 : 0}%`
  return (
    <span className="timeline-frames" ref={frames}>
      {step === undefined ? null : cells.length === 0 ? (
        <Icon decorative name="video" size="sm" />
      ) : (
        cells.map(({ from, src }) => (
          <Frame
            key={`${from} ${src}`}
            src={src}
            style={{
              left: percent(from - part.start),
              width: length > 0 ? percent(step) : '100%',
            }}
          />
        ))
      )}
    </span>
  )
}

const loadedFrames = new Set<string>()

function Frame({ src, style }: { src: string; style: CSSProperties }) {
  const [failed, setFailed] = useState(false)
  const [started, setStarted] = useState(() => loadedFrames.has(src))
  const placeholderRef = useRef<HTMLSpanElement>(null)
  const turnRef = useRef<(() => void) | null>(null)
  const release = useCallback(() => {
    turnRef.current?.()
    turnRef.current = null
  }, [])
  useEffect(() => release, [release])
  // 不用 loading="lazy"：懒加载的图不开始下载就一直占着名额。
  useEffect(() => {
    const placeholder = placeholderRef.current
    if (started || placeholder === null) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.at(-1)?.isIntersecting === true)
        turnRef.current ??= acquire(() => setStarted(true))
      else release()
    })
    observer.observe(placeholder)
    return () => observer.disconnect()
  }, [started, release])
  return failed || !started ? (
    <span className="timeline-frame-empty" ref={placeholderRef} style={style} />
  ) : (
    <img
      alt=""
      draggable={false}
      onError={() => {
        setFailed(true)
        release()
      }}
      onLoad={() => {
        loadedFrames.add(src)
        release()
      }}
      src={src}
      style={style}
    />
  )
}

/**
 * 一段素材的波形。`level` 给了时，每一处的高低再乘上它在那里的值（参数是这一处在这段里的位置，0 到 1），用来让
 * 波形跟着音量、淡入淡出变高变矮；不给时按素材原样画。
 */
export function Wave({
  part,
  state,
  level,
}: {
  part: PlaySegment
  state: PeaksState
  level?: (fraction: number) => number
}) {
  const body = (() => {
    switch (state.kind) {
      case 'loading':
        return <span className="timeline-wave-loading" />
      case 'silent':
        return <span className="timeline-wave-note">无声</span>
      case 'failed':
        return <span className="timeline-wave-note">原声读取失败</span>
      case 'ready': {
        const { rate, peaks } = state.peaks
        const from = Math.floor(part.start * rate)
        const count = Math.max(1, Math.ceil(part.end * rate) - from)
        let path = ''
        for (let at = 0; at < count; at += 1) {
          const scaled = (peaks[from + at] ?? 0) * 92 * (level?.((at + 0.5) / count) ?? 1)
          const height = Math.max(4, Math.min(100, scaled))
          path += `M${at + 0.5} ${50 - height / 2}v${height}`
        }
        return (
          <svg data-testid="timeline-wave" preserveAspectRatio="none" viewBox={`0 0 ${count} 100`}>
            <path d={path} />
          </svg>
        )
      }
    }
  })()
  return <span className="timeline-wave">{body}</span>
}

type TrimHandleProps = {
  edge: Edge
  value: number
  /** 这一端能拖到的范围（秒）；往后没有上限时 `max` 是无穷大，这时不写最大值。 */
  bounds: { min: number; max: number }
  valueText: string
  pressed: boolean
  style: CSSProperties
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void
}

export function TrimHandle({
  edge,
  value,
  bounds,
  valueText,
  pressed,
  style,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: TrimHandleProps) {
  return (
    <button
      aria-label={edge === 'start' ? '裁剪开头' : '裁剪结尾'}
      aria-valuemax={Number.isFinite(bounds.max) ? roundSeconds(bounds.max) : undefined}
      aria-valuemin={roundSeconds(bounds.min)}
      aria-valuenow={roundSeconds(value)}
      aria-valuetext={valueText}
      className={cn('timeline-handle', `is-${edge}`, pressed && 'is-pressed')}
      onKeyDown={onKeyDown}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="slider"
      style={style}
      title="拖动可裁剪，按方向键可微调，按住 Shift 每次调整 1 秒"
      type="button"
    />
  )
}
