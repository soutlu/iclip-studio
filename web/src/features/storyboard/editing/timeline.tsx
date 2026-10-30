import {
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
import { cn } from '@/shared/lib/utils'
import { bubbleAlign } from './bubble-align'
import type { PeaksState } from './media-analysis'
import type { PlaySegment } from './play-layout'
import { roundSeconds, timeLabel } from './time-label'
import { releasePointer, type Edge } from './timeline-drag'
import './timeline.css'

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60]

type TimelineRulerProps = {
  /** 标尺铺满的秒数：刻度一直标到这里。 */
  scale: number
  /** 刻度间隔按这么多秒定；不给就按 `scale`。 */
  tickScale?: number | undefined
  total: number
  currentTime: number
  viewportRef: RefObject<HTMLDivElement | null>
  disabled?: boolean | undefined
  clockAt: (clientX: number) => number
  onSeek: (clock: number) => void
  onScrub: () => void
}

export function TimelineRuler({
  scale,
  tickScale = scale,
  total,
  currentTime,
  viewportRef,
  disabled = false,
  clockAt,
  onSeek,
  onScrub,
}: TimelineRulerProps) {
  // 指针与键盘都由定位头内部变色表示状态，刻度区域不加外框。
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
      // 背景会话的自动滚动不会移动标尺，不应清掉编辑器里的提示。
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
    onSeek(previewAt(event))
  }
  const finishSeek = (event: PointerEvent<HTMLInputElement>) => {
    if (seekPointerRef.current !== event.pointerId) return
    seekPointerRef.current = null
    setSeeking(false)
    setPreview(null)
    releasePointer(event)
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
        {preview === null
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

export function TimelinePlayhead({ style }: { style: CSSProperties }) {
  return <span aria-hidden="true" className="timeline-playhead" style={style} />
}

type LimitBubbleProps = {
  text: string
  /** 把手离内容层左边多远（CSS 长度）。 */
  left: string
  /** 时间线的横向滚动区：把手离它可视范围两端太近时气泡靠向里面。 */
  viewportRef: RefObject<HTMLElement | null>
}

/**
 * 拖到边界停住时把手旁的说明（为什么拖不过去），两个编辑器共用。气泡以把手为中心，把手贴近时间线可视范围两端时
 * 收回来、靠向里面；每次画完按把手此刻在可视范围里的位置定（拖动中自动滚动的每一步都会重画）。
 */
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

/** 画面行最多画几格。 */
const MAX_FRAMES = 24
/** 格宽从这么多秒起，格子太多时翻倍。 */
const FRAME_STEP = 0.5

/** 格宽：0.5 秒 × 2^k 里放得下 `length` 秒、格子不超过上限的最小值（两端各可能多出被裁掉的一格）。 */
const frameStepOf = (length: number) => {
  let step = FRAME_STEP
  while (Math.ceil(length / step) + 1 > MAX_FRAMES) step *= 2
  return step
}

/**
 * 一段素材的画面行。格子按素材自己的时间铺：从 0 秒起、每格 `step` 秒、取格子中点那一帧，只画与这一段有重叠
 * 的格子，两端的格子被边裁掉。起止变了只在两端增减格子，中间的图不换地址、不重新请求；同一素材的不同段命中
 * 同一批地址。格宽只看长度，跨过阈值才换一次。
 */
export function Frames({ part }: { part: PlaySegment }) {
  const length = Math.max(0, part.end - part.start)
  const step = frameStepOf(length)
  const first = Math.floor(part.start / step)
  const last = Math.max(first, Math.ceil(part.end / step) - 1)
  const cells = Array.from({ length: last - first + 1 }).flatMap((_, at) => {
    const from = (first + at) * step
    const src = videoSnapshotUrl(part.mediaUrl, 96, from + step / 2)
    return src === undefined ? [] : [{ from, src }]
  })
  const percent = (seconds: number) => `${length > 0 ? (seconds / length) * 100 : 0}%`
  return (
    <span className="timeline-frames">
      {cells.length === 0 ? (
        <Icon decorative name="video" size="sm" />
      ) : (
        cells.map(({ from, src }) => (
          <Frame
            key={src}
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

function Frame({ src, style }: { src: string; style: CSSProperties }) {
  const [failed, setFailed] = useState(false)
  return failed ? (
    <span className="timeline-frame-empty" style={style} />
  ) : (
    <img alt="" draggable={false} onError={() => setFailed(true)} src={src} style={style} />
  )
}

export function Wave({ part, state }: { part: PlaySegment; state: PeaksState }) {
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
          const height = Math.max(4, (peaks[from + at] ?? 0) * 92)
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
      aria-valuemax={roundSeconds(bounds.max)}
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
