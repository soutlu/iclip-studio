import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import type { TimeSpan } from '@/shared/lib/time-spans'
import { cn } from '@/shared/lib/utils'
import { useAudioPeaks, type PeaksState } from '../editing/media-analysis'
import { Frames, TimelinePlayhead, TimelineRuler, TrimHandle, Wave } from '../editing/timeline'
import {
  arrowStep,
  DRAG_THRESHOLD,
  releasePointer,
  useClickAfterDrag,
  type Edge,
} from '../editing/timeline-drag'
import { useStableValue } from '../editing/use-stable-value'
import { movedStart, trimBounds, trimmed, type Timing } from './block-edit'
import type { PictureBlock } from './composition/film'
import { rowsOf, type Landing } from './placement'
import { msToPx, pxToMs, type TimelineScale } from './timeline-scale'

export type TimelinePoint = { track: number; timeMs: number }

export type TimelineHandle = {
  /** 屏幕上的这个点在哪一行、对应成片的第几毫秒；不在任何一行上时是 null。 */
  locate: (clientX: number, clientY: number) => TimelinePoint | null
}

/** 拖着的素材会落在哪里：`duration` 是它的总长（毫秒）。 */
export type DropGhost = Landing & { duration: number }

type FilmTimelineProps = {
  pictures: readonly PictureBlock[]
  totalMs: number
  playheadMs: number
  buffered: readonly TimeSpan[]
  scale: TimelineScale
  ghost: DropGhost | null
  selectedId: string | null
  /** 素材片的总长（毫秒）；还没读到时是 undefined。 */
  sourceMs: (src: string) => number | undefined
  onSelect: (id: string | null) => void
  onRetime: (id: string, timing: Timing) => void
  onRemove: (id: string) => void
  onSeek: (ms: number) => void
  onViewportWidth: (width: number) => void
  handleRef: RefObject<TimelineHandle | null>
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

// 指针离一行的上下边这么近也算在这一行上
const ROW_REACH_PX = 3

// 时间区左右留的空（whole-film.css 里 .wf-track-content 的 margin：左 8、右 16），不算进能排时间的宽度
const INSET_PX = 24

const sameTiming = (left: Timing, right: Timing) =>
  left.start === right.start &&
  left.duration === right.duration &&
  left.mediaStart === right.mediaStart

type Gesture = {
  pointerId: number
  kind: 'move' | Edge
  originX: number
  /** 按下的地方离块的开头多远（毫秒），挪的时候块跟着指针走而不是跳到指针处。 */
  grabMs: number
  timing: Timing | null
}

type TimelineBlockProps = {
  block: PictureBlock
  pictures: readonly PictureBlock[]
  selected: boolean
  pps: number
  /** 时间线内容区，用它把屏幕上的横坐标换成成片的时间。 */
  contentRef: RefObject<HTMLDivElement | null>
  sourceMs: number | undefined
  peaks: PeaksState
  onSelect: (id: string | null) => void
  onRetime: (id: string, timing: Timing) => void
  onRemove: (id: string) => void
}

/** 时间线上的一个块：点一下选中，拖着在这一行里挪，选中后拖两端的把手裁剪；松手才写进成片。 */
function TimelineBlock({
  block,
  pictures,
  selected,
  pps,
  contentRef,
  sourceMs,
  peaks,
  onSelect,
  onRetime,
  onRemove,
}: TimelineBlockProps) {
  const gestureRef = useRef<Gesture | null>(null)
  const clickAfterDrag = useClickAfterDrag()
  const [preview, setPreview] = useState<{ timing: Timing; kind: Gesture['kind'] }>()
  const timing = preview?.timing ?? block
  const name = `${block.label}，${seconds(timing.duration)} 秒`
  const part = {
    mediaUrl: block.src,
    start: timing.mediaStart / 1000,
    end: (timing.mediaStart + timing.duration) / 1000,
  }

  const timeAt = (clientX: number) =>
    pxToMs(clientX - (contentRef.current?.getBoundingClientRect().left ?? 0), pps)

  const press = (event: PointerEvent<HTMLElement>, kind: Gesture['kind']) => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    clickAfterDrag.reset()
    const box = event.currentTarget.closest('[data-block-id]')?.getBoundingClientRect()
    gestureRef.current = {
      pointerId: event.pointerId,
      kind,
      originX: event.clientX,
      grabMs: box === undefined ? 0 : pxToMs(event.clientX - box.left, pps),
      timing: null,
    }
  }

  // 把手是哪一端从它自己身上读（TrimHandle 给开头那个加 is-start），这样两个把手共用一个处理函数
  const pressEdge = (event: PointerEvent<HTMLElement>) =>
    press(event, event.currentTarget.classList.contains('is-start') ? 'start' : 'end')

  const drag = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    if (gesture.timing === null && Math.abs(event.clientX - gesture.originX) <= DRAG_THRESHOLD)
      return
    const at = timeAt(event.clientX)
    const { kind } = gesture
    gesture.timing =
      kind === 'move'
        ? {
            start: movedStart(block, pictures, Math.max(0, at - gesture.grabMs)),
            duration: block.duration,
            mediaStart: block.mediaStart,
          }
        : trimmed(block, kind, at, trimBounds(block, kind, pictures, sourceMs))
    setPreview({ timing: gesture.timing, kind })
  }

  const release = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    releasePointer(event)
    gestureRef.current = null
    setPreview(undefined)
    if (gesture.timing === null) return
    // 拖完松手也会来一次点击，那一次不算选中
    clickAfterDrag.swallow()
    if (!sameTiming(gesture.timing, block)) onRetime(block.id, gesture.timing)
  }

  const cancel = () => {
    gestureRef.current = null
    setPreview(undefined)
  }

  const nudge = (event: KeyboardEvent<HTMLElement>, edge: Edge) => {
    const step = arrowStep(event)
    if (step === undefined) return
    event.preventDefault()
    event.stopPropagation()
    const edgeMs = edge === 'start' ? block.start : block.start + block.duration
    const next = trimmed(
      block,
      edge,
      edgeMs + Math.round(step * 1000),
      trimBounds(block, edge, pictures, sourceMs),
    )
    if (!sameTiming(next, block)) onRetime(block.id, next)
  }

  return (
    <div
      aria-label={name}
      className={cn('wf-clip', selected && 'is-selected')}
      data-block-id={block.id}
      role="group"
      style={{
        left: msToPx(timing.start, pps),
        width: Math.max(2, msToPx(timing.duration, pps) - 2),
      }}
    >
      <button
        aria-keyshortcuts="Delete"
        aria-label={`选中：${name}`}
        aria-pressed={selected}
        className="wf-block-body ui-focus"
        onClick={() => {
          if (!clickAfterDrag.take()) onSelect(block.id)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault()
            onRemove(block.id)
          } else if (event.key === 'Escape' && selected) {
            event.stopPropagation()
            onSelect(null)
          }
        }}
        onPointerCancel={cancel}
        onPointerDown={(event) => press(event, 'move')}
        onPointerMove={drag}
        onPointerUp={release}
        type="button"
      >
        <span className="wf-clip-label">{block.label}</span>
        <span className="wf-clip-media">
          <span className="wf-clip-frames">
            <Frames part={part} />
          </span>
          <span className="wf-clip-wave">
            <Wave part={part} state={peaks} />
          </span>
        </span>
      </button>
      {selected
        ? (['start', 'end'] as const).map((edge) => {
            const bounds = trimBounds(block, edge, pictures, sourceMs)
            const edgeMs = edge === 'start' ? timing.start : timing.start + timing.duration
            return (
              <TrimHandle
                bounds={{ min: bounds.min / 1000, max: bounds.max / 1000 }}
                edge={edge}
                key={edge}
                onKeyDown={(event) => nudge(event, edge)}
                onPointerCancel={cancel}
                onPointerDown={pressEdge}
                onPointerMove={drag}
                onPointerUp={release}
                pressed={preview?.kind === edge}
                style={{ left: edge === 'start' ? 0 : '100%' }}
                value={edgeMs / 1000}
                valueText={`${seconds(edgeMs)} 秒`}
              />
            )
          })
        : null}
    </div>
  )
}

/** 时间线：成片里的块按行排开，可以选中、在一行里挪动、裁两端；上面是时间尺和播放头。 */
export function FilmTimeline({
  pictures,
  totalMs,
  playheadMs,
  buffered,
  scale,
  ghost,
  selectedId,
  sourceMs,
  onSelect,
  onRetime,
  onRemove,
  onSeek,
  onViewportWidth,
  handleRef,
}: FilmTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { pps, contentWidth } = scale
  const rows = rowsOf(pictures)
  // 还没有块时也留一行，素材拖得进来
  const shown = rows.length === 0 ? [{ track: 0, blocks: [] }] : rows
  const peaks = useAudioPeaks(useStableValue([...new Set(pictures.map((block) => block.src))]))

  useLayoutEffect(() => {
    const viewport = scrollRef.current
    if (viewport === null) return
    const report = () => onViewportWidth(Math.max(0, viewport.clientWidth - INSET_PX))
    report()
    const observer = new ResizeObserver(report)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [onViewportWidth])

  const timeAt = (clientX: number) =>
    pxToMs(clientX - (contentRef.current?.getBoundingClientRect().left ?? 0), pps)

  useEffect(() => {
    handleRef.current = {
      locate: (clientX, clientY) => {
        const viewport = scrollRef.current?.getBoundingClientRect()
        if (viewport === undefined || clientX < viewport.left || clientX > viewport.right)
          return null
        const lane = [
          ...(contentRef.current?.querySelectorAll<HTMLElement>('[data-track]') ?? []),
        ].find((element) => {
          const { top, bottom } = element.getBoundingClientRect()
          return clientY >= top - ROW_REACH_PX && clientY <= bottom + ROW_REACH_PX
        })
        if (lane === undefined) return null
        return { track: Number(lane.dataset['track']), timeMs: Math.max(0, timeAt(clientX)) }
      },
    }
    return () => {
      handleRef.current = null
    }
  })

  return (
    <div className="wf-tracks">
      <div className="wf-track-heads">
        {shown.map(({ track, blocks }) => (
          <span className="wf-track-head" key={track}>
            <span className="wf-head-name">{blocks[0]?.label}</span>
            {blocks.length > 1 ? (
              <span aria-label={`${blocks.length} 个块`} className="wf-head-count">
                {blocks.length}
              </span>
            ) : null}
          </span>
        ))}
      </div>
      <div className="wf-track-scroll" ref={scrollRef}>
        <div className="wf-track-content" ref={contentRef} style={{ width: contentWidth }}>
          <TimelineRuler
            buffered={buffered}
            clockAt={(clientX) => timeAt(clientX) / 1000}
            currentTime={playheadMs / 1000}
            disabled={totalMs <= 0}
            onScrub={() => {}}
            onSeek={(clock) => onSeek(Math.round(clock * 1000))}
            scale={contentWidth / pps}
            total={totalMs / 1000}
            viewportRef={scrollRef}
          />
          <div className="wf-lanes">
            {shown.map(({ track, blocks }, at) => (
              <div
                aria-label={`第 ${at + 1} 行`}
                className="wf-lane"
                data-track={track}
                key={track}
                role="group"
              >
                {blocks.map((block) => (
                  <TimelineBlock
                    block={block}
                    contentRef={contentRef}
                    key={block.id}
                    onRemove={onRemove}
                    onRetime={onRetime}
                    onSelect={onSelect}
                    peaks={peaks.get(block.src) ?? { kind: 'loading' }}
                    pictures={pictures}
                    pps={pps}
                    selected={selectedId === block.id}
                    sourceMs={sourceMs(block.src)}
                  />
                ))}
                {ghost?.track === track ? (
                  <span
                    aria-hidden="true"
                    className="wf-drop-ghost"
                    data-testid="drop-ghost"
                    style={{
                      left: msToPx(ghost.start, pps),
                      width: Math.max(2, msToPx(ghost.duration, pps) - 2),
                    }}
                  />
                ) : null}
                {pictures.length === 0 && ghost === null ? (
                  <span className="wf-lane-hint">把下面的镜头拖到这里</span>
                ) : null}
              </div>
            ))}
          </div>
          <TimelinePlayhead style={{ left: msToPx(Math.min(playheadMs, totalMs), pps) }} />
        </div>
      </div>
    </div>
  )
}
