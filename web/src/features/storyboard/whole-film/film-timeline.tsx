import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import { Icon } from '@/shared/icons'
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
import {
  ContextMenuItem,
  ContextMenuRoot,
  ContextMenuSurface,
  ContextMenuTrigger,
} from '@/shared/ui/menu'
import {
  gapClosing,
  movedStart,
  trimBounds,
  trimmed,
  type GapClosing,
  type Timing,
} from './block-edit'
import { MAX_FILM_MS, type PictureBlock } from './composition/film'
import { rowHidden, rowsOf, type Landing } from './placement'
import {
  msToPx,
  pxToMs,
  snapMs,
  snapSpanStartMs,
  snapTargets,
  type TimelineScale,
} from './timeline-scale'

/** 块要去的行：已有的行给行号，`'new'` 是最下面那条空行（落下去新开一行）。 */
export type RowTarget = number | 'new'

export type TimelinePoint = { track: RowTarget; timeMs: number }

export type TimelineHandle = {
  /** 屏幕上的这个点在哪一行、对应成片的第几毫秒；不在任何一行上时是 null。 */
  locate: (clientX: number, clientY: number) => TimelinePoint | null
}

/** 拖着的素材会落在哪里：`duration` 是它的总长（毫秒），`guideMs` 是它吸上的时间点。 */
export type DropGhost = Landing & { duration: number; guideMs: number | null }

type FilmTimelineProps = {
  pictures: readonly PictureBlock[]
  totalMs: number
  playheadMs: number
  buffered: readonly TimeSpan[]
  scale: TimelineScale
  ghost: DropGhost | null
  selectedId: string | null
  /** 拖动和裁剪时要不要吸到别的块的两端和播放头上。 */
  snap: boolean
  /** 块上要不要显示画面缩略图；关掉只剩名字和声音。 */
  thumbnails: boolean
  /** 素材片的总长（毫秒）；还没读到时是 undefined。 */
  sourceMs: (src: string) => number | undefined
  onSelect: (id: string | null) => void
  onRetime: (id: string, timing: Timing) => void
  /** 把块换到另一行（或最下面的空行）的 `start` 处。 */
  onMove: (id: string, row: RowTarget, start: number) => void
  /** 把几个块各自挪到新的起点（合拢空档用）。 */
  onRestart: (starts: ReadonlyMap<string, number>) => void
  onRemove: (id: string) => void
  /** 把 `track` 这一行的块一起隐藏（`hidden` 为真）或显示回来。 */
  onHide: (track: number, hidden: boolean) => void
  onSeek: (ms: number) => void
  onViewportWidth: (width: number) => void
  handleRef: RefObject<TimelineHandle | null>
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

// 指针离一行的上下边这么近也算在这一行上
const ROW_REACH_PX = 3

// 时间区左右留的空（whole-film.css 里 .wf-track-content 的 margin：左 8、右 16），不算进能排时间的宽度
const INSET_PX = 24

const lanesIn = (content: HTMLElement | null) => [
  ...(content?.querySelectorAll<HTMLElement>('[data-track]') ?? []),
]

const sameTiming = (left: Timing, right: Timing) =>
  left.start === right.start &&
  left.duration === right.duration &&
  left.mediaStart === right.mediaStart

type Gesture = {
  pointerId: number
  kind: 'move' | Edge
  originX: number
  originY: number
  /** 按下的地方离块的开头多远（毫秒），挪的时候块跟着指针走而不是跳到指针处。 */
  grabMs: number
  timing: Timing | null
  /** 挪的时候指针在哪一行上：行号，或者最下面那条空行。 */
  row: RowTarget | null
}

/** 拖动中的块按这个画：时间、正在拖的是哪一部分、比原来的行往下偏了多少像素。 */
type Preview = { timing: Timing; kind: Gesture['kind']; offsetY: number }

type TimelineBlockProps = {
  block: PictureBlock
  pictures: readonly PictureBlock[]
  selected: boolean
  pps: number
  /** 时间线内容区，用它把屏幕上的横坐标换成成片的时间。 */
  contentRef: RefObject<HTMLDivElement | null>
  /** 指针在哪一行上（只算轨道区里露出来的部分）；不在任何一行上时是 undefined。 */
  laneAt: (clientY: number) => HTMLElement | undefined
  sourceMs: number | undefined
  peaks: PeaksState
  snap: boolean
  playheadMs: number
  /** 拖动中吸上了哪个时间点（毫秒），画一条线；没吸上或松手后是 null。 */
  onGuide: (ms: number | null) => void
  onSelect: (id: string | null) => void
  onRetime: (id: string, timing: Timing) => void
  /** 把块换到另一行的 `start` 处。 */
  onMove: (id: string, row: RowTarget, start: number) => void
  onRemove: (id: string) => void
}

/**
 * 时间线上的一个块：点一下选中，拖着挪动（在这一行里，或者拖到别的行、最下面的空行上），
 * 选中后拖两端的把手裁剪；松手才写进成片。
 */
function TimelineBlock({
  block,
  pictures,
  selected,
  pps,
  contentRef,
  laneAt,
  sourceMs,
  peaks,
  snap,
  playheadMs,
  onGuide,
  onSelect,
  onRetime,
  onMove,
  onRemove,
}: TimelineBlockProps) {
  const gestureRef = useRef<Gesture | null>(null)
  const clickAfterDrag = useClickAfterDrag()
  const [preview, setPreview] = useState<Preview>()
  const timing = preview?.timing ?? block
  const name = `${block.label}，${seconds(timing.duration)} 秒${block.hidden ? '，已隐藏' : ''}`
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
      originY: event.clientY,
      grabMs: box === undefined ? 0 : pxToMs(event.clientX - box.left, pps),
      timing: null,
      row: null,
    }
  }

  // 把手是哪一端从它自己身上读（TrimHandle 给开头那个加 is-start），这样两个把手共用一个处理函数
  const pressEdge = (event: PointerEvent<HTMLElement>) =>
    press(event, event.currentTarget.classList.contains('is-start') ? 'start' : 'end')

  const drag = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    // 挪动可以往上下拖去别的行；裁剪只看左右
    const moved =
      gesture.kind === 'move'
        ? Math.hypot(event.clientX - gesture.originX, event.clientY - gesture.originY)
        : Math.abs(event.clientX - gesture.originX)
    if (gesture.timing === null && moved <= DRAG_THRESHOLD) return
    const at = timeAt(event.clientX)
    const { kind } = gesture
    // 开着吸附时：别的块的两端和播放头是能吸上去的点
    const targets = snap
      ? snapTargets(
          pictures.filter((other) => other.id !== block.id),
          playheadMs,
        )
      : null
    let offsetY = 0
    if (kind === 'move') {
      const wanted = Math.max(0, at - gesture.grabMs)
      const snapped =
        targets === null
          ? { ms: wanted, guideMs: null }
          : snapSpanStartMs(wanted, block.duration, targets, pps)
      // 指针在哪一行上，块就去哪一行；不在任何一行上就留在原来的行
      const own = lanesIn(contentRef.current).find(
        (lane) => lane.dataset['track'] === String(block.track),
      )
      const hit = laneAt(event.clientY) ?? own
      const row: RowTarget =
        hit === undefined || hit === own
          ? block.track
          : hit.dataset['track'] === 'new'
            ? 'new'
            : Number(hit.dataset['track'])
      if (hit !== undefined && own !== undefined)
        offsetY = hit.getBoundingClientRect().top - own.getBoundingClientRect().top
      // 新开的一行上没有别的块，放在哪里都不会重叠
      const start =
        row === 'new'
          ? Math.min(snapped.ms, MAX_FILM_MS - block.duration)
          : movedStart(block, pictures, snapped.ms, row)
      gesture.timing = { start, duration: block.duration, mediaStart: block.mediaStart }
      gesture.row = row
      // 吸上去的位置被别的块占了、又挪开了，就不画吸附线
      onGuide(start === snapped.ms ? snapped.guideMs : null)
    } else {
      const snapped = targets === null ? { ms: at, guideMs: null } : snapMs(at, targets, pps)
      const next = trimmed(block, kind, snapped.ms, trimBounds(block, kind, pictures, sourceMs))
      gesture.timing = next
      const edgeMs = kind === 'start' ? next.start : next.start + next.duration
      onGuide(edgeMs === snapped.ms ? snapped.guideMs : null)
    }
    setPreview({ timing: gesture.timing, kind, offsetY })
  }

  const release = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    releasePointer(event)
    gestureRef.current = null
    setPreview(undefined)
    onGuide(null)
    if (gesture.timing === null) return
    // 拖完松手也会来一次点击，那一次不算选中
    clickAfterDrag.swallow()
    if (gesture.row !== null && gesture.row !== block.track)
      onMove(block.id, gesture.row, gesture.timing.start)
    else if (!sameTiming(gesture.timing, block)) onRetime(block.id, gesture.timing)
  }

  const cancel = () => {
    gestureRef.current = null
    setPreview(undefined)
    onGuide(null)
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
      className={cn(
        'wf-clip',
        selected && 'is-selected',
        block.hidden && 'is-hidden',
        preview?.kind === 'move' && 'is-lifted',
      )}
      data-block-id={block.id}
      role="group"
      style={{
        translate: preview === undefined ? undefined : `0 ${preview.offsetY}px`,
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

/** 行头的眼睛：把这一行的块一起隐藏或显示回来。`row` 是界面上的第几行。 */
function RowEye({
  row,
  hidden,
  onHide,
}: {
  row: number
  hidden: boolean
  onHide: (hidden: boolean) => void
}) {
  return (
    <button
      aria-label={hidden ? `显示第 ${row} 行` : `隐藏第 ${row} 行`}
      aria-pressed={!hidden}
      className="wf-head-eye ui-state ui-focus"
      onClick={() => onHide(!hidden)}
      title={hidden ? '显示这一行' : '隐藏这一行'}
      type="button"
    >
      <Icon decorative name={hidden ? 'excluded' : 'included'} size="sm" />
    </button>
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
  snap,
  thumbnails,
  sourceMs,
  onSelect,
  onRetime,
  onMove,
  onRestart,
  onRemove,
  onHide,
  onSeek,
  onViewportWidth,
  handleRef,
}: FilmTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const headsRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const rulerBarRef = useRef<HTMLDivElement>(null)
  // 拖动块时吸上的时间点；拖素材进来时吸上的点由 `ghost` 带着
  const [blockGuideMs, setBlockGuideMs] = useState<number | null>(null)
  const guideMs = blockGuideMs ?? ghost?.guideMs ?? null
  // 在一行的空处点右键时，两种合拢各自要挪哪些块
  const [closing, setClosing] = useState<GapClosing>()
  const { pps, contentWidth } = scale
  const rows = rowsOf(pictures)
  // 还没有块时也留一行，素材拖得进来
  const shown = rows.length === 0 ? [{ track: 0, blocks: [] }] : rows
  const peaks = useAudioPeaks(useStableValue([...new Set(pictures.map((block) => block.src))]))

  useLayoutEffect(() => {
    const viewport = scrollRef.current
    const heads = headsRef.current
    if (viewport === null || heads === null) return
    // 行头那一列和时间区在同一个滚动容器里，排时间的宽度要把它去掉
    const report = () =>
      onViewportWidth(Math.max(0, viewport.clientWidth - heads.offsetWidth - INSET_PX))
    report()
    const observer = new ResizeObserver(report)
    observer.observe(viewport)
    observer.observe(heads)
    return () => observer.disconnect()
  }, [onViewportWidth])

  const timeAt = (clientX: number) =>
    pxToMs(clientX - (contentRef.current?.getBoundingClientRect().left ?? 0), pps)

  // 只认轨道区里露出来的行：滚到时间尺底下、滚出轨道区的行，指针看不见也落不上去
  const laneAt = (clientY: number) => {
    const viewport = scrollRef.current
    const rulerBar = rulerBarRef.current
    if (viewport === null || rulerBar === null) return undefined
    const bottom = viewport.getBoundingClientRect().top + viewport.clientTop + viewport.clientHeight
    if (clientY < rulerBar.getBoundingClientRect().bottom || clientY > bottom) return undefined
    return lanesIn(contentRef.current).find((lane) => {
      const { top, bottom } = lane.getBoundingClientRect()
      return clientY >= top - ROW_REACH_PX && clientY <= bottom + ROW_REACH_PX
    })
  }

  useEffect(() => {
    handleRef.current = {
      locate: (clientX, clientY) => {
        const viewport = scrollRef.current
        const heads = headsRef.current
        if (viewport === null || heads === null) return null
        const right =
          viewport.getBoundingClientRect().left + viewport.clientLeft + viewport.clientWidth
        if (clientX < heads.getBoundingClientRect().right || clientX > right) return null
        const lane = laneAt(clientY)
        if (lane === undefined) return null
        const track = lane.dataset['track']
        return {
          track: track === 'new' ? 'new' : Number(track),
          timeMs: Math.max(0, timeAt(clientX)),
        }
      },
    }
    return () => {
      handleRef.current = null
    }
  })

  // 点在块上，或者这一行没有可合拢的空档：不开菜单
  const openGapMenu = (event: MouseEvent<HTMLElement>, track: number) => {
    const onBlock =
      event.target instanceof Element && event.target.closest('[data-block-id]') !== null
    const next = onBlock ? undefined : gapClosing(pictures, track, timeAt(event.clientX))
    if (next === undefined || (next.one.size === 0 && next.all.size === 0)) {
      event.preventDefault()
      return
    }
    setClosing(next)
  }

  return (
    <div className={cn('wf-tracks', !thumbnails && 'is-plain')} ref={scrollRef}>
      <div className="wf-track-inner">
        <div className="wf-track-heads" ref={headsRef}>
          <span aria-hidden="true" className="wf-track-corner" />
          {shown.map(({ track, blocks }, at) => (
            <span className="wf-track-head" key={track}>
              <span className="wf-head-name">{blocks[0]?.label}</span>
              {blocks.length > 1 ? (
                <span aria-label={`${blocks.length} 个块`} className="wf-head-count">
                  {blocks.length}
                </span>
              ) : null}
              {blocks.length > 0 ? (
                <RowEye
                  hidden={rowHidden(pictures, track)}
                  onHide={(hidden) => onHide(track, hidden)}
                  row={at + 1}
                />
              ) : null}
            </span>
          ))}
        </div>
        <div className="wf-track-content" ref={contentRef} style={{ width: contentWidth }}>
          <div className="wf-track-top" ref={rulerBarRef}>
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
            <TimelinePlayhead style={{ left: msToPx(Math.min(playheadMs, totalMs), pps) }} />
          </div>
          <div className="wf-lanes">
            {shown.map(({ track, blocks }, at) => (
              <ContextMenuRoot key={track}>
                <ContextMenuTrigger asChild>
                  <div
                    aria-label={`第 ${at + 1} 行`}
                    className="wf-lane"
                    data-track={track}
                    onContextMenu={(event) => openGapMenu(event, track)}
                    role="group"
                  >
                    {blocks.map((block) => (
                      <TimelineBlock
                        block={block}
                        contentRef={contentRef}
                        key={block.id}
                        laneAt={laneAt}
                        onGuide={setBlockGuideMs}
                        onMove={onMove}
                        onRemove={onRemove}
                        onRetime={onRetime}
                        onSelect={onSelect}
                        peaks={peaks.get(block.src) ?? { kind: 'loading' }}
                        pictures={pictures}
                        playheadMs={playheadMs}
                        pps={pps}
                        selected={selectedId === block.id}
                        snap={snap}
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
                </ContextMenuTrigger>
                <ContextMenuSurface aria-label="空档">
                  <ContextMenuItem
                    disabled={closing === undefined || closing.one.size === 0}
                    onSelect={() => {
                      if (closing !== undefined) onRestart(closing.one)
                    }}
                  >
                    合拢这个空档
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={closing === undefined || closing.all.size === 0}
                    onSelect={() => {
                      if (closing !== undefined) onRestart(closing.all)
                    }}
                  >
                    合拢这一行的所有空档
                  </ContextMenuItem>
                </ContextMenuSurface>
              </ContextMenuRoot>
            ))}
            {pictures.length === 0 ? null : (
              <div aria-label="新的一行" className="wf-lane is-new" data-track="new" role="group">
                {ghost !== null && !rows.some((row) => row.track === ghost.track) ? (
                  <span
                    aria-hidden="true"
                    className="wf-drop-ghost"
                    data-testid="drop-ghost"
                    style={{
                      left: msToPx(ghost.start, pps),
                      width: Math.max(2, msToPx(ghost.duration, pps) - 2),
                    }}
                  />
                ) : (
                  <span className="wf-lane-hint">拖到这里，新开一行</span>
                )}
              </div>
            )}
          </div>
          {guideMs === null ? null : (
            <span
              aria-hidden="true"
              className="wf-snap-guide"
              data-testid="snap-guide"
              style={{ left: msToPx(guideMs, pps) }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
