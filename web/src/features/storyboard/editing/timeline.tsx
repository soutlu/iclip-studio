import {
  useEffect,
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
import type { PeaksState } from './media-analysis'
import type { PlaySegment } from './play-layout'
import { roundSeconds, timeLabel } from './time-label'
import { releasePointer, type Edge } from './timeline-drag'
import './timeline.css'

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60]

type TimelineRulerProps = {
  scale: number
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
  const tickStep = TICK_STEPS.find((step) => step >= scale / 8) ?? Math.ceil(scale / 8 / 60) * 60
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

export function Frames({ part }: { part: PlaySegment }) {
  const length = part.end - part.start
  const count = Math.max(1, Math.min(24, Math.round(length * 2)))
  const shots = Array.from({ length: count }).flatMap((_, at) => {
    const url = videoSnapshotUrl(part.mediaUrl, 96, part.start + ((at + 0.5) * length) / count)
    return url === undefined ? [] : [url]
  })
  return (
    <span className="timeline-frames" style={{ flexGrow: length }}>
      {shots.length === 0 ? (
        <Icon decorative name="video" size="sm" />
      ) : (
        shots.map((src) => <Frame key={src} src={src} />)
      )}
    </span>
  )
}

function Frame({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  return failed ? (
    <span className="timeline-frame-empty" />
  ) : (
    <img alt="" draggable={false} onError={() => setFailed(true)} src={src} />
  )
}

export function Wave({ part, state }: { part: PlaySegment; state: PeaksState }) {
  const length = part.end - part.start
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
  return (
    <span className="timeline-wave" style={{ flexGrow: length }}>
      {body}
    </span>
  )
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
