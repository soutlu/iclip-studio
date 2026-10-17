import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { BlockedReason } from '../components/blocked-reason'
import { roundToMs, type Clip } from '../editing/clip'
import type { PeaksState } from '../editing/media-analysis'
import { roundSeconds } from '../editing/time-label'
import {
  Frames,
  TimelineBubble,
  TimelineRuler,
  TrimBubble,
  TrimHandle,
  Wave,
} from '../editing/timeline'
import {
  arrowStep,
  DRAG_THRESHOLD,
  releasePointer,
  useClickAfterDrag,
  useLiftDrag,
  useRovingFocus,
  type Edge,
} from '../editing/timeline-drag'
import {
  fitsInFilm,
  insertClockOf,
  insertIndexAt,
  layoutFilm,
  MAX_FILM_SECONDS,
  MAX_FILM_SEGMENTS,
  MIN_SEGMENT_SECONDS,
  segmentDuration,
  trimBounds,
  type FilmSegment,
  type FilmBrand,
  type MaterialLane,
} from './film-draft'
import { materialName, type Material, type MaterialDuration } from './film-materials'
import { BrandPlaceholder, VersionPill, type BrandMenuProps } from './film-menus'
import { internalCuts } from './film-music'
import { MusicTrack, type MusicTrackView } from './film-music-track'
import type { FilmSubtitle, FilmSubtitleStatus } from './film-subtitles'
import './film-timeline.css'

export type LaneView = {
  lane: MaterialLane
  label: string
  material: Material
  versions: readonly Material[]
  duration: MaterialDuration
  shots: readonly { start: number; end: number }[]
  shotState: 'loading' | 'ready' | 'error'
  onRetryShots: () => void
}

export type MaterialPick = Clip & { takeId: string; shotIndex: number }

export type FilmSelection =
  | { kind: 'segment'; id: string }
  | { kind: 'subtitle'; key: string }
  | { kind: 'music' }
  | { kind: 'brand'; position: 'intro' | 'outro' }
  | undefined

const ROW = {
  film: { top: 22, height: 48 },
  subtitles: { top: 4, height: 26 },
  music: { top: 34, height: 32 },
  materials: 76,
  group: 34,
  lane: 52,
  laneGap: 24,
} as const

const DROP_SLOP = 16
const SCROLL_EDGE = 40
const SCROLL_SPEED = 420
const BUBBLE_EDGE = 0.12

const seconds = (value: number) => `${value.toFixed(1)} 秒`

type FilmTimelineProps = {
  segments: readonly FilmSegment[]
  subtitles: readonly FilmSubtitle[]
  statuses: readonly FilmSubtitleStatus[]
  materialOf: (jobId: string) => Material | undefined
  lanes: readonly LaneView[]
  scale: number
  total: number
  bodyTotal: number
  intro: FilmBrand | null | undefined
  outro: FilmBrand | null | undefined
  currentTime: number
  selection: FilmSelection
  pick: MaterialPick | undefined
  retrying: ReadonlySet<string>
  peaksOf: (url: string) => PeaksState
  durationOf: (material: Material) => MaterialDuration
  anchorRef: Ref<HTMLElement>
  addVideo: ReactNode
  brands: BrandMenuProps
  subtitleSettings: ReactNode
  onSeek: (clock: number) => void
  onScrub: () => void
  onSelect: (selection: FilmSelection) => void
  onTrim: (id: string, edge: Edge, value: number) => void
  onTrimPreview: (clip: Clip, clock: number, edge: Edge) => void
  onMove: (id: string, before: number) => void
  onDelete: (id: string) => void
  onPick: (pick: MaterialPick | undefined) => void
  onPreviewMaterial: (pick: MaterialPick, clock: number, edge?: Edge) => void
  onInsert: (pick: MaterialPick, index: number) => void
  onRetry: (sourceJobId: string) => void
  onSwitchVersion: (lane: LaneView, material: Material) => void
  music: MusicTrackView
  musicAdd: ReactNode
  onMoveMusic: (start: number) => void
  onRemoveMusic: () => void
}

type Carry = {
  pointerId: number
  pick: MaterialPick
  originX: number
  originY: number
  clientX: number
  clientY: number
  grab: number
  pixelsPerSecond: number
  clock: number
  over: boolean
  moved: boolean
}

type PickHandle = { pointerId: number; edge: Edge; value: number }

type Trim = {
  pointerId: number
  id: string
  edge: Edge
  value: number
  initialValue: number
  originX: number
  pixelsPerSecond: number
}

function Strip({
  url,
  start,
  end,
  peaks,
}: {
  url: string
  start: number
  end: number
  peaks: PeaksState
}) {
  const part = { mediaUrl: url, start, end }
  return (
    <>
      <span className="film-strip-frames">
        <Frames part={part} />
      </span>
      <span className="film-strip-wave">
        <Wave part={part} state={peaks} />
      </span>
    </>
  )
}

export function FilmTimeline({
  segments,
  subtitles,
  statuses,
  materialOf,
  lanes,
  scale: baseScale,
  total,
  bodyTotal,
  intro,
  outro,
  currentTime,
  selection,
  pick,
  retrying,
  peaksOf,
  durationOf,
  anchorRef,
  addVideo,
  brands,
  subtitleSettings,
  onSeek,
  onScrub,
  onSelect,
  onTrim,
  onTrimPreview,
  onMove,
  onDelete,
  onPick,
  onPreviewMaterial,
  onInsert,
  onRetry,
  onSwitchVersion,
  music,
  musicAdd,
  onMoveMusic,
  onRemoveMusic,
}: FilmTimelineProps) {
  const lanesRef = useRef<HTMLDivElement>(null)
  const filmRowRef = useRef<HTMLDivElement>(null)
  const filmScrollRef = useRef<HTMLDivElement>(null)
  const candidatesRef = useRef<HTMLDivElement>(null)
  const candidateScrollRef = useRef<HTMLDivElement>(null)
  const [cutMarkerContainer, setCutMarkerContainer] = useState<HTMLDivElement | null>(null)
  const syncHorizontalScroll = (source: HTMLDivElement) => {
    const other =
      source === filmScrollRef.current ? candidateScrollRef.current : filmScrollRef.current
    if (other !== null && other.scrollLeft !== source.scrollLeft)
      other.scrollLeft = source.scrollLeft
  }
  const [carry, setCarry] = useState<Carry | null>(null)
  const [pickHandle, setPickHandle] = useState<PickHandle | null>(null)
  const [trim, setTrim] = useState<Trim | null>(null)

  const bodyStart = (intro?.durationMs ?? 0) / 1000
  const reserved = bodyStart + (outro?.durationMs ?? 0) / 1000
  const layout = layoutFilm(segments).map((placed) => ({ ...placed, at: placed.at + bodyStart }))
  const carried = carry?.moved === true ? carry.pick : undefined
  const carriedDuration = carried === undefined ? 0 : segmentDuration(carried)
  const dropping = carry?.moved === true && carry.over
  const dropFits =
    carried !== undefined &&
    carriedDuration >= MIN_SEGMENT_SECONDS &&
    segments.length < MAX_FILM_SEGMENTS &&
    fitsInFilm(segments, carriedDuration, reserved)
  const dropIndex = dropping ? insertIndexAt(segments, carry.clock - bodyStart) : undefined
  const dropClock =
    dropIndex === undefined ? undefined : bodyStart + insertClockOf(segments, dropIndex)
  const shift = dropping && dropFits && dropIndex !== undefined ? carriedDuration : 0
  const scale = Math.max(baseScale, total + shift)

  const materialScale = Math.max(1, ...lanes.map((view) => view.duration ?? 0))
  const materialPercent = (time: number) => `${(time / materialScale) * 100}%`
  const materialSpan = (start: number, duration: number) => ({
    left: materialPercent(start),
    width: `max(1px, calc(${materialPercent(duration)} - 2px))`,
  })
  const percent = (time: number) => `${(time / scale) * 100}%`
  const span = (at: number, duration: number) => ({
    left: percent(at),
    width: `calc(${percent(duration)} - 2px)`,
  })
  const bubbleAt = (time: number): CSSProperties => ({
    left: percent(time),
    ...(time < scale * BUBBLE_EDGE
      ? { translate: '0 0' }
      : time > scale * (1 - BUBBLE_EDGE)
        ? { translate: '-100% 0' }
        : {}),
  })
  const clockAt = (clientX: number) => {
    const bounds = lanesRef.current?.getBoundingClientRect()
    if (bounds === undefined || bounds.width === 0) return 0
    return Math.min(scale, Math.max(0, ((clientX - bounds.left) / bounds.width) * scale))
  }
  const secondsOf = (pixels: number) => {
    const width = lanesRef.current?.getBoundingClientRect().width ?? 0
    return width === 0 ? 0 : (pixels / width) * scale
  }
  const overFilm = (clientX: number, clientY: number) => {
    const bounds = filmRowRef.current?.getBoundingClientRect()
    const viewport = filmScrollRef.current?.getBoundingClientRect()
    return (
      bounds !== undefined &&
      viewport !== undefined &&
      bounds.height > 0 &&
      clientX >= Math.max(bounds.left, viewport.left) &&
      clientX <= Math.min(bounds.right, viewport.right) &&
      bounds.bottom > viewport.top &&
      bounds.top < viewport.bottom &&
      clientY >= Math.max(viewport.top, bounds.top - DROP_SLOP) &&
      clientY <= Math.min(viewport.bottom, bounds.bottom)
    )
  }

  const clickAfterDrag = useClickAfterDrag()
  const reorder = useLiftDrag<string>({ clockAt, onScrub })
  const lift = reorder.lift

  const carrying = carry?.moved === true
  const scrollCarry = useEffectEvent((elapsed: number) => {
    if (carry === null) return
    const { clientX, clientY } = carry
    const viewport = candidatesRef.current
    const bounds = viewport?.getBoundingClientRect()
    const insideCandidates =
      bounds !== undefined && clientY >= bounds.top && clientY <= bounds.bottom
    if (
      viewport !== null &&
      bounds !== undefined &&
      insideCandidates &&
      clientX >= bounds.left &&
      clientX <= bounds.right
    ) {
      const edge = Math.min(SCROLL_EDGE, bounds.height / 3)
      const direction = clientY < bounds.top + edge ? -1 : clientY > bounds.bottom - edge ? 1 : 0
      viewport.scrollTop += (direction * SCROLL_SPEED * elapsed) / 1000
    }
    const over = overFilm(clientX, clientY)
    const horizontal = over
      ? filmScrollRef.current
      : insideCandidates
        ? candidateScrollRef.current
        : null
    if (horizontal !== null) {
      const edge = horizontal.getBoundingClientRect()
      const direction =
        clientX >= edge.left && clientX < edge.left + SCROLL_EDGE
          ? -1
          : clientX <= edge.right && clientX > edge.right - SCROLL_EDGE
            ? 1
            : 0
      horizontal.scrollLeft += (direction * SCROLL_SPEED * elapsed) / 1000
      syncHorizontalScroll(horizontal)
    }
    const clock = clockAt(clientX)
    if (over !== carry.over || clock !== carry.clock) setCarry({ ...carry, over, clock })
  })
  useEffect(() => {
    if (!carrying) return
    let last: number | undefined
    let frame = 0
    const tick = (now: number) => {
      scrollCarry(last === undefined ? 16 : Math.min(32, now - last))
      last = now
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [carrying])

  const stripOf = (part: Clip) => {
    const material = materialOf(part.sourceJobId)
    return material === undefined ? null : (
      <Strip end={part.end} peaks={peaksOf(material.url)} start={part.start} url={material.url} />
    )
  }

  const selectedSegment = selection?.kind === 'segment' ? selection.id : undefined
  const selectedSubtitle = selection?.kind === 'subtitle' ? selection.key : undefined
  const roving = useRovingFocus(
    layout.map((placed) => placed.segment.id),
    selectedSegment,
  )

  const clickSegment = (id: string) => {
    if (clickAfterDrag.take()) return
    roving.remember(id)
    onSelect(selectedSegment === id ? undefined : { kind: 'segment', id })
  }

  const keySegment = (event: KeyboardEvent<HTMLButtonElement>, index: number, id: string) => {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : undefined
    if (direction !== undefined && event.altKey) {
      event.preventDefault()
      const before = direction < 0 ? index - 1 : index + 2
      if (before >= 0 && before <= segments.length) {
        onMove(id, before)
        requestAnimationFrame(() => roving.focus(id))
      }
      return
    }
    if (direction !== undefined) {
      event.preventDefault()
      const next = segments[index + direction]
      if (next === undefined) return
      onSelect({ kind: 'segment', id: next.id })
      roving.focus(next.id)
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      // 焦点所在的段被删掉后焦点落回对话框，交给后面（没有就前面）那段。
      const neighbor = segments[index + 1]?.id ?? segments[index - 1]?.id
      onDelete(id)
      if (neighbor !== undefined) requestAnimationFrame(() => roving.focus(neighbor))
    }
  }

  const pressSegment = (event: PointerEvent<HTMLButtonElement>, at: number, id: string) => {
    clickAfterDrag.reset()
    if (event.button !== 0) return
    onScrub()
    reorder.press(event, id, at)
  }

  const releaseSegment = (event: PointerEvent<HTMLButtonElement>) => {
    const dropped = reorder.release(event)
    if (dropped === undefined) return
    clickAfterDrag.swallow()
    onMove(dropped.payload, insertIndexAt(segments, dropped.clock - bodyStart))
  }

  const sourceDurationOf = (segment: FilmSegment) => {
    const material = materialOf(segment.sourceJobId)
    return material === undefined ? undefined : (durationOf(material) ?? undefined)
  }

  const trimValue = (segment: FilmSegment, edge: Edge, value: number) => {
    const bounds = trimBounds(segments, segment, edge, reserved, sourceDurationOf(segment))
    if (bounds === undefined) return undefined
    return Math.min(bounds.max, Math.max(bounds.min, value))
  }

  const pressTrim = (event: PointerEvent<HTMLButtonElement>, segment: FilmSegment, edge: Edge) => {
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    onScrub()
    const value = segment[edge]
    const trackWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0
    setTrim({
      pointerId: event.pointerId,
      id: segment.id,
      edge,
      value,
      initialValue: value,
      originX: event.clientX,
      pixelsPerSecond: trackWidth / scale,
    })
    onTrimPreview({ ...segment, [edge]: value }, value, edge)
  }

  const dragTrim = (event: PointerEvent<HTMLButtonElement>) => {
    if (trim === null || trim.pointerId !== event.pointerId) return
    const placed = layout.find((item) => item.segment.id === trim.id)
    if (placed === undefined) return
    if (trim.pixelsPerSecond === 0) return
    const value = trimValue(
      placed.segment,
      trim.edge,
      trim.initialValue + (event.clientX - trim.originX) / trim.pixelsPerSecond,
    )
    if (value === undefined) return
    setTrim({ ...trim, value })
    onTrimPreview({ ...placed.segment, [trim.edge]: value }, value, trim.edge)
  }

  const releaseTrim = (event: PointerEvent<HTMLButtonElement>) => {
    if (trim === null || trim.pointerId !== event.pointerId) return
    releasePointer(event)
    setTrim(null)
    onTrim(trim.id, trim.edge, trim.value)
  }

  const cancelTrim = (event: PointerEvent<HTMLButtonElement>) => {
    if (trim === null || trim.pointerId !== event.pointerId) return
    releasePointer(event)
    const segment = segments.find((item) => item.id === trim.id)
    if (segment !== undefined) onTrimPreview(segment, segment[trim.edge], trim.edge)
    setTrim(null)
  }

  const keyTrim = (event: KeyboardEvent<HTMLButtonElement>, segment: FilmSegment, edge: Edge) => {
    const delta = arrowStep(event)
    if (delta === undefined) return
    event.preventDefault()
    const value = trimValue(segment, edge, segment[edge] + delta)
    if (value === undefined) return
    onTrim(segment.id, edge, value)
    onTrimPreview({ ...segment, [edge]: value }, value, edge)
  }

  const insertAtPlayhead = (current: MaterialPick) =>
    onInsert(current, insertIndexAt(segments, currentTime - bodyStart))

  const selectShot = (view: LaneView, shotIndex: number) => {
    const shot = view.shots[shotIndex]
    if (shot === undefined) return undefined
    const next: MaterialPick = {
      takeId: view.lane.takeId,
      sourceJobId: view.material.jobId,
      shotIndex,
      start: shot.start,
      end: shot.end,
    }
    onPick(next)
    onPreviewMaterial(next, next.start, 'start')
    return next
  }

  const isPickedShot = (view: LaneView, index: number) =>
    pick?.takeId === view.lane.takeId &&
    pick.sourceJobId === view.material.jobId &&
    pick.shotIndex === index

  const pressShot = (event: PointerEvent<HTMLButtonElement>, view: LaneView, index: number) => {
    if (event.button !== 0 || view.duration == null) return
    clickAfterDrag.reset()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus()
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect()
    if (bounds === undefined || bounds.width === 0) return
    const pointerClock = Math.max(
      0,
      Math.min(materialScale, ((event.clientX - bounds.left) / bounds.width) * materialScale),
    )
    const withinPick =
      pick?.sourceJobId === view.material.jobId &&
      pick.takeId === view.lane.takeId &&
      pointerClock >= pick.start &&
      pointerClock <= pick.end
    const current = withinPick ? pick : selectShot(view, index)
    if (current === undefined) return
    const clock = Math.min(current.end, Math.max(current.start, pointerClock))
    onPreviewMaterial(current, clock)
    setCarry({
      pointerId: event.pointerId,
      pick: current,
      originX: event.clientX,
      originY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      grab: clock - current.start,
      pixelsPerSecond: bounds.width / materialScale,
      clock: (pointerClock / materialScale) * scale,
      over: false,
      moved: false,
    })
  }

  const dragShot = (event: PointerEvent<HTMLButtonElement>) => {
    if (carry === null || carry.pointerId !== event.pointerId) return
    const moved =
      carry.moved ||
      Math.hypot(event.clientX - carry.originX, event.clientY - carry.originY) > DRAG_THRESHOLD
    setCarry({
      ...carry,
      clientX: event.clientX,
      clientY: event.clientY,
      clock: clockAt(event.clientX),
      over: overFilm(event.clientX, event.clientY),
      moved,
    })
  }

  const cancelShot = (event: PointerEvent<HTMLButtonElement>) => {
    releasePointer(event)
    setCarry(null)
  }

  const releaseShot = (event: PointerEvent<HTMLButtonElement>, view: LaneView, index: number) => {
    releasePointer(event)
    if (carry === null || carry.pointerId !== event.pointerId) return
    setCarry(null)
    clickAfterDrag.swallow()
    if (!carry.moved) {
      if (!isPickedShot(view, index)) selectShot(view, index)
      return
    }
    if (!overFilm(event.clientX, event.clientY)) return
    onInsert(carry.pick, insertIndexAt(segments, clockAt(event.clientX) - bodyStart))
  }

  const clickShot = (view: LaneView, index: number) => {
    if (clickAfterDrag.take()) return
    selectShot(view, index)
  }

  const keyShot = (event: KeyboardEvent<HTMLButtonElement>, view: LaneView, index: number) => {
    if (event.key === 'Enter' && isPickedShot(view, index) && pick !== undefined) {
      event.preventDefault()
      insertAtPlayhead(pick)
    }
  }

  const pickBounds = (view: LaneView, edge: Edge) =>
    pick === undefined || view.duration == null
      ? { min: 0, max: 0 }
      : edge === 'start'
        ? {
            min: 0,
            max: roundToMs(pick.end - Math.min(MIN_SEGMENT_SECONDS, segmentDuration(pick))),
          }
        : {
            min: roundToMs(pick.start + Math.min(MIN_SEGMENT_SECONDS, segmentDuration(pick))),
            max: roundToMs(view.duration),
          }

  const setPickEdge = (view: LaneView, edge: Edge, value: number) => {
    if (pick === undefined) return
    const { min, max } = pickBounds(view, edge)
    const next = { ...pick, [edge]: roundToMs(Math.min(max, Math.max(min, value))) }
    onPick(next)
    onPreviewMaterial(next, next[edge], edge)
  }

  const pressPickHandle = (event: PointerEvent<HTMLButtonElement>, edge: Edge) => {
    if (pick === undefined) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    onPreviewMaterial(pick, pick[edge], edge)
    setPickHandle({ pointerId: event.pointerId, edge, value: pick[edge] })
  }

  const dragPickHandle = (event: PointerEvent<HTMLButtonElement>, view: LaneView) => {
    if (pickHandle === null || pickHandle.pointerId !== event.pointerId) return
    const { min, max } = pickBounds(view, pickHandle.edge)
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect()
    if (bounds === undefined || bounds.width === 0) return
    const clock = ((event.clientX - bounds.left) / bounds.width) * materialScale
    const value = roundToMs(Math.min(max, Math.max(min, clock)))
    setPickHandle({
      ...pickHandle,
      value,
    })
    if (pick !== undefined)
      onPreviewMaterial({ ...pick, [pickHandle.edge]: value }, value, pickHandle.edge)
  }

  const releasePickHandle = (event: PointerEvent<HTMLButtonElement>, view: LaneView) => {
    if (pickHandle === null || pickHandle.pointerId !== event.pointerId) return
    releasePointer(event)
    setPickHandle(null)
    setPickEdge(view, pickHandle.edge, pickHandle.value)
  }

  const cancelPickHandle = (event: PointerEvent<HTMLButtonElement>) => {
    if (pickHandle === null || pickHandle.pointerId !== event.pointerId) return
    releasePointer(event)
    if (pick !== undefined) onPreviewMaterial(pick, pick[pickHandle.edge], pickHandle.edge)
    setPickHandle(null)
  }

  const keyPickHandle = (event: KeyboardEvent<HTMLButtonElement>, view: LaneView, edge: Edge) => {
    if (pick === undefined) return
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      insertAtPlayhead(pick)
      return
    }
    const delta = arrowStep(event)
    if (delta === undefined) return
    event.preventDefault()
    setPickEdge(view, edge, pick[edge] + delta)
  }

  const boundedTime = Math.max(0, Math.min(total, currentTime))

  const trimmed = (() => {
    if (trim === null) return undefined
    const placed = layout.find((item) => item.segment.id === trim.id)
    if (placed === undefined) return undefined
    const offset = trim.value - placed.segment.start
    const from = trim.edge === 'start' ? placed.at + offset : placed.at
    const to = trim.edge === 'start' ? placed.at + placed.duration : placed.at + offset
    return { placed, from, to, shorter: placed.duration - (to - from) }
  })()
  const lifted =
    lift?.moved === true ? layout.find((item) => item.segment.id === lift.payload) : undefined
  const liftIndex = lifted === undefined ? undefined : segments.indexOf(lifted.segment)
  const liftInsert =
    lift?.moved === true ? insertIndexAt(segments, lift.clock - bodyStart) : undefined
  const showLiftInsert =
    liftInsert !== undefined &&
    liftIndex !== undefined &&
    liftInsert !== liftIndex &&
    liftInsert !== liftIndex + 1

  const selectedPlaced =
    selectedSegment === undefined
      ? undefined
      : layout.find((item) => item.segment.id === selectedSegment)
  const handleOwner = lift === null ? (trimmed?.placed ?? selectedPlaced) : undefined
  const box =
    trimmed !== undefined
      ? { from: trimmed.from, to: trimmed.to }
      : selectedPlaced !== undefined && lifted === undefined
        ? { from: selectedPlaced.at, to: selectedPlaced.at + selectedPlaced.duration }
        : undefined
  const shifted = (index: number, at: number) =>
    shift > 0 && dropIndex !== undefined && index >= dropIndex ? at + shift : at

  const shownPick = (view: LaneView) => {
    if (pick?.takeId !== view.lane.takeId || pick.sourceJobId !== view.material.jobId)
      return undefined
    return pickHandle === null ? pick : { ...pick, [pickHandle.edge]: pickHandle.value }
  }

  const overSnapshot = (status: FilmSubtitleStatus) =>
    subtitles.some((item) => item.kind === 'snapshot' && item.segmentId === status.segmentId)
  const statusOf = (status: FilmSubtitleStatus) => {
    const snapshot = overSnapshot(status)
    const className = cn('film-subtitle-status', snapshot && 'is-over-snapshot')
    const style = {
      ...span(
        shifted(
          segments.findIndex((item) => item.id === status.segmentId),
          status.at,
        ),
        status.end - status.at,
      ),
      top: snapshot ? ROW.film.top + 3 : ROW.subtitles.top + 2,
      height: snapshot ? 18 : ROW.subtitles.height - 4,
    }
    if (status.kind === 'running')
      return (
        <span className={className} key={status.segmentId} role="status" style={style}>
          <span className="film-subtitle-status-text">
            <Icon className="motion-safe:animate-spin" decorative name="loading" size="xs" />
            识别中
          </span>
        </span>
      )
    const busy = retrying.has(status.sourceJobId)
    const label = status.kind === 'failed' ? '识别失败' : '未识别'
    const action = status.kind === 'failed' ? '重试' : '识别'
    const source = materialOf(status.sourceJobId)
    return (
      <span className={className} key={status.segmentId} style={style}>
        <button
          aria-label={`${source === undefined ? '' : `${materialName(source)} `}字幕${label}，${action}`}
          className="film-subtitle-status-text is-action ui-focus"
          disabled={busy}
          onClick={() => onRetry(status.sourceJobId)}
          type="button"
        >
          {busy ? (
            <>
              <Icon className="motion-safe:animate-spin" decorative name="loading" size="xs" />
              提交中
            </>
          ) : (
            <>
              {label}
              <i>·</i>
              <b>{action}</b>
            </>
          )}
        </button>
      </span>
    )
  }

  const groups = new Map<string, LaneView[]>()
  for (const view of lanes) {
    const group = groups.get(view.material.groupId)
    if (group === undefined) groups.set(view.material.groupId, [view])
    else group.push(view)
  }
  const materialGroups = Array.from(groups).map(([id, views], groupIndex, entries) => {
    const top =
      ROW.materials +
      entries
        .slice(0, groupIndex)
        .reduce(
          (sum, [, earlier]) => sum + ROW.group + earlier.length * (ROW.lane + ROW.laneGap),
          0,
        )
    const rows = views.map((view, index) => ({
      view,
      top: top + ROW.group + index * (ROW.lane + ROW.laneGap),
    }))
    return { id, label: views[0]?.label ?? id, top, rows }
  })
  const nextTop =
    ROW.materials + materialGroups.length * ROW.group + lanes.length * (ROW.lane + ROW.laneGap)
  const materialRows = materialGroups.flatMap((group) => group.rows)
  const height = nextTop + 44

  return (
    <section
      aria-label="整片时间线"
      className="film-timeline"
      style={
        {
          '--film-leading-slot': intro == null ? '72px' : '0px',
          '--film-trailing-slot': outro == null ? '72px' : '0px',
        } as CSSProperties
      }
    >
      <div className="film-timeline-output">
        <div className="film-timeline-heads" style={{ height: ROW.film.top + ROW.film.height }}>
          <span
            className="film-timeline-head"
            style={{ top: ROW.film.top, height: ROW.film.height }}
          >
            <Icon decorative name="video" size="xs" />
            成片
          </span>
        </div>
        <div
          aria-label="时间线轨道，窄屏可横向滚动"
          className="film-timeline-scroll"
          role="region"
          ref={filmScrollRef}
          onScroll={(event) => syncHorizontalScroll(event.currentTarget)}
        >
          <div className="film-timeline-coordinate-space">
            <div
              className="film-timeline-lanes"
              data-testid="film-lanes"
              ref={lanesRef}
              style={{ height: ROW.film.top + ROW.film.height }}
            >
              <TimelineRuler
                clockAt={clockAt}
                currentTime={currentTime}
                disabled={total === 0}
                onScrub={onScrub}
                onSeek={onSeek}
                scale={scale}
                total={total}
              />

              <div
                className="film-timeline-lane is-film"
                data-testid="film-lane"
                ref={filmRowRef}
                style={{ top: ROW.film.top, height: ROW.film.height }}
              />
              {segments.length === 0 && !dropping ? (
                <span
                  className="film-timeline-empty"
                  style={{ top: ROW.film.top, height: ROW.film.height }}
                >
                  <Icon decorative name="to-bottom" size="xs" />
                  从下方素材轨选择镜头加入成片
                </span>
              ) : null}
              {(['intro', 'outro'] as const).map((position) => {
                const template = position === 'intro' ? intro : outro
                if (template == null)
                  return (
                    <BrandPlaceholder
                      brands={brands}
                      key={position}
                      position={position}
                      style={{
                        left: position === 'intro' ? -72 : `calc(${percent(total + shift)} + 8px)`,
                        top: ROW.film.top + 2,
                        height: ROW.film.height - 4,
                      }}
                    />
                  )
                const label = position === 'intro' ? '片头' : '片尾'
                const selected = selection?.kind === 'brand' && selection.position === position
                return (
                  <button
                    aria-label={`${label}：${template.name}，位置固定`}
                    aria-pressed={selected}
                    className="film-brand-block ui-focus"
                    key={position}
                    onClick={() => onSelect(selected ? undefined : { kind: 'brand', position })}
                    ref={selected ? (anchorRef as Ref<HTMLButtonElement>) : undefined}
                    style={{
                      ...span(
                        position === 'intro' ? 0 : bodyStart + bodyTotal + shift,
                        template.durationMs / 1000,
                      ),
                      top: ROW.film.top + 2,
                      height: ROW.film.height - 4,
                    }}
                    type="button"
                  >
                    <Icon decorative name="locked" size="xs" />
                    <span>
                      {label} · {seconds(template.durationMs / 1000)}
                    </span>
                  </button>
                )
              })}
              {layout.map(({ segment, at, duration }, index) => {
                const material = materialOf(segment.sourceJobId)
                const isSelected = selectedSegment === segment.id
                const isLifted = lifted?.segment.id === segment.id
                const name = `第 ${index + 1} 段 · ${material === undefined ? '' : `${materialName(material)} · `}${roundSeconds(at)}–${roundSeconds(at + duration)} 秒`
                return (
                  <button
                    aria-label={name}
                    aria-pressed={isSelected}
                    className={cn('film-segment ui-focus', isLifted && 'is-slot')}
                    key={segment.id}
                    onClick={() => clickSegment(segment.id)}
                    onFocus={() => roving.remember(segment.id)}
                    onKeyDown={(event) => keySegment(event, index, segment.id)}
                    onPointerCancel={releaseSegment}
                    onPointerDown={(event) => pressSegment(event, at, segment.id)}
                    onPointerMove={reorder.move}
                    onPointerUp={releaseSegment}
                    ref={roving.register(segment.id)}
                    style={{
                      ...span(shifted(index, at), duration),
                      top: ROW.film.top + 2,
                      height: ROW.film.height - 4,
                    }}
                    tabIndex={roving.tabIndexOf(segment.id)}
                    type="button"
                  >
                    {stripOf(segment)}
                    {material === undefined ? null : (
                      <span className="film-segment-tag">
                        {material.takeLabel} · {material.version}
                      </span>
                    )}
                  </button>
                )
              })}
              {shift > 0 && dropClock !== undefined ? (
                <span
                  aria-hidden="true"
                  className="film-timeline-slot"
                  style={{
                    ...span(dropClock, shift),
                    top: ROW.film.top + 2,
                    height: ROW.film.height - 4,
                  }}
                />
              ) : null}

              {statuses.filter(overSnapshot).map(statusOf)}
              {box === undefined ? null : (
                <span
                  aria-hidden="true"
                  className="film-timeline-box"
                  ref={anchorRef}
                  style={{
                    ...span(box.from, box.to - box.from),
                    top: ROW.film.top + 2,
                    height: ROW.film.height - 4,
                  }}
                />
              )}
              {handleOwner !== undefined &&
              trimBounds(
                segments,
                handleOwner.segment,
                'end',
                reserved,
                sourceDurationOf(handleOwner.segment),
              ) === undefined ? (
                <TimelineBubble style={bubbleAt(handleOwner.at)}>
                  来源视频时长与当前片段范围不一致，无法调整；请重新选择镜头
                </TimelineBubble>
              ) : null}
              {handleOwner === undefined
                ? null
                : (['start', 'end'] as const).map((edge) => {
                    const { segment, at } = handleOwner
                    const value = trim !== null && trim.edge === edge ? trim.value : segment[edge]
                    const bounds = trimBounds(
                      segments,
                      segment,
                      edge,
                      reserved,
                      sourceDurationOf(segment),
                    )
                    if (bounds === undefined) return null
                    return (
                      <TrimHandle
                        bounds={bounds}
                        edge={edge}
                        key={edge}
                        onKeyDown={(event) => keyTrim(event, segment, edge)}
                        onPointerCancel={cancelTrim}
                        onPointerDown={(event) => pressTrim(event, segment, edge)}
                        onPointerMove={dragTrim}
                        onPointerUp={releaseTrim}
                        pressed={trim?.edge === edge}
                        style={{
                          left: percent(at + (value - segment.start)),
                          top: ROW.film.top - 1,
                          height: ROW.film.height + 2,
                        }}
                        value={value}
                        valueText={`素材 ${roundSeconds(value)} 秒`}
                      />
                    )
                  })}
              {trimmed === undefined ? null : (
                <TrimBubble
                  length={trimmed.to - trimmed.from}
                  shorter={trimmed.shorter}
                  style={bubbleAt(trim?.edge === 'start' ? trimmed.from : trimmed.to)}
                />
              )}
              {lifted === undefined || lift === null ? null : (
                <span
                  aria-hidden="true"
                  className="film-timeline-ghost"
                  style={{
                    ...span(
                      Math.min(
                        Math.max(0, lift.clock - lift.grab),
                        Math.max(0, scale - lifted.duration),
                      ),
                      lifted.duration,
                    ),
                    top: ROW.film.top - 4,
                    height: ROW.film.height - 4,
                  }}
                >
                  {stripOf(lifted.segment)}
                </span>
              )}
              {showLiftInsert ? (
                <span
                  aria-hidden="true"
                  className="film-timeline-insert"
                  style={{ left: percent(bodyStart + insertClockOf(segments, liftInsert)) }}
                />
              ) : null}

              {carried === undefined || carry === null ? null : (
                <>
                  {dropping && dropClock !== undefined ? (
                    <>
                      <span
                        aria-hidden="true"
                        className={cn('film-timeline-insert', !dropFits && 'is-blocked')}
                        data-testid="film-insert"
                        style={{ left: percent(dropClock) }}
                      />
                      <TimelineBubble style={{ ...bubbleAt(dropClock), top: -1 }}>
                        <Icon decorative name={dropFits ? 'insert' : 'blocked'} size="xs" />
                        {dropFits
                          ? `插入到 ${dropClock.toFixed(2)} 秒`
                          : carriedDuration < MIN_SEGMENT_SECONDS
                            ? `镜头不足 ${MIN_SEGMENT_SECONDS} 秒，请拖动两端扩展范围`
                            : segments.length >= MAX_FILM_SEGMENTS
                              ? `片段最多 ${MAX_FILM_SEGMENTS} 段，无法继续插入`
                              : `整片含片头片尾最长 ${MAX_FILM_SECONDS} 秒，放不下这 ${carriedDuration.toFixed(1)} 秒`}
                      </TimelineBubble>
                    </>
                  ) : null}
                  {dropping && dropClock !== undefined ? (
                    <span
                      aria-hidden="true"
                      className="film-timeline-ghost"
                      data-testid="film-carry"
                      style={{
                        ...span(dropClock, carriedDuration),
                        top: ROW.film.top + 2,
                        height: ROW.film.height - 4,
                      }}
                    >
                      {stripOf(carried)}
                    </span>
                  ) : null}
                </>
              )}

              <span
                aria-hidden="true"
                className="timeline-playhead"
                style={{
                  left: percent(boundedTime),
                  top: ROW.film.top - 4,
                  height: ROW.film.height + 4,
                }}
              />

              <div
                className="film-music-offset"
                ref={setCutMarkerContainer}
                style={{ left: percent(bodyStart), width: percent(scale - bodyStart) }}
              />
            </div>
          </div>
        </div>
      </div>
      <div
        aria-label="候选素材"
        className="film-timeline-candidates"
        role="region"
        ref={candidatesRef}
      >
        <div className="film-timeline-secondary" style={{ height }}>
          <div className="film-timeline-heads" style={{ height }}>
            <span
              className="film-timeline-head"
              style={{ top: ROW.subtitles.top, height: ROW.subtitles.height }}
            >
              <Icon decorative name="captions" size="xs" />
              字幕
              {subtitleSettings}
            </span>
            <span
              className="film-timeline-head"
              style={{ top: ROW.music.top, height: ROW.music.height }}
            >
              <Icon decorative name="music" size="xs" />
              音乐
              {musicAdd}
            </span>
            {materialRows.map(({ view, top }) => (
              <span
                className="film-timeline-head is-material"
                key={view.lane.takeId}
                style={{ top, height: ROW.lane }}
              >
                <b>{view.material.takeLabel}</b>
                <VersionPill
                  current={view.material}
                  durationOf={durationOf}
                  groupLabel={`${view.label} ${view.material.takeLabel}`}
                  onSwitch={(material) => onSwitchVersion(view, material)}
                  versions={view.versions}
                />
              </span>
            ))}
          </div>
          <div
            className="film-timeline-scroll"
            ref={candidateScrollRef}
            onScroll={(event) => syncHorizontalScroll(event.currentTarget)}
          >
            <div className="film-timeline-coordinate-space">
              <div className="film-timeline-lanes" style={{ height }}>
                <div
                  className="film-timeline-lane"
                  style={{ top: ROW.subtitles.top, height: ROW.subtitles.height }}
                />
                {subtitles.map((item, order) => {
                  const index = segments.findIndex((segment) => segment.id === item.segmentId)
                  const isSelected = selectedSubtitle === item.key
                  return (
                    <button
                      aria-label={`第 ${order + 1} 条字幕：${item.text.trim() === '' ? '未填写' : item.text}`}
                      aria-pressed={isSelected}
                      className={cn(
                        'film-subtitle ui-focus',
                        item.text.trim() === '' && 'is-empty',
                      )}
                      key={item.key}
                      onClick={() =>
                        onSelect(isSelected ? undefined : { kind: 'subtitle', key: item.key })
                      }
                      ref={isSelected ? (anchorRef as Ref<HTMLButtonElement>) : undefined}
                      style={{
                        ...span(shifted(index, item.at), item.end - item.at),
                        top: ROW.subtitles.top + 2,
                        height: ROW.subtitles.height - 4,
                      }}
                      title={item.text}
                      type="button"
                    >
                      {item.text.trim() === '' ? '未填写' : item.text}
                    </button>
                  )
                })}
                {statuses.filter((status) => !overSnapshot(status)).map(statusOf)}

                <div
                  className="film-timeline-lane"
                  style={{ top: ROW.music.top, height: ROW.music.height }}
                />
                <div
                  className="film-music-offset"
                  style={{ left: percent(bodyStart), width: percent(scale - bodyStart) }}
                >
                  <MusicTrack
                    anchorRef={anchorRef}
                    cuts={internalCuts(segments)}
                    filmTop={ROW.film.top}
                    cutMarkerContainer={cutMarkerContainer}
                    onMove={onMoveMusic}
                    onRemove={onRemoveMusic}
                    onScrub={onScrub}
                    onSelect={(selected) => onSelect(selected ? { kind: 'music' } : undefined)}
                    row={ROW.music}
                    scale={scale - bodyStart}
                    secondsOf={secondsOf}
                    selected={selection?.kind === 'music'}
                    total={bodyTotal}
                    view={music}
                  />
                </div>

                <span
                  aria-hidden="true"
                  className="timeline-playhead"
                  style={{
                    left: percent(boundedTime),
                    top: ROW.subtitles.top,
                    height: ROW.music.top + ROW.music.height - ROW.subtitles.top,
                  }}
                />
                {materialRows.map(({ view, top }) => {
                  const shown = shownPick(view)
                  const used = segments.filter(
                    (segment) => segment.sourceJobId === view.material.jobId,
                  )
                  const hintId = `film-lane-hint-${view.lane.takeId}`
                  return (
                    <div key={view.lane.takeId}>
                      <div
                        aria-describedby={hintId}
                        aria-label={`${materialName(view.material)} 素材`}
                        className="film-material-lane"
                        role="group"
                        style={{ top, height: ROW.lane }}
                      >
                        <span className="sr-only" id={hintId}>
                          点击镜头可选中，拖动两端可调整范围；选中后按回车，插入到播放头所在的位置
                        </span>
                        {view.shotState === 'loading' ? (
                          <span className="film-material-loading" role="status">
                            正在读取镜头分段…
                          </span>
                        ) : view.shotState === 'error' ? (
                          <span className="film-material-loading" role="alert">
                            镜头分段读取失败，请重试
                            <button
                              className="film-music-status-action ui-focus"
                              onClick={() => view.onRetryShots()}
                              type="button"
                            >
                              重试
                            </button>
                          </span>
                        ) : (
                          view.shots.map((shot, index) => (
                            <button
                              aria-label={`${materialName(view.material)} 镜头 ${index + 1}，${shot.start.toFixed(1)}–${shot.end.toFixed(1)} 秒`}
                              aria-pressed={
                                pick?.takeId === view.lane.takeId &&
                                pick.sourceJobId === view.material.jobId &&
                                pick.shotIndex === index
                              }
                              className="film-material-shot ui-focus"
                              key={shot.start}
                              onClick={() => clickShot(view, index)}
                              onKeyDown={(event) => keyShot(event, view, index)}
                              onPointerCancel={cancelShot}
                              onPointerDown={(event) => pressShot(event, view, index)}
                              onPointerMove={dragShot}
                              onPointerUp={(event) => releaseShot(event, view, index)}
                              style={{
                                ...materialSpan(shot.start, shot.end - shot.start),
                                height: ROW.lane - 4,
                              }}
                              type="button"
                            >
                              <Frames
                                part={{
                                  mediaUrl: view.material.url,
                                  start: shot.start,
                                  end: shot.end,
                                }}
                              />
                              <span className="film-material-shot-label">
                                <b>镜头 {index + 1}</b>
                                <span>
                                  {shot.start.toFixed(1)}–{shot.end.toFixed(1)} 秒
                                </span>
                              </span>
                            </button>
                          ))
                        )}
                        {used.map((segment) => (
                          <span
                            aria-hidden="true"
                            className="film-material-used"
                            key={segment.id}
                            style={{
                              left: `calc(${materialPercent(segment.start)} + 1px)`,
                              width: `max(3px, calc(${materialPercent(segment.end - segment.start)} - 2px))`,
                            }}
                          />
                        ))}
                      </div>
                      {shown === undefined ? null : (
                        <>
                          <span
                            aria-hidden="true"
                            className="film-material-pick"
                            data-testid="material-pick"
                            style={{
                              left: `calc(${materialPercent(shown.start)} - 3px)`,
                              width: `calc(${materialPercent(shown.end - shown.start)} + 4px)`,
                              top: top - 1,
                              height: ROW.lane + 2,
                            }}
                          />
                          {carry?.moved === true
                            ? null
                            : (['start', 'end'] as const).map((edge) => {
                                const value = shown[edge]
                                const bounds = pickBounds(view, edge)
                                return (
                                  <button
                                    aria-label={edge === 'start' ? '选区开头' : '选区结尾'}
                                    aria-valuemax={roundSeconds(bounds.max)}
                                    aria-valuemin={roundSeconds(bounds.min)}
                                    aria-valuenow={roundSeconds(value)}
                                    aria-valuetext={`素材 ${roundSeconds(value)} 秒`}
                                    className={cn(
                                      'film-material-handle ui-focus',
                                      `is-${edge}`,
                                      pickHandle?.edge === edge && 'is-pressed',
                                    )}
                                    key={edge}
                                    onKeyDown={(event) => keyPickHandle(event, view, edge)}
                                    onPointerCancel={cancelPickHandle}
                                    onPointerDown={(event) => pressPickHandle(event, edge)}
                                    onPointerMove={(event) => dragPickHandle(event, view)}
                                    onPointerUp={(event) => releasePickHandle(event, view)}
                                    role="slider"
                                    style={{
                                      left: materialPercent(value),
                                      top: top - 1,
                                      height: ROW.lane + 2,
                                    }}
                                    title="拖动可调整选区，按方向键可微调，按回车插入到播放头处"
                                    type="button"
                                  />
                                )
                              })}
                          <span
                            className="film-material-range"
                            style={{
                              ...bubbleAt(((shown.start + shown.end) / 2 / materialScale) * scale),
                              top: top - 22,
                            }}
                          >
                            {shown.start.toFixed(2)}–{shown.end.toFixed(2)} 秒
                          </span>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          {materialGroups.map((group) => {
            const selected = group.rows.find(({ view }) => shownPick(view) !== undefined)
            const current = selected === undefined ? undefined : shownPick(selected.view)
            const reason =
              current === undefined
                ? '请先选择一个镜头'
                : segmentDuration(current) < MIN_SEGMENT_SECONDS
                  ? `镜头不足 ${MIN_SEGMENT_SECONDS} 秒，请拖动两端扩展范围`
                  : segments.length >= MAX_FILM_SEGMENTS
                    ? `片段最多 ${MAX_FILM_SEGMENTS} 段`
                    : !fitsInFilm(segments, segmentDuration(current), reserved)
                      ? `整片含片头片尾最长 ${MAX_FILM_SECONDS} 秒`
                      : undefined
            return (
              <div className="film-material-group" key={group.id} style={{ top: group.top }}>
                <b>{group.label}</b>
                <BlockedReason reason={reason}>
                  <button
                    aria-label={`${group.label} 加入成片`}
                    className="film-material-add ui-state ui-focus"
                    aria-disabled={reason !== undefined}
                    onClick={() => {
                      if (current !== undefined && reason === undefined) insertAtPlayhead(current)
                    }}
                    type="button"
                  >
                    <Icon decorative name="add" size="xs" />
                    加入成片
                  </button>
                </BlockedReason>
              </div>
            )
          })}
          <div className="film-timeline-materials-add" style={{ top: nextTop }}>
            {addVideo}
          </div>
        </div>
      </div>
      {carried !== undefined && carry !== null && !dropping
        ? createPortal(
            <span
              aria-hidden="true"
              className="film-timeline-ghost film-timeline-carry"
              data-testid="film-carry"
              style={{
                left: carry.clientX - carry.grab * carry.pixelsPerSecond,
                top: carry.clientY - (ROW.lane - 8) / 2,
                width: carriedDuration * carry.pixelsPerSecond,
                height: ROW.lane - 8,
              }}
            >
              {stripOf(carried)}
            </span>,
            document.body,
          )
        : null}
    </section>
  )
}
