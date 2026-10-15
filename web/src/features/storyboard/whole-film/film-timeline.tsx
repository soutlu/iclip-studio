/** 整片时间线：上方成片区（成片轨、字幕轨、音乐轨）按整片时间排；分隔行「素材」下面每条素材轨放一条成片，
 * 从 0 秒起、与成片区同一比例。音乐轨见 film-music-track。
 *
 * 素材轨上拖选任意一截（不按关键帧），按住选区拖到成片轨，松手处插入、后面的段顺延；键盘上选好后按回车，
 * 插到播放头所在的切点。成片轨上点段选中，拖两端掐头去尾，按住中间拖动换顺序。字幕跟着画面走，不能拖。 */

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
  type RefObject,
} from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Frames, Wave } from '../video-editor/editor-timeline'
import { roundSeconds, timeLabel } from '../video-editor/time-label'
import type { PeaksState } from '../video-editor/use-media-analysis'
import {
  fitsInFilm,
  insertClockOf,
  insertIndexAt,
  layoutFilm,
  MAX_FILM_SECONDS,
  MAX_FILM_SEGMENTS,
  MIN_SEGMENT_SECONDS,
  roundToMs,
  segmentDuration,
  trimBounds,
  type FilmSegment,
  type FilmBrand,
  type MaterialLane,
  type Pick,
} from './film-draft'
import { materialName, type Material, type MaterialDuration } from './film-materials'
import { VersionPill } from './film-menus'
import { internalCuts } from './film-music'
import { MusicTrack, type MusicTrackView } from './film-music-track'
import type { FilmSubtitle, FilmSubtitleStatus } from './film-subtitles'
import './film-timeline.css'

type Edge = 'start' | 'end'

/** 素材区的一条轨，连同它此刻用的那一版。 */
export type LaneView = {
  lane: MaterialLane
  label: string
  material: Material
  versions: readonly Material[]
  /** 这一版多长：还没读到或读不出来时轨上不画素材、不能挑段，只写一句状态。 */
  duration: MaterialDuration
}

/** 素材轨上的选区：哪一组的哪一版，取它的哪一截。 */
export type MaterialPick = Pick & { groupId: string }

/** 成片区里选中的东西：一段、字幕轨上的一条，或音乐。 */
export type FilmSelection =
  | { kind: 'segment'; id: string }
  | { kind: 'subtitle'; key: string }
  | { kind: 'music' }
  | { kind: 'brand'; position: 'intro' | 'outro' }
  | undefined

/** 时间线上下几行的位置，像素：标尺 18；成片轨 48、字幕轨 26、音乐轨 32，行间 4；分隔行 22；素材轨各 40，行间 4。 */
const ROW = {
  film: { top: 22, height: 48 },
  subtitles: { top: 74, height: 26 },
  music: { top: 104, height: 32 },
  separator: 140,
  materials: 166,
  lane: 40,
  laneGap: 4,
} as const
const laneTop = (index: number) => ROW.materials + index * (ROW.lane + ROW.laneGap)

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60]
/** 按下后挪过这么多像素才算拖动，不然是点。 */
const DRAG_THRESHOLD = 4
/** 键盘一步多少秒；按住 Shift 一步一秒。 */
const KEY_STEP = 0.1
/** 指针离成片轨上下多远以内松手也算放在成片轨上，像素。 */
const DROP_SLOP = 16
/** 携带素材靠近纵向视口边缘时滚动，让下面的素材能拖到上面的成片轨。 */
const SCROLL_EDGE = 40
const SCROLL_SPEED = 420
/** 气泡对准的时刻落在整条两头这么大的比例以内时，贴着那一头摆。 */
const BUBBLE_EDGE = 0.12

const seconds = (value: number) => `${value.toFixed(1)} 秒`

type FilmTimelineProps = {
  segments: readonly FilmSegment[]
  subtitles: readonly FilmSubtitle[]
  statuses: readonly FilmSubtitleStatus[]
  materialOf: (jobId: string) => Material | undefined
  lanes: readonly LaneView[]
  /** 整条宽度代表多少秒。 */
  scale: number
  /** 整片总长。 */
  total: number
  bodyTotal: number
  intro: FilmBrand | null | undefined
  outro: FilmBrand | null | undefined
  currentTime: number
  selection: FilmSelection
  pick: MaterialPick | undefined
  /** 正在提交识别的来源成片：按钮转圈、不能重复点。 */
  retrying: ReadonlySet<string>
  peaksOf: (url: string) => PeaksState
  durationOf: (material: Material) => MaterialDuration
  /** 选中的那一段或那一条字幕，弹出卡对准它。 */
  anchorRef: Ref<HTMLElement>
  scrollRef: RefObject<HTMLElement | null>
  /** 素材区末尾常驻的添加镜头组入口。 */
  addVideo: ReactNode
  onSeek: (clock: number) => void
  /** 开始拖动：播放头、手柄、段或选区。 */
  onScrub: () => void
  onSelect: (selection: FilmSelection) => void
  onTrim: (id: string, edge: Edge, value: number) => void
  onTrimPreview: (clock: number, edge: Edge) => void
  onMove: (id: string, before: number) => void
  onDelete: (id: string) => void
  onPick: (pick: MaterialPick | undefined) => void
  /** 素材预览：原片区间及要显示的原片时刻；右边界显示区间内侧。 */
  onPreviewMaterial: (pick: MaterialPick, clock: number, edge?: Edge) => void
  /** 把选区插在第 `index` 段之前。 */
  onInsert: (pick: MaterialPick, index: number) => void
  onRetry: (sourceJobId: string) => void
  onAddSubtitle: () => void
  /** 播放头处没有段时加不了字幕，这是原因。 */
  addSubtitleBlocked: string | undefined
  onSwitchVersion: (lane: LaneView, material: Material) => void
  /** 音乐轨此刻画什么。 */
  music: MusicTrackView
  /** 音乐轨轨道头上的「+」（上传或生成音乐）。 */
  musicAdd: ReactNode
  /** 人把音乐拖到整首的这一刻起。 */
  onMoveMusic: (start: number) => void
  onRemoveMusic: () => void
}

/** 按住素材选区往成片轨拖。 */
type Carry = {
  pointerId: number
  pick: MaterialPick
  originX: number
  originY: number
  clientX: number
  clientY: number
  /** 按下处离选区起点多少秒，浮起的那截跟着指针保持这个距离。 */
  grab: number
  clock: number
  /** 指针此刻在不在成片轨上。 */
  over: boolean
  moved: boolean
}

/** 在素材轨上框选。 */
type Sweep = { pointerId: number; groupId: string; jobId: string; anchor: number; clock: number }

/** 拖选区的一端。 */
type PickHandle = { pointerId: number; edge: Edge; value: number }

/** 成片轨上按住一段挪位置。 */
type Lift = {
  pointerId: number
  id: string
  originX: number
  grab: number
  clock: number
  moved: boolean
}

type Trim = { pointerId: number; id: string; edge: Edge; value: number }

/** 一截画面：缩略图在上、原声波形在下。 */
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

const capture = (event: PointerEvent<HTMLElement>) =>
  event.currentTarget.setPointerCapture(event.pointerId)
const release = (event: PointerEvent<HTMLElement>) => {
  if (event.currentTarget.hasPointerCapture(event.pointerId))
    event.currentTarget.releasePointerCapture(event.pointerId)
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
  scrollRef,
  addVideo,
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
  onAddSubtitle,
  addSubtitleBlocked,
  onSwitchVersion,
  music,
  musicAdd,
  onMoveMusic,
  onRemoveMusic,
}: FilmTimelineProps) {
  const lanesRef = useRef<HTMLDivElement>(null)
  const filmRowRef = useRef<HTMLDivElement>(null)
  const segmentButtonsRef = useRef(new Map<string, HTMLButtonElement>())
  // 拖完松手时浏览器还会补一个 click，那一下不算点选。
  const swallowClickRef = useRef(false)
  const [focusId, setFocusId] = useState<string>()
  const [carry, setCarry] = useState<Carry | null>(null)
  const [sweep, setSweep] = useState<Sweep | null>(null)
  const [pickHandle, setPickHandle] = useState<PickHandle | null>(null)
  const [lift, setLift] = useState<Lift | null>(null)
  const [trim, setTrim] = useState<Trim | null>(null)
  const [seekByPointer, setSeekByPointer] = useState(false)

  const bodyStart = (intro?.durationMs ?? 0) / 1000
  const reserved = bodyStart + (outro?.durationMs ?? 0) / 1000
  const layout = layoutFilm(segments).map((placed) => ({ ...placed, at: placed.at + bodyStart }))
  const carried = carry?.moved === true ? carry.pick : undefined
  const carriedDuration = carried === undefined ? 0 : segmentDuration(carried)
  const dropping = carry?.moved === true && carry.over
  const dropFits =
    carried !== undefined &&
    segments.length < MAX_FILM_SEGMENTS &&
    fitsInFilm(segments, carriedDuration, reserved)
  const dropIndex = dropping ? insertIndexAt(segments, carry.clock - bodyStart) : undefined
  const dropClock =
    dropIndex === undefined ? undefined : bodyStart + insertClockOf(segments, dropIndex)
  // 放得下时插入点之后的段先往后让出位置；比例跟着放宽，让出去的段不出界。
  const shift = dropping && dropFits && dropIndex !== undefined ? carriedDuration : 0
  const scale = Math.max(baseScale, total + shift)

  const percent = (time: number) => `${(time / scale) * 100}%`
  const span = (at: number, duration: number) => ({
    left: percent(at),
    width: `calc(${percent(duration)} - 2px)`,
  })
  /** 气泡对准某一刻：靠近两头时贴着那一头往里摆，不被轨道边缘裁掉。 */
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
  const overFilm = (clientY: number) => {
    const bounds = filmRowRef.current?.getBoundingClientRect()
    const viewport = scrollRef.current?.getBoundingClientRect()
    return (
      bounds !== undefined &&
      viewport !== undefined &&
      bounds.height > 0 &&
      bounds.bottom > viewport.top &&
      bounds.top < viewport.bottom &&
      clientY >= Math.max(viewport.top, bounds.top - DROP_SLOP) &&
      clientY <= Math.min(viewport.bottom, bounds.bottom + DROP_SLOP)
    )
  }

  const carrying = carry?.moved === true
  const scrollCarry = useEffectEvent((elapsed: number) => {
    const viewport = scrollRef.current
    if (viewport === null || carry === null) return
    const bounds = viewport.getBoundingClientRect()
    const { clientX, clientY } = carry
    if (
      clientX < bounds.left ||
      clientX > bounds.right ||
      clientY < bounds.top - SCROLL_EDGE ||
      clientY > bounds.bottom + SCROLL_EDGE
    )
      return
    const direction =
      clientY < bounds.top + SCROLL_EDGE ? -1 : clientY > bounds.bottom - SCROLL_EDGE ? 1 : 0
    if (direction !== 0)
      viewport.scrollTop = Math.max(
        0,
        Math.min(
          viewport.scrollHeight - viewport.clientHeight,
          viewport.scrollTop + (direction * SCROLL_SPEED * elapsed) / 1000,
        ),
      )
    // 滚动改变轨道的可见区域，即使指针没动也要按实时位置重新判断落点。
    const over = overFilm(clientY)
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

  /** 一截素材的画面与原声；来源不认识时什么也不画。 */
  const stripOf = (part: Pick) => {
    const material = materialOf(part.sourceJobId)
    return material === undefined ? null : (
      <Strip end={part.end} peaks={peaksOf(material.url)} start={part.start} url={material.url} />
    )
  }

  const selectedSegment = selection?.kind === 'segment' ? selection.id : undefined
  const selectedSubtitle = selection?.kind === 'subtitle' ? selection.key : undefined
  const tabStop =
    layout.find((placed) => placed.segment.id === focusId)?.segment.id ??
    selectedSegment ??
    layout[0]?.segment.id

  const focusSegment = (id: string) => {
    setFocusId(id)
    segmentButtonsRef.current.get(id)?.focus()
  }

  // ---------- 成片轨：点选、键盘、拖动换序 ----------

  const clickSegment = (id: string) => {
    if (swallowClickRef.current) {
      swallowClickRef.current = false
      return
    }
    setFocusId(id)
    onSelect(selectedSegment === id ? undefined : { kind: 'segment', id })
  }

  const keySegment = (event: KeyboardEvent<HTMLButtonElement>, index: number, id: string) => {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : undefined
    if (direction !== undefined && event.altKey) {
      // Alt + 左右：把这一段往前后挪一格。
      event.preventDefault()
      const before = direction < 0 ? index - 1 : index + 2
      if (before >= 0 && before <= segments.length) {
        onMove(id, before)
        requestAnimationFrame(() => focusSegment(id))
      }
      return
    }
    if (direction !== undefined) {
      event.preventDefault()
      const next = segments[index + direction]
      if (next === undefined) return
      onSelect({ kind: 'segment', id: next.id })
      focusSegment(next.id)
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      // 焦点所在的段删掉后落回对话框，键盘就断了：交给后面（没有就前面）那段。
      const neighbor = segments[index + 1]?.id ?? segments[index - 1]?.id
      onDelete(id)
      if (neighbor !== undefined) requestAnimationFrame(() => focusSegment(neighbor))
    }
  }

  const pressSegment = (event: PointerEvent<HTMLButtonElement>, at: number, id: string) => {
    swallowClickRef.current = false
    if (event.button !== 0) return
    onScrub()
    capture(event)
    const clock = clockAt(event.clientX)
    setLift({
      pointerId: event.pointerId,
      id,
      originX: event.clientX,
      grab: clock - at,
      clock,
      moved: false,
    })
  }

  const dragSegment = (event: PointerEvent<HTMLButtonElement>) => {
    if (lift === null || lift.pointerId !== event.pointerId) return
    const moved = lift.moved || Math.abs(event.clientX - lift.originX) > DRAG_THRESHOLD
    if (moved && !lift.moved) onScrub()
    setLift({ ...lift, clock: clockAt(event.clientX), moved })
  }

  const releaseSegment = (event: PointerEvent<HTMLButtonElement>) => {
    if (lift === null || lift.pointerId !== event.pointerId) return
    release(event)
    setLift(null)
    if (!lift.moved) return
    swallowClickRef.current = true
    onMove(lift.id, insertIndexAt(segments, lift.clock - bodyStart))
  }

  // ---------- 成片轨：裁剪 ----------

  const trimValue = (at: number, segment: FilmSegment, edge: Edge, clock: number) => {
    const { min, max } = trimBounds(segments, segment, edge, reserved)
    return Math.min(max, Math.max(min, segment.start + (clock - at)))
  }

  const pressTrim = (
    event: PointerEvent<HTMLButtonElement>,
    segment: FilmSegment,
    at: number,
    edge: Edge,
  ) => {
    event.preventDefault()
    event.currentTarget.focus()
    capture(event)
    onScrub()
    const value = segment[edge]
    setTrim({ pointerId: event.pointerId, id: segment.id, edge, value })
    onTrimPreview(at + (value - segment.start), edge)
  }

  const dragTrim = (event: PointerEvent<HTMLButtonElement>) => {
    if (trim === null || trim.pointerId !== event.pointerId) return
    const placed = layout.find((item) => item.segment.id === trim.id)
    if (placed === undefined) return
    const value = trimValue(placed.at, placed.segment, trim.edge, clockAt(event.clientX))
    setTrim({ ...trim, value })
    onTrimPreview(placed.at + (value - placed.segment.start), trim.edge)
  }

  const releaseTrim = (event: PointerEvent<HTMLButtonElement>) => {
    if (trim === null || trim.pointerId !== event.pointerId) return
    release(event)
    setTrim(null)
    onTrim(trim.id, trim.edge, trim.value)
  }

  const keyTrim = (
    event: KeyboardEvent<HTMLButtonElement>,
    segment: FilmSegment,
    at: number,
    edge: Edge,
  ) => {
    const step = event.shiftKey ? 1 : KEY_STEP
    const delta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : undefined
    if (delta === undefined) return
    event.preventDefault()
    const value = segment[edge] + delta
    onTrim(segment.id, edge, value)
    onTrimPreview(at + (value - segment.start), edge)
  }

  // ---------- 素材轨：框选、调两端、拖到成片轨 ----------

  const insertAtPlayhead = (current: MaterialPick) =>
    onInsert(current, insertIndexAt(segments, currentTime - bodyStart))

  const pressLane = (event: PointerEvent<HTMLDivElement>, view: LaneView) => {
    if (event.button !== 0 || view.duration == null) return
    const clock = Math.min(view.duration, clockAt(event.clientX))
    capture(event)
    event.currentTarget.focus()
    if (
      pick !== undefined &&
      pick.groupId === view.lane.groupId &&
      clock >= pick.start &&
      clock <= pick.end
    ) {
      onPreviewMaterial(pick, clock)
      setCarry({
        pointerId: event.pointerId,
        pick,
        originX: event.clientX,
        originY: event.clientY,
        clientX: event.clientX,
        clientY: event.clientY,
        grab: clock - pick.start,
        clock: clockAt(event.clientX),
        over: false,
        moved: false,
      })
      return
    }
    onPreviewMaterial(
      {
        groupId: view.lane.groupId,
        sourceJobId: view.material.jobId,
        start: 0,
        end: view.duration,
      },
      clock,
    )
    setSweep({
      pointerId: event.pointerId,
      groupId: view.lane.groupId,
      jobId: view.material.jobId,
      anchor: clock,
      clock,
    })
  }

  const dragLane = (event: PointerEvent<HTMLDivElement>, view: LaneView) => {
    if (sweep !== null && sweep.pointerId === event.pointerId && view.duration != null) {
      const clock = Math.min(view.duration, clockAt(event.clientX))
      if (sweep.clock === clock) return
      setSweep({ ...sweep, clock })
      const start = roundToMs(Math.min(sweep.anchor, clock))
      const end = roundToMs(Math.max(sweep.anchor, clock))
      onPreviewMaterial(
        {
          groupId: sweep.groupId,
          sourceJobId: sweep.jobId,
          start: end - start < MIN_SEGMENT_SECONDS ? 0 : start,
          end: end - start < MIN_SEGMENT_SECONDS ? view.duration : end,
        },
        clock,
        clock >= sweep.anchor ? 'end' : 'start',
      )
      return
    }
    if (carry === null || carry.pointerId !== event.pointerId) return
    const moved =
      carry.moved ||
      Math.hypot(event.clientX - carry.originX, event.clientY - carry.originY) > DRAG_THRESHOLD
    setCarry({
      ...carry,
      clientX: event.clientX,
      clientY: event.clientY,
      clock: clockAt(event.clientX),
      over: overFilm(event.clientY),
      moved,
    })
  }

  const releaseLane = (event: PointerEvent<HTMLDivElement>) => {
    release(event)
    if (sweep !== null && sweep.pointerId === event.pointerId) {
      setSweep(null)
      const start = roundToMs(Math.min(sweep.anchor, sweep.clock))
      const end = roundToMs(Math.max(sweep.anchor, sweep.clock))
      // 点一下没拖开（或拖得太短）：收起选区。
      onPick(
        end - start < MIN_SEGMENT_SECONDS
          ? undefined
          : { groupId: sweep.groupId, sourceJobId: sweep.jobId, start, end },
      )
      return
    }
    if (carry === null || carry.pointerId !== event.pointerId) return
    setCarry(null)
    if (!carry.moved || !overFilm(event.clientY)) return
    onInsert(carry.pick, insertIndexAt(segments, clockAt(event.clientX) - bodyStart))
  }

  const keyLane = (event: KeyboardEvent<HTMLDivElement>, view: LaneView) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    if (view.duration == null) return
    if (pick !== undefined && pick.groupId === view.lane.groupId) {
      insertAtPlayhead(pick)
      return
    }
    const next = {
      groupId: view.lane.groupId,
      sourceJobId: view.material.jobId,
      start: 0,
      end: roundToMs(view.duration),
    }
    onPick(next)
    onPreviewMaterial(next, 0, 'start')
  }

  const pickBounds = (view: LaneView, edge: Edge) =>
    pick === undefined || view.duration == null
      ? { min: 0, max: 0 }
      : edge === 'start'
        ? { min: 0, max: roundToMs(pick.end - MIN_SEGMENT_SECONDS) }
        : { min: roundToMs(pick.start + MIN_SEGMENT_SECONDS), max: roundToMs(view.duration) }

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
    capture(event)
    onPreviewMaterial(pick, pick[edge], edge)
    setPickHandle({ pointerId: event.pointerId, edge, value: pick[edge] })
  }

  const dragPickHandle = (event: PointerEvent<HTMLButtonElement>, view: LaneView) => {
    if (pickHandle === null || pickHandle.pointerId !== event.pointerId) return
    const { min, max } = pickBounds(view, pickHandle.edge)
    const value = roundToMs(Math.min(max, Math.max(min, clockAt(event.clientX))))
    setPickHandle({
      ...pickHandle,
      value,
    })
    if (pick !== undefined)
      onPreviewMaterial({ ...pick, [pickHandle.edge]: value }, value, pickHandle.edge)
  }

  const releasePickHandle = (event: PointerEvent<HTMLButtonElement>, view: LaneView) => {
    if (pickHandle === null || pickHandle.pointerId !== event.pointerId) return
    release(event)
    setPickHandle(null)
    setPickEdge(view, pickHandle.edge, pickHandle.value)
  }

  const keyPickHandle = (event: KeyboardEvent<HTMLButtonElement>, view: LaneView, edge: Edge) => {
    if (pick === undefined) return
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      insertAtPlayhead(pick)
      return
    }
    const step = event.shiftKey ? 1 : KEY_STEP
    const delta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : undefined
    if (delta === undefined) return
    event.preventDefault()
    setPickEdge(view, edge, pick[edge] + delta)
  }

  // ---------- 刻度 ----------

  const tickStep = TICK_STEPS.find((step) => step >= scale / 8) ?? Math.ceil(scale / 8 / 60) * 60
  const ticks = Array.from({ length: Math.floor(scale / tickStep) + 1 }, (_, at) => at * tickStep)
  const boundedTime = Math.max(0, Math.min(total, currentTime))

  // ---------- 拖动中的画法 ----------

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
    lift?.moved === true ? layout.find((item) => item.segment.id === lift.id) : undefined
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

  const sweepRange =
    sweep === null
      ? undefined
      : {
          groupId: sweep.groupId,
          start: Math.min(sweep.anchor, sweep.clock),
          end: Math.max(sweep.anchor, sweep.clock),
        }
  const shownPick = (groupId: string) => {
    if (sweepRange !== undefined) return sweepRange.groupId === groupId ? sweepRange : undefined
    if (pick === undefined || pick.groupId !== groupId) return undefined
    return pickHandle === null ? pick : { ...pick, [pickHandle.edge]: pickHandle.value }
  }

  const statusOf = (status: FilmSubtitleStatus) => {
    // 已恢复的画面字幕仍可编辑；口播识别状态贴在对应视频段上，不盖住字幕轨。
    const overSnapshot = subtitles.some(
      (item) => item.kind === 'snapshot' && item.segmentId === status.segmentId,
    )
    const className = cn('film-subtitle-status', overSnapshot && 'is-over-snapshot')
    const style = {
      ...span(
        shifted(
          segments.findIndex((item) => item.id === status.segmentId),
          status.at,
        ),
        status.end - status.at,
      ),
      top: overSnapshot ? ROW.film.top + 3 : ROW.subtitles.top + 2,
      height: overSnapshot ? 18 : ROW.subtitles.height - 4,
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

  const rows = lanes.length + 1
  const height = laneTop(rows) - ROW.laneGap

  return (
    <section aria-label="整片时间线" className="film-timeline">
      <div className="film-timeline-heads" style={{ height }}>
        <span className="film-timeline-head" style={{ top: ROW.film.top, height: ROW.film.height }}>
          <Icon decorative name="video" size="xs" />
          成片
        </span>
        <span
          className="film-timeline-head"
          style={{ top: ROW.subtitles.top, height: ROW.subtitles.height }}
        >
          <Icon decorative name="captions" size="xs" />
          字幕
          <button
            aria-disabled={addSubtitleBlocked === undefined ? undefined : true}
            aria-label="在播放头处添加字幕"
            className="film-timeline-head-add ui-state ui-focus"
            onClick={() => {
              if (addSubtitleBlocked === undefined) onAddSubtitle()
            }}
            title={addSubtitleBlocked ?? '在播放头处添加一条字幕'}
            type="button"
          >
            <Icon decorative name="add" size="xs" />
          </button>
        </span>
        <span
          className="film-timeline-head"
          style={{ top: ROW.music.top, height: ROW.music.height }}
        >
          <Icon decorative name="music" size="xs" />
          音乐
          {musicAdd}
        </span>
        {lanes.map((view, index) => (
          <span
            className="film-timeline-head"
            key={view.lane.groupId}
            style={{ top: laneTop(index), height: ROW.lane }}
          >
            <b title={view.label}>{view.label}</b>
            <VersionPill
              current={view.material}
              durationOf={durationOf}
              groupLabel={view.label}
              onSwitch={(material) => onSwitchVersion(view, material)}
              versions={view.versions}
            />
          </span>
        ))}
      </div>

      <div aria-label="时间线轨道，窄屏可横向滚动" className="film-timeline-scroll" role="region">
        <div
          className="film-timeline-lanes"
          data-testid="film-lanes"
          ref={lanesRef}
          style={{ height }}
        >
          <div className="film-timeline-ruler">
            {ticks.map((time) => (
              <span
                aria-hidden="true"
                className={cn(
                  'film-timeline-tick',
                  time === 0 && 'is-first',
                  time + tickStep > scale && time > 0 && 'is-last',
                )}
                key={time}
                style={{ left: percent(time) }}
              >
                {roundSeconds(time)}s
              </span>
            ))}
            <input
              aria-label="时间线播放位置"
              aria-valuetext={timeLabel(boundedTime)}
              className="film-timeline-seek"
              data-pointer={seekByPointer ? '' : undefined}
              disabled={total === 0}
              max={scale}
              min={0}
              onBlur={() => setSeekByPointer(false)}
              onChange={(event) => {
                onScrub()
                onSeek(Math.min(total, Number(event.target.value)))
              }}
              onKeyDown={() => setSeekByPointer(false)}
              onPointerDown={() => setSeekByPointer(true)}
              step={0.01}
              type="range"
              value={boundedTime}
            />
          </div>

          {/* 成片轨 */}
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
              从下方素材轨拖选片段放到这里
            </span>
          ) : null}
          {(['intro', 'outro'] as const).map((position) => {
            const template = position === 'intro' ? intro : outro
            if (template == null) return null
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
                onFocus={() => setFocusId(segment.id)}
                onKeyDown={(event) => keySegment(event, index, segment.id)}
                onPointerCancel={releaseSegment}
                onPointerDown={(event) => pressSegment(event, at, segment.id)}
                onPointerMove={dragSegment}
                onPointerUp={releaseSegment}
                ref={(element) => {
                  if (element === null) segmentButtonsRef.current.delete(segment.id)
                  else segmentButtonsRef.current.set(segment.id, element)
                }}
                style={{
                  ...span(shifted(index, at), duration),
                  top: ROW.film.top + 2,
                  height: ROW.film.height - 4,
                }}
                tabIndex={segment.id === tabStop ? 0 : -1}
                type="button"
              >
                {stripOf(segment)}
                {material === undefined ? null : (
                  <span className="film-segment-tag">{material.version}</span>
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

          {/* 字幕轨 */}
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
                className={cn('film-subtitle ui-focus', item.text.trim() === '' && 'is-empty')}
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
          {statuses.map(statusOf)}

          {/* 音乐轨 */}
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

          {/* 成片轨的选中框、手柄与拖动 */}
          {box === undefined ? null : (
            <span
              aria-hidden="true"
              className="film-timeline-box"
              ref={anchorRef}
              style={{
                left: `calc(${percent(box.from)} - 3px)`,
                width: `calc(${percent(box.to - box.from)} + 4px)`,
                top: ROW.film.top - 1,
                height: ROW.film.height + 2,
              }}
            />
          )}
          {handleOwner === undefined
            ? null
            : (['start', 'end'] as const).map((edge) => {
                const { segment, at } = handleOwner
                const value = trim !== null && trim.edge === edge ? trim.value : segment[edge]
                const bounds = trimBounds(segments, segment, edge, reserved)
                return (
                  <button
                    aria-label={edge === 'start' ? '裁剪该段开头' : '裁剪该段结尾'}
                    aria-valuemax={roundSeconds(bounds.max)}
                    aria-valuemin={roundSeconds(bounds.min)}
                    aria-valuenow={roundSeconds(value)}
                    aria-valuetext={`素材 ${roundSeconds(value)} 秒`}
                    className={cn(
                      'film-timeline-handle ui-focus',
                      `is-${edge}`,
                      trim?.edge === edge && 'is-pressed',
                    )}
                    key={edge}
                    onKeyDown={(event) => keyTrim(event, segment, at, edge)}
                    onPointerCancel={releaseTrim}
                    onPointerDown={(event) => pressTrim(event, segment, at, edge)}
                    onPointerMove={dragTrim}
                    onPointerUp={releaseTrim}
                    role="slider"
                    style={{
                      left: percent(at + (value - segment.start)),
                      top: ROW.film.top - 1,
                      height: ROW.film.height + 2,
                    }}
                    title="拖动可裁剪，按方向键可微调，按住 Shift 每次调整 1 秒"
                    type="button"
                  />
                )
              })}
          {trimmed === undefined ? null : (
            <span
              className="film-timeline-bubble"
              role="status"
              style={bubbleAt(trim?.edge === 'start' ? trimmed.from : trimmed.to)}
            >
              裁剪后 {(trimmed.to - trimmed.from).toFixed(1)} 秒 ·{' '}
              {trimmed.shorter >= 0
                ? `缩短 ${trimmed.shorter.toFixed(1)} 秒`
                : `延长 ${(-trimmed.shorter).toFixed(1)} 秒`}
            </span>
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

          {/* 从素材轨拖来的选区 */}
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
                  <span
                    className="film-timeline-bubble is-top"
                    role="status"
                    style={bubbleAt(dropClock)}
                  >
                    <Icon decorative name={dropFits ? 'insert' : 'blocked'} size="xs" />
                    {dropFits
                      ? `插入到 ${dropClock.toFixed(2)} 秒`
                      : segments.length >= MAX_FILM_SEGMENTS
                        ? `片段最多 ${MAX_FILM_SEGMENTS} 段，无法继续插入`
                        : `整片含片头片尾最长 ${MAX_FILM_SECONDS} 秒，放不下这 ${carriedDuration.toFixed(1)} 秒`}
                  </span>
                </>
              ) : null}
              <span
                aria-hidden="true"
                className="film-timeline-ghost"
                style={{
                  ...span(
                    Math.min(
                      Math.max(0, carry.clock - carry.grab),
                      Math.max(0, scale - carriedDuration),
                    ),
                    carriedDuration,
                  ),
                  top: dropping
                    ? ROW.film.top - 4
                    : laneTop(
                        Math.max(
                          0,
                          lanes.findIndex((view) => view.lane.groupId === carried.groupId),
                        ),
                      ) - 6,
                  height: dropping ? ROW.film.height - 4 : ROW.lane - 8,
                }}
              >
                {stripOf(carried)}
              </span>
            </>
          )}

          <span
            aria-hidden="true"
            className="film-timeline-playhead"
            style={{
              left: percent(boundedTime),
              top: ROW.film.top - 4,
              height: ROW.music.top + ROW.music.height - ROW.film.top + 4,
            }}
          />

          {/* 素材区 */}
          {lanes.map((view, index) => {
            const top = laneTop(index)
            const shown = shownPick(view.lane.groupId)
            const used = segments.filter((segment) => segment.sourceJobId === view.material.jobId)
            const hintId = `film-lane-hint-${view.lane.groupId}`
            return (
              <div key={view.lane.groupId}>
                <div
                  aria-describedby={hintId}
                  aria-label={`${view.label} · ${view.material.version} 素材${view.duration == null ? '' : `，共 ${seconds(view.duration)}`}`}
                  className="film-material-lane ui-focus"
                  onKeyDown={(event) => keyLane(event, view)}
                  onPointerCancel={releaseLane}
                  onPointerDown={(event) => pressLane(event, view)}
                  onPointerMove={(event) => dragLane(event, view)}
                  onPointerUp={releaseLane}
                  role="button"
                  style={{ top, height: ROW.lane }}
                  tabIndex={0}
                >
                  <span className="sr-only" id={hintId}>
                    按回车选中整条素材；选好后再按回车，插入到播放头所在的位置
                  </span>
                  {view.duration === undefined ? (
                    <span className="film-material-loading" role="status">
                      正在读取视频时长…
                    </span>
                  ) : view.duration === null ? (
                    <span className="film-material-loading" role="alert">
                      视频时长读取失败，无法从这条素材挑段；请换一个版本
                    </span>
                  ) : (
                    <span
                      className="film-material-clip"
                      style={{ width: `calc(${percent(view.duration)} - 2px)` }}
                    >
                      <Strip
                        end={view.duration}
                        peaks={peaksOf(view.material.url)}
                        start={0}
                        url={view.material.url}
                      />
                      <span className="film-material-length">{seconds(view.duration)}</span>
                    </span>
                  )}
                  {used.map((segment) => (
                    <span
                      aria-hidden="true"
                      className="film-material-used"
                      key={segment.id}
                      style={{
                        left: `calc(${percent(segment.start)} + 1px)`,
                        width: `max(3px, calc(${percent(segment.end - segment.start)} - 2px))`,
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
                        left: `calc(${percent(shown.start)} - 1px)`,
                        width: `calc(${percent(shown.end - shown.start)} + 2px)`,
                        top: top + 1,
                        height: ROW.lane - 2,
                      }}
                    />
                    {sweep !== null || carry?.moved === true ? null : (
                      <>
                        {(['start', 'end'] as const).map((edge) => {
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
                                pickHandle?.edge === edge && 'is-pressed',
                              )}
                              key={edge}
                              onKeyDown={(event) => keyPickHandle(event, view, edge)}
                              onPointerCancel={(event) => releasePickHandle(event, view)}
                              onPointerDown={(event) => pressPickHandle(event, edge)}
                              onPointerMove={(event) => dragPickHandle(event, view)}
                              onPointerUp={(event) => releasePickHandle(event, view)}
                              role="slider"
                              style={{ left: percent(value), top: top + 9, height: ROW.lane - 18 }}
                              title="拖动可调整选区，按方向键可微调，按回车插入到播放头处"
                              type="button"
                            />
                          )
                        })}
                      </>
                    )}
                    <span
                      className="film-timeline-bubble"
                      style={{ ...bubbleAt((shown.start + shown.end) / 2), top: top - 22 }}
                    >
                      素材 {shown.start.toFixed(2)}–{shown.end.toFixed(2)} 秒 ·{' '}
                      {seconds(shown.end - shown.start)}
                    </span>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="film-timeline-separator" style={{ top: ROW.separator }}>
        <b>素材</b>
        <i />
        <span>拖选一段，拖到上面的成片轨</span>
      </div>
      <div className="film-timeline-materials-add" style={{ top: laneTop(lanes.length) }}>
        {addVideo}
      </div>
    </section>
  )
}
