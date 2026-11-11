import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { Icon, type IconName } from '@/shared/icons'
import type { TimeSpan } from '@/shared/lib/time-spans'
import { cn } from '@/shared/lib/utils'
import { useEscapeAheadOfDialog } from '@/shared/ui/dialog'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import { bubbleAlign } from '../editing/bubble-align'
import { useEdgeScroll } from '../editing/edge-scroll'
import type { PeaksState } from '../editing/media-analysis'
import { trimSpans, usePreviewGesture, type GesturePreview } from '../editing/preview-gesture'
import {
  Frames,
  LimitBubble,
  TimelinePlayhead,
  TimelineRuler,
  TrimHandle,
  Wave,
} from '../editing/timeline'
import {
  arrowStep,
  DRAG_THRESHOLD,
  releasePointer,
  useClickAfterDrag,
} from '../editing/timeline-drag'
import {
  InsertionGhost,
  InsertionPreview,
  type InsertionBox,
  type InsertionFace,
  type InsertionGhostHandle,
  type InsertionPreviewHandle,
  type InsertionMotion,
} from '../editing/timeline-insertion'
import { TRIM_LIMIT_TEXT } from '../editing/trim-limit'
import { useInsertionMotion, type MotionSnapshot } from '../editing/use-insertion-motion'
import { captionKey } from './canvas-targets'
import type { TrackLane } from './component-placement'
import type { PlacedCaption } from './composition/captions'
import type { EditContext, MusicBeat } from './editing/context'
import {
  MAX_FILM_MS,
  MIN_CLIP_MS,
  type Layer0Clip,
  type OverlayClip,
  type VideoClip,
  type WholeFilmDraft,
} from './editing/draft'
import { moveClips, trimClip } from './editing/layer0'
import { musicShortfallMs, setMusicOffset } from './editing/music'
import {
  moveOverlay,
  overlayRowAt,
  overlayRowCount,
  trimOverlay,
  type OverlayRow,
} from './editing/overlays'
import type { EditResult } from './editing/result'
import { cutsOf, filmDuration, insertIndexAt, layer0End } from './editing/timeline'
import { FILM_LIMIT_TEXT } from './refusal-text'
import { clipIdsOf, clipSelection, type Selection } from './selection'
import {
  msToPx,
  pxToMs,
  rulerTickStep,
  snapMs,
  snapSpanStartMs,
  snapTargets,
  type TimelineScale,
} from './timeline-scale'

export type MusicView = { url: string; title: string; peaks: PeaksState }

export type ComponentFace = { title: string; thumbnail: string | undefined; icon: IconName }

export type DropPoint = {
  timeMs: number
  lane: TrackLane
  overlayRow: OverlayRow
  guideMs: number | null
}

export type Attempt = { ok: true; draft: WholeFilmDraft } | { ok: false; reason: string }

export type CarryPayload = {
  durationMs: number
  ghost?: { face: InsertionFace; origin: InsertionBox } | undefined
  attempt: (point: DropPoint) => Attempt | undefined
  drop: (point: DropPoint) => boolean
}

export type TracksHandle = {
  carry: (clientX: number, clientY: number, payload: CarryPayload) => void
  release: (clientX: number, clientY: number, payload: CarryPayload) => boolean
  cancel: () => void
  focusClip: (clipId: string) => void
}

export type ComponentPopovers = {
  openId: string | null
  onOpen: (id: string | null) => void
  render: (id: string) => ReactNode
  hasFields: (component: string) => boolean
}

type FilmTracksProps = {
  draft: WholeFilmDraft
  context: EditContext
  scale: TimelineScale
  playheadMs: number
  onSeek: (ms: number) => void
  selection: Selection
  onSelect: (selection: Selection) => void
  onClipClick: (clip: Layer0Clip, extend: boolean) => void
  snap: boolean
  beats: readonly MusicBeat[]
  buffered: readonly TimeSpan[]
  clipLabel: (clip: VideoClip) => string
  componentFace: (name: string) => ComponentFace
  urlOf: (sourceJobId: string) => string | undefined
  peaks: ReadonlyMap<string, PeaksState>
  music: MusicView | undefined
  apply: (result: EditResult) => boolean
  onViewportWidth: (width: number) => void
  tracksRef: RefObject<TracksHandle | null>
  popovers: ComponentPopovers
  captions: readonly PlacedCaption[]
  sentenceText: (caption: PlacedCaption) => string
  onCaptionText: (caption: PlacedCaption, text: string) => void
  captionControls: ReactNode
  captionStatus: ReactNode
  musicAction: ReactNode
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

const INSET_START_PX = 8
const INSET_END_PX = 16
const ROW_PX = 24
const ROWS_TOP_PX = 2
const NEW_ROW_ABOVE_PX = 8
const NEW_ROW_BELOW_PX = 10
const DROP_SLOP_PX = 16
const LANE_SLOP_PX = 4
const ON_BEAT_MS = 10

type Edge = 'start' | 'end'

const spanMs = (clips: readonly Layer0Clip[]) => clips.reduce((sum, clip) => sum + clip.duration, 0)

const layer0TrimNote = (
  draft: WholeFilmDraft,
  clip: Layer0Clip,
  edge: Edge,
  deltaMs: number,
  context: EditContext,
) => {
  const result = trimClip(draft, { clipId: clip.id, edge, deltaMs }, context)
  const after = result.ok ? result.draft.layer0.find((c) => c.id === clip.id) : undefined
  if (!result.ok || after === undefined) return undefined
  const wanted = clip.duration + (edge === 'end' ? deltaMs : -deltaMs)
  if (after.duration === wanted) return undefined
  if (wanted < after.duration) return TRIM_LIMIT_TEXT.shortest(MIN_CLIP_MS / 1000)
  if (layer0End(result.draft) >= MAX_FILM_MS) return FILM_LIMIT_TEXT
  return TRIM_LIMIT_TEXT[edge]
}

type GestureStep = {
  trim?: { clipId: string; edge: Edge } | undefined
  result: EditResult
  guideMs?: number | null
  note?: string | undefined
  noteAtMs?: number | undefined
  row?: OverlayRow | undefined
  overlayId?: string | undefined
}

const filmPreviewOf = (preview: GesturePreview<GestureStep> | null) => {
  if (preview === null) return null
  const { last, step } = preview
  if (!last.result.ok) return null
  return {
    draft: last.result.draft,
    guideMs: step.result.ok ? (step.guideMs ?? null) : null,
    note: step.note,
    noteAtMs: step.noteAtMs ?? last.noteAtMs,
    row: last.row,
    overlayId: last.overlayId,
    trim: last.trim,
  }
}

type Carrying = {
  clientX: number
  clientY: number
  payload: CarryPayload
  point: DropPoint | undefined
  attempt: Attempt | undefined
  overlayTop: number | undefined
  returning: boolean
  destination?: InsertionBox | undefined
}

type Lift = {
  clipIds: readonly string[]
  from: number
  durationMs: number
  pointerId: number
  originX: number
  originY: number
  clientX: number
  clientY: number
  moved: boolean
  origin: InsertionBox
  to: number | undefined
  returning: boolean
  destination?: InsertionBox | undefined
}

type PointerHandlers = {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void
  onPointerMove: (event: PointerEvent<HTMLElement>) => void
  onPointerUp: (event: PointerEvent<HTMLElement>) => void
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void
}

type BlockProps = {
  className: string
  name: string
  selected: boolean
  style: CSSProperties
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void
  pointer: PointerHandlers
  handles: ReactNode
  popover?: ReactNode
  clipId?: string
  slide?: string
  shortcuts?: string
  motion?:
    | {
        driver: InsertionMotion
        x: number
        y?: number
        width: number
        opacity: number
        animate: boolean
        followX?: boolean
        initial?: MotionSnapshot | undefined
      }
    | undefined
  children: ReactNode
}

function Block({
  className,
  name,
  selected,
  style,
  onSelect,
  pointer,
  handles,
  popover,
  clipId,
  slide,
  shortcuts,
  motion,
  children,
}: BlockProps) {
  const elementRef = useRef<HTMLDivElement>(null)
  const previousRef = useRef(false)
  const initialRef = useRef<MotionSnapshot | undefined>(undefined)
  const driver = motion?.driver
  const x = motion?.x
  const y = motion?.y
  const width = motion?.width
  const opacity = motion?.opacity
  const animate = motion?.animate ?? false
  const followX = motion?.followX ?? false
  const snapshot = motion?.initial
  useLayoutEffect(() => {
    const node = elementRef.current
    if (
      node === null ||
      driver === undefined ||
      x === undefined ||
      width === undefined ||
      opacity === undefined
    )
      return
    const landed = snapshot !== undefined && initialRef.current !== snapshot
    if (landed) {
      driver.seed(node, {
        value: {
          ...snapshot.value,
          y: y === undefined ? 0 : (snapshot.value.y ?? y),
          opacity: 0.65,
        },
        velocity: {
          ...snapshot.velocity,
          y: y === undefined ? 0 : (snapshot.velocity.y ?? 0),
          opacity: 0,
        },
      })
      initialRef.current = snapshot
    }
    if (followX) driver.move(node, { x }, { immediate: true })
    driver.move(
      node,
      { x, y: y ?? 0, width, opacity },
      { immediate: !animate && !previousRef.current && !landed },
    )
    previousRef.current = animate
  }, [driver, x, y, width, opacity, animate, followX, snapshot])
  return (
    <div
      aria-label={name}
      className={cn(className, selected && 'is-selected')}
      data-slide={slide}
      ref={elementRef}
      role="group"
      style={motion === undefined ? style : { ...style, left: 0, width: undefined }}
    >
      {popover}
      <button
        aria-haspopup={popover === undefined ? undefined : 'dialog'}
        aria-keyshortcuts={shortcuts}
        aria-label={`选中：${name}`}
        aria-pressed={selected}
        className="wf-block-body ui-focus"
        data-clip-id={clipId}
        onClick={onSelect}
        type="button"
        {...pointer}
      >
        {children}
      </button>
      {selected ? handles : null}
    </div>
  )
}

function ComponentThumb({ face }: { face: ComponentFace }) {
  return face.thumbnail === undefined ? (
    <Icon decorative name={face.icon} size="xs" />
  ) : (
    <img alt="" draggable={false} src={face.thumbnail} />
  )
}

function OverlayFace({ face }: { face: ComponentFace }) {
  return (
    <>
      <span className="wf-overlay-thumb">
        <ComponentThumb face={face} />
      </span>
      <span className="wf-overlay-name">{face.title}</span>
    </>
  )
}

export function FilmTracks({
  draft,
  context,
  scale,
  playheadMs,
  onSeek,
  selection,
  onSelect,
  onClipClick,
  snap,
  beats,
  buffered,
  clipLabel,
  componentFace,
  urlOf,
  peaks,
  music,
  apply,
  onViewportWidth,
  tracksRef,
  popovers,
  captions,
  sentenceText,
  onCaptionText,
  captionControls,
  captionStatus,
  musicAction,
}: FilmTracksProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const clicks = useClickAfterDrag()
  const gesture = usePreviewGesture<GestureStep>({
    containerRef: contentRef,
    viewportRef: scrollRef,
    clicks,
    accepts: (step) => step.result.ok,
    onCommit: (last) => apply(last.result),
  })
  const preview = filmPreviewOf(gesture.preview)
  const previewed = preview?.draft ?? draft
  const shown = preview?.trim === undefined ? previewed : draft
  const layer0Trim = (() => {
    const trim = preview?.trim
    const clip = draft.layer0.find((candidate) => candidate.id === trim?.clipId)
    const after = previewed.layer0.find((candidate) => candidate.id === trim?.clipId)
    if (trim === undefined || clip === undefined || after === undefined) return undefined
    const spans = trimSpans(trim.edge, { at: clip.start, len: clip.duration }, after.duration)
    const face: Layer0Clip = {
      ...clip,
      start: spans.block.at,
      duration: spans.block.len,
      playbackStart: Math.min(clip.playbackStart, after.playbackStart),
    }
    return { clipId: clip.id, face, ...spans }
  })()
  const total = filmDuration(shown)
  const { pps, contentWidth } = scale
  const beatsMs = beats.map((beat) => beat.timeMs)
  const gridStep = rulerTickStep(contentWidth / Math.max(pps, 1))
  const filmLaneRef = useRef<HTMLDivElement>(null)
  const overlayLaneRef = useRef<HTMLDivElement>(null)
  const musicLaneRef = useRef<HTMLDivElement>(null)
  const [carry, setCarry] = useState<Carrying | null>(null)
  const [lift, setLift] = useState<Lift | null>(null)
  const liftCancelledRef = useRef(false)
  const motion = useInsertionMotion()
  const ghostRef = useRef<InsertionGhostHandle>(null)
  const filmPreviewRef = useRef<InsertionPreviewHandle>(null)
  const overlayPreviewRef = useRef<InsertionPreviewHandle>(null)
  const [landing, setLanding] = useState<{
    id: string
    snapshot: MotionSnapshot | undefined
  } | null>(null)
  const pointerRef = useRef<{ clientX: number; clientY: number } | null>(null)

  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const report = () =>
      onViewportWidth(Math.max(0, element.clientWidth - INSET_START_PX - INSET_END_PX))
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  }, [onViewportWidth])

  const timeAt = (clientX: number) =>
    Math.max(0, pxToMs(clientX - (contentRef.current?.getBoundingClientRect().left ?? 0), pps))

  const rows = overlayRowCount(draft.overlays)
  const carriedRow =
    carry !== null && !carry.returning && carry.point?.lane === 'overlay' && carry.attempt?.ok
      ? carry.point.overlayRow
      : undefined
  const previewRow = carriedRow ?? preview?.row
  const newRow = previewRow !== undefined && 'insertAt' in previewRow ? previewRow : undefined
  const laneRows = Math.max(1, rows + (newRow === undefined ? 0 : 1))

  const overlayRowFrom = (
    clientY: number,
    activeRow = carriedRow,
    originTop = carry?.returning === false ? carry.overlayTop : undefined,
  ): OverlayRow | undefined => {
    const lane = overlayLaneRef.current?.getBoundingClientRect()
    if (lane === undefined) return undefined
    const expanding = activeRow !== undefined && 'insertAt' in activeRow && rows > 0
    const top = expanding
      ? lane.bottom - ((rows + 1) * ROW_PX + ROWS_TOP_PX)
      : (originTop ?? lane.top)
    let y = clientY - top - ROWS_TOP_PX
    if (expanding) {
      const previewTop = top + ROWS_TOP_PX + activeRow.insertAt * ROW_PX
      const edge = (originTop ?? lane.top) + ROWS_TOP_PX + activeRow.insertAt * ROW_PX
      const from = Math.min(previewTop, edge - (activeRow.insertAt === 0 ? NEW_ROW_ABOVE_PX : 0))
      const to = Math.max(
        previewTop + ROW_PX,
        edge + (activeRow.insertAt === 0 ? 0 : NEW_ROW_BELOW_PX),
      )
      if (clientY >= from && clientY < to) return activeRow
      if (y >= activeRow.insertAt * ROW_PX) y -= ROW_PX
    }
    const below = Math.max(1, rows) * ROW_PX + NEW_ROW_BELOW_PX
    if (y < -NEW_ROW_ABOVE_PX || y >= below) return undefined
    return rows === 0 ? { insertAt: 0 } : overlayRowAt(y / ROW_PX, rows)
  }

  const overFilm = (clientX: number, clientY: number) => {
    const viewport = scrollRef.current?.getBoundingClientRect()
    const film = filmLaneRef.current?.getBoundingClientRect()
    if (viewport === undefined || film === undefined) return false
    return (
      clientX >= viewport.left &&
      clientX <= viewport.right &&
      clientY >= film.top - DROP_SLOP_PX &&
      clientY <= film.bottom
    )
  }

  const filmIndex = (clientX: number, duration: number, lifted?: Lift) => {
    const items =
      lifted === undefined
        ? draft.layer0
        : draft.layer0.filter((clip) => !lifted.clipIds.includes(clip.id))
    const point = timeAt(clientX)
    const existing =
      lifted !== undefined
        ? lifted.moved && lifted.to !== undefined
          ? lifted.to > lifted.from
            ? lifted.to - lifted.clipIds.length
            : lifted.to
          : undefined
        : carry !== null &&
            !carry.returning &&
            carry.point?.lane === 'film' &&
            carry.attempt?.ok === true
          ? insertIndexAt(draft.layer0, carry.point.timeMs)
          : undefined
    const existingStart =
      existing === undefined
        ? 0
        : items.slice(0, existing).reduce((sum, clip) => sum + clip.duration, 0)
    let index = items.length
    if (
      existing !== undefined &&
      point >= existingStart - 70 &&
      point <= existingStart + duration + 70
    )
      index = existing
    else {
      let start = 0
      for (const [i, item] of items.entries()) {
        const shifted = start + (existing !== undefined && i >= existing ? duration : 0)
        if (point < shifted + item.duration / 2) {
          index = i
          break
        }
        start += item.duration
      }
    }
    return lifted !== undefined && index > lifted.from ? index + lifted.clipIds.length : index
  }

  const pointAt = (
    clientX: number,
    clientY: number,
    durationMs?: number,
  ): DropPoint | undefined => {
    const viewport = scrollRef.current?.getBoundingClientRect()
    if (viewport === undefined || clientX < viewport.left || clientX > viewport.right)
      return undefined
    const near = (lane: HTMLDivElement | null) => {
      const rect = lane?.getBoundingClientRect()
      return (
        rect !== undefined &&
        clientY >= rect.top - LANE_SLOP_PX &&
        clientY <= rect.bottom + LANE_SLOP_PX
      )
    }
    const timeMs = timeAt(clientX)
    const overlayRow = overlayRowFrom(clientY)
    const lane: TrackLane | undefined = overFilm(clientX, clientY)
      ? 'film'
      : overlayRow !== undefined
        ? 'overlay'
        : near(musicLaneRef.current)
          ? 'music'
          : undefined
    if (lane === undefined) return undefined
    const row = overlayRow ?? { insertAt: 0 }
    if (lane === 'film' && durationMs !== undefined) {
      const index = filmIndex(clientX, durationMs)
      return {
        timeMs: draft.layer0[index]?.start ?? layer0End(draft),
        lane,
        overlayRow: row,
        guideMs: null,
      }
    }
    if (lane !== 'overlay' || durationMs === undefined)
      return { timeMs, lane, overlayRow: row, guideMs: null }
    const targets = snapTargets({
      spans: [...draft.layer0, ...draft.overlays],
      playheadMs,
      beatsMs,
    })
    const snapped = snapSpanStartMs(timeMs, durationMs, targets, pps, snap, gridStep)
    return { timeMs: snapped.ms, lane, overlayRow: row, guideMs: snapped.guideMs }
  }

  const carryTo = (clientX: number, clientY: number, payload: CarryPayload): Carrying => {
    const point = pointAt(clientX, clientY, payload.durationMs)
    return {
      clientX,
      clientY,
      payload,
      point,
      attempt: point === undefined ? undefined : payload.attempt(point),
      overlayTop:
        carry !== null && !carry.returning
          ? carry.overlayTop
          : overlayLaneRef.current?.getBoundingClientRect().top,
      returning: false,
    }
  }

  const liftTo = (current: Lift, clientX: number, clientY: number): Lift => ({
    ...current,
    clientX,
    clientY,
    to: overFilm(clientX, clientY) ? filmIndex(clientX, current.durationMs, current) : undefined,
  })

  const rememberLanding = (id: string, lane: 'film' | 'overlay') => {
    const node = lane === 'film' ? filmPreviewRef.current : overlayPreviewRef.current
    setLanding({ id, snapshot: node?.snapshot() })
  }
  const destinationOf = (
    start: number,
    duration: number,
    lane: 'film' | 'overlay',
    row = 0,
  ): InsertionBox | undefined => {
    const rect = (
      lane === 'film' ? filmLaneRef.current : overlayLaneRef.current
    )?.getBoundingClientRect()
    if (rect === undefined) return undefined
    return {
      left: rect.left + msToPx(start, pps),
      top: rect.top + 2 + row * ROW_PX,
      width: Math.max(6, msToPx(duration, pps) - 2),
      height: lane === 'film' ? 48 : 22,
    }
  }
  const cancelCarry = () => {
    pointerRef.current = null
    setCarry((current) =>
      current === null || current.returning
        ? current
        : { ...current, returning: true, destination: current.payload.ghost?.origin },
    )
  }
  useEscapeAheadOfDialog(lift?.moved === true && !lift.returning, () => {
    liftCancelledRef.current = true
    pointerRef.current = null
    clicks.swallow()
    setLift((current) =>
      current === null ? null : { ...current, returning: true, destination: current.origin },
    )
  })
  useEscapeAheadOfDialog(preview?.overlayId !== undefined, gesture.cancel)

  useEffect(() => {
    tracksRef.current = {
      carry: (clientX, clientY, payload) => {
        pointerRef.current = { clientX, clientY }
        setLift(null)
        ghostRef.current?.follow(clientX, clientY)
        const next = carryTo(clientX, clientY, payload)
        setCarry((current) =>
          current !== null &&
          !current.returning &&
          JSON.stringify(current.point) === JSON.stringify(next.point) &&
          current.attempt?.ok === next.attempt?.ok &&
          (current.attempt?.ok !== false ||
            next.attempt?.ok !== false ||
            current.attempt.reason === next.attempt.reason)
            ? current
            : next,
        )
      },
      release: (clientX, clientY, payload) => {
        pointerRef.current = null
        const point = carry !== null && !carry.returning ? carry.point : undefined
        const attempt = point === undefined ? undefined : payload.attempt(point)
        const dropped = point !== undefined && attempt !== undefined && payload.drop(point)
        let destination: InsertionBox | undefined
        if (dropped && attempt.ok && point.lane === 'film') {
          const added = attempt.draft.layer0.filter(
            (clip) => !draft.layer0.some((before) => before.id === clip.id),
          )
          const [first] = added
          if (first !== undefined) {
            rememberLanding(first.id, 'film')
            destination = destinationOf(first.start, spanMs(added), 'film')
          }
        } else if (dropped && attempt.ok) {
          const added = attempt.draft.overlays.find(
            (clip) => !draft.overlays.some((before) => before.id === clip.id),
          )
          if (added !== undefined) {
            rememberLanding(added.id, 'overlay')
            destination = destinationOf(added.start, added.duration, 'overlay', added.track)
          }
        }
        if (carry?.payload.ghost !== undefined)
          setCarry({
            ...carry,
            clientX,
            clientY,
            returning: true,
            destination: destination ?? carry.payload.ghost.origin,
          })
        else setCarry(null)
        return dropped
      },
      cancel: cancelCarry,
      focusClip: (clipId) => {
        requestAnimationFrame(() =>
          contentRef.current
            ?.querySelector<HTMLElement>(`[data-clip-id="${CSS.escape(clipId)}"]`)
            ?.focus({ preventScroll: true }),
        )
      },
    }
    return () => {
      tracksRef.current = null
    }
  })

  useEdgeScroll({
    viewportRef: scrollRef,
    active: (carry !== null && !carry.returning) || (lift?.moved === true && !lift.returning),
    pointer: () => pointerRef.current,
    reach: (pointer, box) =>
      pointer.clientY >= box.top - DROP_SLOP_PX &&
      pointer.clientY <= box.bottom &&
      pointer.clientX >= box.left &&
      pointer.clientX <= box.right,
    onScroll: () => {
      setCarry((current) =>
        current === null || current.returning
          ? current
          : carryTo(
              pointerRef.current?.clientX ?? current.clientX,
              pointerRef.current?.clientY ?? current.clientY,
              current.payload,
            ),
      )
      setLift((current) =>
        current === null || !current.moved || current.returning
          ? current
          : liftTo(
              current,
              pointerRef.current?.clientX ?? current.clientX,
              pointerRef.current?.clientY ?? current.clientY,
            ),
      )
    },
  })

  const selectedOverlay = selection?.kind === 'overlay' ? selection.id : undefined
  const selectedClips = clipIdsOf(selection)
  const place = (start: number, duration: number) => ({
    left: `${msToPx(start, pps)}px`,
    width: `${Math.max(6, msToPx(duration, pps) - 2)}px`,
  })

  const knownComponent = (component: string) => context.components[component] !== undefined

  const editable = (clip: Layer0Clip) =>
    clip.type === 'component'
      ? knownComponent(clip.component)
      : context.sources[clip.sourceJobId] !== undefined

  const gestureFollow: Omit<PointerHandlers, 'onPointerDown'> = {
    onPointerMove: gesture.move,
    onPointerUp: gesture.end,
    onPointerCancel: gesture.cancel,
  }

  const startTrim = (event: PointerEvent<HTMLElement>, clip: Layer0Clip, edge: Edge) => {
    const edgeMs = edge === 'end' ? clip.start + clip.duration : clip.start
    const targets = snapTargets({
      spans: draft.layer0.slice(0, draft.layer0.indexOf(clip)),
      playheadMs,
      beatsMs,
    }).filter((target) => Math.round(target.time * 1000) !== edgeMs)
    const trim = { clipId: clip.id, edge }
    gesture.startTrim(event, { slide: `clip:${clip.id}`, edge }, (deltaPx): GestureStep => {
      const pointerMs = pxToMs(deltaPx, pps)
      const snapped = snapMs(edgeMs + pointerMs, targets, pps, snap)
      const deltaMs = snapped.ms - edgeMs
      const result = trimClip(draft, { clipId: clip.id, edge, deltaMs }, context)
      const after = result.ok ? result.draft.layer0.find((c) => c.id === clip.id) : undefined
      if (!result.ok || after === undefined) return { result, trim }
      const wanted = clip.duration + (edge === 'end' ? deltaMs : -deltaMs)
      const { kept } = trimSpans(edge, { at: clip.start, len: clip.duration }, after.duration)
      return {
        result,
        trim,
        guideMs: after.duration === wanted ? snapped.guideMs : null,
        note: layer0TrimNote(draft, clip, edge, pointerMs, context),
        noteAtMs: edge === 'end' ? kept.at + kept.len : kept.at,
      }
    })
  }

  const startOverlayTrim = (event: PointerEvent<HTMLElement>, overlay: OverlayClip, edge: Edge) => {
    event.stopPropagation()
    const edgeMs = edge === 'end' ? overlay.start + overlay.duration : overlay.start
    const targets = snapTargets({
      spans: [...draft.layer0, ...draft.overlays.filter((o) => o.id !== overlay.id)],
      playheadMs,
      beatsMs,
    })
    gesture.start(event, (deltaPx): GestureStep => {
      const snapped = snapMs(edgeMs + pxToMs(deltaPx, pps), targets, pps, snap, gridStep)
      const result = trimOverlay(
        draft,
        { overlayId: overlay.id, edge, deltaMs: snapped.ms - edgeMs },
        context,
      )
      const after = result.ok ? result.draft.overlays.find((o) => o.id === overlay.id) : undefined
      if (!result.ok || after === undefined) return { result }
      const reached = edge === 'end' ? after.start + after.duration : after.start
      return {
        result,
        guideMs: reached === snapped.ms ? snapped.guideMs : null,
        note: edge === 'end' && snapped.ms > MAX_FILM_MS ? FILM_LIMIT_TEXT : undefined,
        noteAtMs: reached,
      }
    })
  }

  const startOverlayMove = (event: PointerEvent<HTMLElement>, overlay: OverlayClip) => {
    const targets = snapTargets({
      spans: [...draft.layer0, ...draft.overlays.filter((o) => o.id !== overlay.id)],
      playheadMs,
      beatsMs,
    })
    let row: OverlayRow = { track: overlay.track }
    const originTop = overlayLaneRef.current?.getBoundingClientRect().top
    gesture.start(event, (deltaPx, clientY): GestureStep => {
      row = overlayRowFrom(clientY, row, originTop) ?? row
      const snapped = snapSpanStartMs(
        overlay.start + pxToMs(deltaPx, pps),
        overlay.duration,
        targets,
        pps,
        snap,
        gridStep,
      )
      const result = moveOverlay(draft, {
        overlayId: overlay.id,
        deltaMs: snapped.ms - overlay.start,
        row,
      })
      const after = result.ok ? result.draft.overlays.find((o) => o.id === overlay.id) : undefined
      return {
        result,
        guideMs: after?.start === snapped.ms ? snapped.guideMs : null,
        note:
          result.ok && snapped.ms + overlay.duration <= MAX_FILM_MS ? undefined : FILM_LIMIT_TEXT,
        row,
        overlayId: overlay.id,
      }
    })
  }

  const keyTrim = (
    event: KeyboardEvent<HTMLButtonElement>,
    trim: (deltaMs: number) => EditResult,
  ) => {
    const step = arrowStep(event)
    if (step === undefined) return
    event.preventDefault()
    apply(trim(Math.round(step * 1000)))
  }

  const trimHandles = (
    edges: readonly Edge[],
    durationMs: number,
    what: string,
    onPress: (event: PointerEvent<HTMLElement>, edge: Edge) => void,
    trim: (edge: Edge, deltaMs: number) => EditResult,
    shiftPx = { start: 0, end: 0 },
  ) =>
    edges.map((edge) => (
      <TrimHandle
        bounds={{ min: 0.1, max: 120 }}
        edge={edge}
        key={edge}
        onKeyDown={(event) => keyTrim(event, (deltaMs) => trim(edge, deltaMs))}
        onPointerCancel={gesture.cancel}
        onPointerDown={(event) => onPress(event, edge)}
        onPointerMove={gesture.move}
        onPointerUp={gesture.end}
        pressed={false}
        style={
          edge === 'start'
            ? { left: `${shiftPx.start}px` }
            : { left: `calc(100% + ${shiftPx.end}px)` }
        }
        value={durationMs / 1000}
        valueText={`${what} ${seconds(durationMs)} 秒`}
      />
    ))

  const clipEdges = (clip: Layer0Clip, index: number): Edge[] => {
    if (!editable(clip)) return []
    const chosen = (at: number) => {
      const neighbor = draft.layer0[at]
      return neighbor !== undefined && selectedClips.includes(neighbor.id)
    }
    return [
      ...(chosen(index - 1) ? [] : (['start'] as const)),
      ...(chosen(index + 1) ? [] : (['end'] as const)),
    ]
  }

  const openPopover = (id: string, component: string) => {
    if (popovers.hasFields(component)) popovers.onOpen(id)
  }

  const liftPointer = (clip: Layer0Clip): PointerHandlers => ({
    onPointerDown: (event) => {
      if (event.button !== 0) return
      liftCancelledRef.current = false
      setCarry(null)
      setLanding(null)
      clicks.reset()
      event.currentTarget.setPointerCapture(event.pointerId)
      const box = event.currentTarget.getBoundingClientRect()
      const block = selectedClips.includes(clip.id)
        ? draft.layer0.filter((item) => selectedClips.includes(item.id))
        : [clip]
      const clipIds = block.map((item) => item.id)
      const from = draft.layer0.findIndex((item) => clipIds.includes(item.id))
      setLift({
        clipIds,
        from,
        durationMs: spanMs(block),
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        clientX: event.clientX,
        clientY: event.clientY,
        moved: false,
        origin: { left: box.left, top: box.top, width: box.width, height: box.height },
        to: from,
        returning: false,
      })
    },
    onPointerMove: (event) => {
      if (lift === null || lift.pointerId !== event.pointerId || lift.returning) return
      const far =
        Math.hypot(event.clientX - lift.originX, event.clientY - lift.originY) > DRAG_THRESHOLD
      if (!lift.moved && !far) return
      if (!lift.moved) popovers.onOpen(null)
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY }
      ghostRef.current?.follow(event.clientX, event.clientY)
      const next = liftTo({ ...lift, moved: true }, event.clientX, event.clientY)
      setLift(lift.moved && lift.to === next.to ? lift : next)
    },
    onPointerUp: (event) => {
      if (lift === null || lift.pointerId !== event.pointerId) return
      releasePointer(event)
      if (lift.returning || liftCancelledRef.current) return
      pointerRef.current = null
      if (!lift.moved) {
        setLift(null)
        return
      }
      clicks.swallow()
      const done = lift
      const result =
        done.to === undefined ? undefined : moveClips(draft, { clipIds: done.clipIds, to: done.to })
      if (result !== undefined && apply(result) && result.ok) {
        const placed = result.draft.layer0.find((item) => item.id === done.clipIds[0])
        if (placed === undefined) throw new Error('重排结果缺少被移动的片段')
        rememberLanding(placed.id, 'film')
        onSelect(clipSelection(done.clipIds))
        setLift({
          ...done,
          returning: true,
          destination: destinationOf(placed.start, done.durationMs, 'film') ?? done.origin,
        })
      } else setLift({ ...done, returning: true, destination: done.origin })
    },
    onPointerCancel: () => {
      liftCancelledRef.current = true
      pointerRef.current = null
      clicks.swallow()
      setLift((current) =>
        current === null ? null : { ...current, returning: true, destination: current.origin },
      )
    },
  })

  const musicMedia = draft.music === null ? undefined : context.music[draft.music.jobId]
  const shortfall = musicMedia === undefined ? 0 : musicShortfallMs(shown, context)

  const popoverOf = (id: string, label: string) => (
    <PopupRoot
      onOpenChange={(open) => popovers.onOpen(open ? id : null)}
      open={popovers.openId === id}
    >
      <PopupAnchor className="wf-pop-anchor" />
      <PopupSurface
        align="start"
        aria-label={label}
        className="wf-pop-surface"
        collisionPadding={16}
        side="top"
        sideOffset={8}
      >
        {popovers.openId === id ? popovers.render(id) : null}
      </PopupSurface>
    </PopupRoot>
  )

  const clipBody = (clip: Layer0Clip, named: Layer0Clip = clip) => {
    if (clip.type === 'component') {
      const face = componentFace(clip.component)
      const count =
        face.thumbnail === undefined ? 1 : Math.max(1, Math.round(msToPx(clip.duration, pps) / 48))
      return (
        <>
          <span className="wf-clip-label">组件</span>
          <span className="wf-clip-media">
            <span className="wf-clip-frames is-component">
              {Array.from({ length: count }, (_, at) => (
                <ComponentThumb face={face} key={at} />
              ))}
            </span>
            <span className="wf-clip-foot">{face.title}</span>
          </span>
        </>
      )
    }
    const url = urlOf(clip.sourceJobId)
    const part =
      url === undefined
        ? undefined
        : {
            mediaUrl: url,
            start: clip.playbackStart / 1000,
            end: (clip.playbackStart + clip.duration) / 1000,
          }
    return (
      <>
        <span className="wf-clip-label">{clipLabel(named.type === 'video' ? named : clip)}</span>
        {part === undefined ? (
          <span className="wf-clip-card">
            <span>素材读取中</span>
          </span>
        ) : (
          <span className="wf-clip-media">
            <span className="wf-clip-frames">
              <Frames part={part} />
            </span>
            <span className="wf-clip-wave">
              <Wave part={part} state={peaks.get(part.mediaUrl) ?? { kind: 'loading' }} />
            </span>
          </span>
        )}
      </>
    )
  }

  const hover = carry !== null && !carry.returning ? carry : null
  const insertClock = (index: number) => draft.layer0[index]?.start ?? layer0End(draft)
  const marker: { index: number; text: string; blocked: boolean } | undefined = (() => {
    if (lift !== null && lift.moved && !lift.returning && lift.to !== undefined) {
      const final = lift.to > lift.from ? lift.to - lift.clipIds.length : lift.to
      return { index: lift.to, text: `移到第 ${final + 1} 段`, blocked: false }
    }
    if (hover?.point?.lane !== 'film' || hover.attempt === undefined) return undefined
    const index = insertIndexAt(draft.layer0, hover.point.timeMs)
    return hover.attempt.ok
      ? {
          index,
          text: `插入到 ${seconds(insertClock(index))} 秒 · 第 ${index + 1} 段`,
          blocked: false,
        }
      : { index, text: hover.attempt.reason, blocked: true }
  })()
  const liftedClip =
    lift === null ? undefined : draft.layer0.find((clip) => clip.id === lift.clipIds[0])
  const liftResult =
    lift?.moved === true && !lift.returning && lift.to !== undefined
      ? moveClips(draft, { clipIds: lift.clipIds, to: lift.to })
      : undefined
  const projected =
    hover?.point?.lane === 'film' && hover.attempt?.ok === true
      ? hover.attempt.draft
      : liftResult?.ok === true
        ? liftResult.draft
        : shown
  const filmDrop =
    marker === undefined
      ? undefined
      : lift?.moved === true && !lift.returning
        ? projected.layer0.find((clip) => clip.id === lift.clipIds[0])
        : hover?.attempt?.ok === true
          ? projected.layer0.find((clip) => !draft.layer0.some((before) => before.id === clip.id))
          : undefined
  const liftFace = (clip: Layer0Clip, { clipIds, durationMs }: Lift): InsertionFace => {
    const more = clipIds.length > 1 ? ` 等 ${clipIds.length} 段` : ''
    if (clip.type === 'component') {
      const face = componentFace(clip.component)
      return { title: face.title + more, durationMs, media: <ComponentThumb face={face} /> }
    }
    const url = urlOf(clip.sourceJobId)
    return {
      title: clipLabel(clip) + more,
      durationMs,
      media:
        url === undefined ? (
          <Icon decorative name="video" size="sm" />
        ) : (
          <Frames
            part={{
              mediaUrl: url,
              start: clip.playbackStart / 1000,
              end: (clip.playbackStart + Math.min(500, clip.duration)) / 1000,
            }}
          />
        ),
    }
  }
  const insertionFace =
    carry?.payload.ghost?.face ??
    (liftedClip === undefined || lift === null ? undefined : liftFace(liftedClip, lift))
  const overlayDrop = (() => {
    if (hover?.point?.lane !== 'overlay' || hover.attempt === undefined) return undefined
    const placed = hover.attempt.ok
      ? hover.attempt.draft.overlays.find(
          (overlay) => !draft.overlays.some((before) => before.id === overlay.id),
        )
      : undefined
    return {
      start: placed?.start ?? hover.point.timeMs,
      duration: placed?.duration ?? hover.payload.durationMs,
      row: placed === undefined ? hover.point.overlayRow : { track: placed.track },
      reason: hover.attempt.ok ? undefined : hover.attempt.reason,
    }
  })()

  const rowTop = (row: OverlayRow) =>
    ROWS_TOP_PX + ('track' in row ? row.track : row.insertAt) * ROW_PX

  const moving = preview?.overlayId
  const overlaysShown = draft.overlays.map((overlay) => {
    if (overlay.id !== moving) {
      return newRow !== undefined && overlay.track >= newRow.insertAt
        ? { ...overlay, track: overlay.track + 1 }
        : overlay
    }
    const after = shown.overlays.find((o) => o.id === overlay.id)
    return after === undefined ? overlay : { ...overlay, start: after.start }
  })
  const trimmed = (overlay: OverlayClip) =>
    moving === undefined ? (shown.overlays.find((o) => o.id === overlay.id) ?? overlay) : overlay

  const guideMs = preview?.guideMs ?? hover?.point?.guideMs ?? null
  const markerLeft =
    marker === undefined ? 0 : msToPx(filmDrop?.start ?? insertClock(marker.index), pps)
  const alignAt = (left: number) => bubbleAlign(left, contentWidth)
  const tailLeft = msToPx(layer0End(shown), pps) + 8
  const showTail = marker === undefined && contentWidth - tailLeft > 300
  const cuts = cutsOf(shown)
  const insertionActive = hover !== null || (lift?.moved === true && !lift.returning)
  const overlayAnimating = insertionActive || moving !== undefined
  const projectedById = new Map(projected.layer0.map((clip) => [clip.id, clip]))
  const selectionRuns: { first: Layer0Clip; last: Layer0Clip }[] = []
  if (!insertionActive)
    shown.layer0.forEach((clip, index) => {
      if (!selectedClips.includes(clip.id)) return
      const run = selectionRuns.at(-1)
      if (run !== undefined && run.last === shown.layer0[index - 1]) run.last = clip
      else selectionRuns.push({ first: clip, last: clip })
    })
  const keptOf = (clip: Layer0Clip) =>
    layer0Trim?.clipId === clip.id
      ? { start: layer0Trim.kept.at, end: layer0Trim.kept.at + layer0Trim.kept.len }
      : { start: clip.start, end: clip.start + clip.duration }
  const drawnOf = (clip: Layer0Clip) => (layer0Trim?.clipId === clip.id ? layer0Trim.face : clip)
  const trimMark = ({ at, len }: { at: number; len: number }) => ({
    left: `${msToPx(at, pps)}px`,
    width: `${Math.max(0, msToPx(len, pps) - 2)}px`,
  })
  const previewWidth = Math.max(
    contentWidth,
    msToPx(layer0End(projected), pps),
    msToPx(layer0End(previewed), pps),
  )

  return (
    <div
      className={cn('wf-tracks', newRow !== undefined && 'is-adding-overlay-row')}
      style={
        {
          '--wf-overlay-rows': laneRows,
          '--wf-new-overlay-top': `${newRow === undefined ? 0 : rowTop(newRow)}px`,
          '--wf-overlay-label-top': `${newRow?.insertAt === 0 && rows > 0 ? ROW_PX : 0}px`,
        } as CSSProperties
      }
    >
      <div className="wf-track-heads">
        <span aria-hidden="true" className="wf-track-head is-film">
          <Icon decorative name="video" size="sm" />
          画面
        </span>
        <span aria-hidden="true" className="wf-track-head is-overlay">
          <span
            className={cn('wf-overlay-label', newRow !== undefined && rows === 0 && 'is-hidden')}
          >
            <Icon decorative name="layers" size="sm" />
            特效
          </span>
          <span className="wf-overlay-row-label">
            <Icon decorative name="add" size="xs" />
            新增特效轨
          </span>
        </span>
        <span className="wf-track-head is-caption">{captionControls}</span>
        <span className="wf-track-head">
          <Icon decorative name="music" size="sm" />
          <span aria-hidden="true">音乐</span>
          {musicAction}
        </span>
      </div>
      <div className="wf-track-scroll" ref={scrollRef}>
        <div className="wf-track-content" ref={contentRef} style={{ width: `${previewWidth}px` }}>
          <TimelineRuler
            buffered={buffered}
            clockAt={(clientX) => timeAt(clientX) / 1000}
            currentTime={playheadMs / 1000}
            onScrub={() => {}}
            onSeek={(clock) => onSeek(Math.round(clock * 1000))}
            scale={previewWidth / pps}
            total={total / 1000}
            viewportRef={scrollRef}
          />
          {beats.map((beat) => (
            <span
              aria-hidden="true"
              className="wf-beat"
              key={beat.timeMs}
              style={{ left: `${msToPx(beat.timeMs, pps)}px`, opacity: 0.3 + 0.7 * beat.strength }}
            />
          ))}
          <div
            className="wf-lanes"
            onPointerDown={(event) => {
              if (event.target !== event.currentTarget) return
              onSelect(null)
              onSeek(Math.min(timeAt(event.clientX), total))
            }}
          >
            <div
              aria-label="画面轨"
              className={cn('wf-lane is-film', layer0Trim !== undefined && 'is-trimming')}
              ref={filmLaneRef}
              role="group"
            >
              {shown.layer0.map((clip, index) => {
                const name = `第 ${index + 1} 段 · ${
                  clip.type === 'video'
                    ? clipLabel(clip)
                    : `组件 · ${componentFace(clip.component).title}`
                }，${seconds(clip.duration)} 秒`
                const kept = keptOf(clip)
                const drawn = drawnOf(clip)
                return (
                  <Block
                    className={cn(
                      'wf-clip',
                      clip.type === 'component' && 'is-card',
                      drawn !== clip && 'is-trimming',
                    )}
                    clipId={clip.id}
                    handles={
                      <>
                        {layer0Trim?.clipId !== clip.id || layer0Trim.cut === undefined ? null : (
                          <span
                            aria-hidden="true"
                            className="timeline-trim-cut wf-trim-mark"
                            data-testid="trim-cut"
                            style={trimMark({
                              at: layer0Trim.cut.at - drawn.start,
                              len: layer0Trim.cut.len,
                            })}
                          />
                        )}
                        {trimHandles(
                          clipEdges(clip, index),
                          kept.end - kept.start,
                          '该段',
                          (event, edge) => startTrim(event, clip, edge),
                          (edge, deltaMs) =>
                            trimClip(draft, { clipId: clip.id, edge, deltaMs }, context),
                          {
                            start: msToPx(kept.start - drawn.start, pps),
                            end: msToPx(kept.end - drawn.start - drawn.duration, pps),
                          },
                        )}
                      </>
                    }
                    key={clip.id}
                    name={name}
                    slide={`clip:${clip.id}`}
                    motion={{
                      driver: motion,
                      x: msToPx(
                        drawn === clip ? (projectedById.get(clip.id) ?? clip).start : drawn.start,
                        pps,
                      ),
                      width: Math.max(6, msToPx(drawn.duration, pps) - 2),
                      opacity:
                        lift?.clipIds.includes(clip.id) === true && lift.moved && !lift.returning
                          ? 0
                          : 1,
                      animate: insertionActive,
                      initial: landing?.id === clip.id ? landing.snapshot : undefined,
                    }}
                    onSelect={(event) => {
                      if (!clicks.take()) onClipClick(clip, event.shiftKey)
                    }}
                    pointer={liftPointer(clip)}
                    popover={
                      clip.type === 'component'
                        ? popoverOf(clip.id, `组件 · ${componentFace(clip.component).title}`)
                        : undefined
                    }
                    selected={selectedClips.includes(clip.id)}
                    shortcuts="Delete Alt+ArrowLeft Alt+ArrowRight"
                    style={place(drawn.start, drawn.duration)}
                  >
                    {clipBody(drawn, clip)}
                  </Block>
                )
              })}
              {selectionRuns.map(({ first, last }) => {
                const start = keptOf(first).start
                return (
                  <span
                    aria-hidden="true"
                    className="wf-selection-box"
                    data-slide={`selection:${first.id}`}
                    key={first.id}
                    style={place(start, keptOf(last).end - start)}
                  />
                )
              })}
              <InsertionPreview
                elementRef={filmPreviewRef}
                face={insertionFace}
                motion={motion}
                position={
                  marker === undefined || insertionFace === undefined
                    ? undefined
                    : {
                        x: markerLeft,
                        y: 2,
                        width: Math.max(6, msToPx(insertionFace.durationMs, pps) - 2),
                        height: 48,
                        blocked: marker.blocked,
                        text: marker.blocked
                          ? marker.text
                          : lift?.moved === true && !lift.returning
                            ? marker.text
                            : `插入 ${seconds(filmDrop?.start ?? insertClock(marker.index))} 秒 · ${seconds(insertionFace.durationMs)} 秒`,
                        alignEnd: alignAt(markerLeft) === 'is-end',
                      }
                }
              />
              {showTail ? (
                <span className="wf-lane-hint is-tail" style={{ left: `${tailLeft}px` }}>
                  <Icon decorative name="insert" size="xs" />
                  把镜头或特效拖到这里
                </span>
              ) : null}
            </div>
            <div
              aria-label="特效轨"
              className="wf-lane is-overlay"
              ref={overlayLaneRef}
              role="group"
            >
              {draft.overlays.length === 0 && overlayDrop === undefined ? (
                <span className="wf-lane-hint">把左侧的特效拖到这里</span>
              ) : null}
              <span aria-hidden="true" className="wf-overlay-row-preview">
                <span
                  hidden={
                    overlayDrop !== undefined &&
                    msToPx(overlayDrop.start + overlayDrop.duration, pps) > contentWidth - 170
                  }
                >
                  松开，新增一条特效轨
                </span>
              </span>
              {overlaysShown.map((overlay) => {
                const face = componentFace(overlay.component)
                const timed = trimmed(overlay)
                const isMoving = overlay.id === moving
                const top =
                  isMoving && preview?.row !== undefined
                    ? rowTop(preview.row)
                    : ROWS_TOP_PX + overlay.track * ROW_PX
                return (
                  <Block
                    className={cn('wf-overlay', isMoving && 'is-moving')}
                    motion={{
                      driver: motion,
                      x: msToPx(timed.start, pps),
                      y: top,
                      width: Math.max(6, msToPx(timed.duration, pps) - 2),
                      opacity: 1,
                      animate: overlayAnimating,
                      followX: isMoving,
                      initial: landing?.id === overlay.id ? landing.snapshot : undefined,
                    }}
                    handles={trimHandles(
                      knownComponent(overlay.component) ? ['start', 'end'] : [],
                      timed.duration,
                      '该段特效',
                      (event, edge) => startOverlayTrim(event, overlay, edge),
                      (edge, deltaMs) =>
                        trimOverlay(draft, { overlayId: overlay.id, edge, deltaMs }, context),
                    )}
                    key={overlay.id}
                    name={`特效 · ${face.title}，第 ${overlay.track + 1} 行，${seconds(timed.start)}–${seconds(timed.start + timed.duration)} 秒`}
                    onSelect={() => {
                      if (clicks.take()) return
                      onSelect({ kind: 'overlay', id: overlay.id })
                      openPopover(overlay.id, overlay.component)
                    }}
                    pointer={{
                      ...gestureFollow,
                      onPointerDown: (event) => startOverlayMove(event, overlay),
                    }}
                    popover={popoverOf(overlay.id, `特效 · ${face.title}`)}
                    selected={selectedOverlay === overlay.id}
                    shortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Delete"
                    style={{ ...place(timed.start, timed.duration), top: 0 }}
                  >
                    <OverlayFace face={face} />
                  </Block>
                )
              })}
              <InsertionPreview
                elementRef={overlayPreviewRef}
                face={insertionFace}
                motion={motion}
                position={
                  overlayDrop === undefined
                    ? undefined
                    : {
                        x: msToPx(overlayDrop.start, pps),
                        y: rowTop(overlayDrop.row),
                        width: Math.max(6, msToPx(overlayDrop.duration, pps) - 2),
                        height: 22,
                        blocked: overlayDrop.reason !== undefined,
                        text:
                          overlayDrop.reason ??
                          `${newRow === undefined ? '特效' : '新增特效轨'} · ${seconds(overlayDrop.start)}–${seconds(overlayDrop.start + overlayDrop.duration)} 秒${newRow === undefined ? '' : ' · 松开添加'}`,
                        alignEnd: alignAt(msToPx(overlayDrop.start, pps)) === 'is-end',
                      }
                }
              />
              {moving === undefined
                ? null
                : (() => {
                    const overlay = overlaysShown.find((o) => o.id === moving)
                    const row = preview?.row
                    if (overlay === undefined || row === undefined) return null
                    const note = preview?.note
                    return (
                      <span
                        className={cn(
                          'wf-time-bubble',
                          alignAt(msToPx(overlay.start, pps)) === 'is-end' && 'is-end',
                        )}
                        role="status"
                        style={{
                          left: `${msToPx(overlay.start, pps)}px`,
                          top: `${rowTop(row) - 3}px`,
                        }}
                      >
                        {note === undefined ? (
                          `${newRow === undefined ? '' : '新增特效轨 · '}${seconds(overlay.start)}–${seconds(overlay.start + overlay.duration)} 秒${newRow === undefined ? '' : ' · 松开添加'}`
                        ) : (
                          <>
                            <Icon decorative name="blocked" size="xs" />
                            {note}
                          </>
                        )}
                      </span>
                    )
                  })()}
            </div>
            <div
              aria-label="字幕轨"
              className={cn('wf-lane', draft.captions.hidden && 'is-captions-off')}
              role="group"
            >
              <CaptionChips
                captions={captions}
                onCommit={onCaptionText}
                place={place}
                selectedKey={selection?.kind === 'caption' ? selection.key : undefined}
                sentenceText={sentenceText}
              />
              {captionStatus}
            </div>
            <div aria-label="音乐轨" className="wf-lane is-music" ref={musicLaneRef} role="group">
              {shown.music !== null && music !== undefined ? (
                <Block
                  className="wf-music"
                  handles={null}
                  name={`音乐 · ${music.title}，从歌里 ${seconds(shown.music.offset)} 秒起`}
                  onSelect={() => {
                    if (!clicks.take()) onSelect({ kind: 'music' })
                  }}
                  pointer={{
                    ...gestureFollow,
                    onPointerDown: (event) => {
                      const current = draft.music
                      if (current === null || musicMedia === undefined) return
                      gesture.start(event, (deltaPx) => ({
                        result: setMusicOffset(
                          draft,
                          { offsetMs: current.offset - pxToMs(deltaPx, pps) },
                          context,
                        ),
                      }))
                    },
                  }}
                  selected={selection?.kind === 'music'}
                  style={place(0, Math.max(0, total - shortfall))}
                >
                  <span className="wf-music-name">
                    <Icon decorative name="music" size="xs" />
                    <b>{music.title}</b>
                  </span>
                  <Wave
                    part={{
                      mediaUrl: music.url,
                      start: shown.music.offset / 1000,
                      end: (shown.music.offset + total - shortfall) / 1000,
                    }}
                    state={music.peaks}
                  />
                  {beats
                    .filter((beat) => beat.timeMs <= total - shortfall)
                    .map((beat) => {
                      const hit = cuts.some(
                        (cut) => Math.abs(cut.timeMs - beat.timeMs) <= ON_BEAT_MS,
                      )
                      return (
                        <span
                          aria-hidden="true"
                          className={cn('wf-music-beat', hit && 'is-hit')}
                          key={beat.timeMs}
                          style={{
                            left: `${msToPx(beat.timeMs, pps)}px`,
                            opacity: hit ? 1 : 0.3 + 0.7 * beat.strength,
                          }}
                        />
                      )
                    })}
                </Block>
              ) : null}
              {shortfall > 0 ? (
                <span
                  className="wf-lane-hint is-end"
                  style={{ left: `${msToPx(total - shortfall, pps)}px` }}
                >
                  音乐比成片短 {seconds(shortfall)} 秒，不循环补齐
                </span>
              ) : null}
            </div>
          </div>
          {guideMs === null ? null : (
            <span
              aria-hidden="true"
              className="wf-snap-guide"
              style={{ left: `${msToPx(guideMs, pps)}px` }}
            />
          )}
          <TimelinePlayhead style={{ left: `${msToPx(Math.min(playheadMs, total), pps)}px` }} />
          {preview?.note !== undefined && preview.noteAtMs !== undefined ? (
            <LimitBubble
              left={`${msToPx(preview.noteAtMs, pps)}px`}
              text={preview.note}
              viewportRef={scrollRef}
            />
          ) : null}
        </div>
      </div>
      {insertionFace === undefined || (carry === null && lift?.moved !== true) ? null : (
        <InsertionGhost
          ref={ghostRef}
          face={insertionFace}
          motion={motion}
          blocked={carry !== null ? carry.attempt?.ok !== true : lift?.to === undefined}
          clientX={carry?.clientX ?? lift?.clientX ?? 0}
          clientY={carry?.clientY ?? lift?.clientY ?? 0}
          destination={
            carry !== null
              ? carry.returning
                ? carry.destination
                : undefined
              : lift?.returning === true
                ? lift.destination
                : undefined
          }
          onRest={() => {
            if (carry?.returning === true)
              setCarry((current) => (current === carry ? null : current))
            else if (lift?.returning === true)
              setLift((current) => (current === lift ? null : current))
          }}
        />
      )}
    </div>
  )
}

type CaptionChipsProps = {
  captions: readonly PlacedCaption[]
  place: (start: number, duration: number) => { left: string; width: string }
  selectedKey: string | undefined
  sentenceText: (caption: PlacedCaption) => string
  onCommit: (caption: PlacedCaption, text: string) => void
}

function CaptionChips({ captions, place, selectedKey, sentenceText, onCommit }: CaptionChipsProps) {
  const [editing, setEditing] = useState<string | null>(null)
  return captions.map((caption) => {
    const key = captionKey(caption)
    const style = place(caption.start, caption.end - caption.start)
    if (editing === key)
      return (
        <span className="wf-caption is-editing" key={key} style={style}>
          <CaptionInput
            initial={sentenceText(caption)}
            onDone={(text) => {
              setEditing(null)
              if (text !== undefined) onCommit(caption, text)
            }}
          />
        </span>
      )
    return (
      <button
        aria-label={`字幕：${caption.text}，点此改字`}
        className={cn('wf-caption ui-state ui-focus', key === selectedKey && 'is-selected')}
        key={key}
        onClick={() => setEditing(key)}
        style={style}
        title={caption.text}
        type="button"
      >
        {caption.text}
      </button>
    )
  })
}

function CaptionInput({
  initial,
  onDone,
}: {
  initial: string
  onDone: (text: string | undefined) => void
}) {
  const [text, setText] = useState(initial)
  const doneRef = useRef(false)
  const finish = (value: string | undefined) => {
    if (doneRef.current) return
    doneRef.current = true
    onDone(value)
  }
  return (
    <input
      aria-label="改这句字幕；清空回到识别结果"
      className="ui-focus"
      onBlur={() => finish(text)}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(text)
        if (event.key === 'Escape') {
          event.stopPropagation()
          finish(undefined)
        }
      }}
      ref={(element) => {
        if (element !== null && document.activeElement !== element) {
          element.focus()
          element.select()
        }
      }}
      value={text}
    />
  )
}
