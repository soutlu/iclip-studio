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
import { cn } from '@/shared/lib/utils'
import { useEscapeAheadOfDialog } from '@/shared/ui/dialog'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import type { PeaksState } from '../editing/media-analysis'
import { Frames, TimelinePlayhead, TimelineRuler, TrimHandle, Wave } from '../editing/timeline'
import {
  arrowStep,
  DRAG_THRESHOLD,
  releasePointer,
  useClickAfterDrag,
} from '../editing/timeline-drag'
import { captionKey } from './canvas-targets'
import type { TrackLane } from './component-placement'
import type { PlacedCaption } from './composition/captions'
import type { EditContext, MusicBeat } from './editing/context'
import {
  MAX_FILM_MS,
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
import {
  InsertionGhost,
  InsertionPreview,
  type InsertionBox,
  type InsertionFace,
  type InsertionGhostHandle,
  type InsertionPreviewHandle,
  type InsertionMotion,
} from './timeline-insertion'
import { useInsertionMotion, type MotionSnapshot } from './use-insertion-motion'
import { usePreviewGesture, type GestureStep } from './use-preview-gesture'

export type MusicView = { url: string; title: string; peaks: PeaksState }

/** 组件在轨道上的样子：中文名，与组件栏卡片同一张缩略图（没有时用分类图标） */
export type ComponentFace = { title: string; thumbnail: string | undefined; icon: IconName }

/**
 * 指针落在时间线的哪一处：哪条轨的哪个时刻（毫秒），以及在特效轨上对应哪一行。拖到特效轨的东西
 * 带着长度时，时刻是两端吸附后的开始时间，`guideMs` 是吸附线。
 */
export type DropPoint = {
  timeMs: number
  lane: TrackLane
  overlayRow: OverlayRow
  guideMs: number | null
}

/** 落在某处会怎样：放得下时是放进去之后的草稿，放不下时是原因 */
export type Attempt = { ok: true; draft: WholeFilmDraft } | { ok: false; reason: string }

/** 从素材区、组件栏拖到时间线的东西 */
export type CarryPayload = {
  durationMs: number
  /** 三种来源使用相同的缩略图、名称与时长卡片。 */
  ghost?: { face: InsertionFace; origin: InsertionBox } | undefined
  /** 落在这一处会怎样；这条轨不收它时为 undefined（不提示） */
  attempt: (point: DropPoint) => Attempt | undefined
  /** 松手落在这一处：真的放进去，返回放进去了没有 */
  drop: (point: DropPoint) => boolean
}

/** 时间线给拖东西过来的一方用的接口 */
export type TracksHandle = {
  /** 带着东西移到这里：预览完整占位和相邻片段让位，松手前不写草稿 */
  carry: (clientX: number, clientY: number, payload: CarryPayload) => void
  /** 在这里松手：落在能接收的轨上就放进去；没放进去时缩影退回拿起的地方 */
  release: (clientX: number, clientY: number, payload: CarryPayload) => boolean
  cancel: () => void
  /** 把焦点放回某一段（键盘挪动之后） */
  focusClip: (clipId: string) => void
}

/** 组件段与特效块的浮层：开着的是哪一个、怎么画它的内容；组件没有可填项时点开不弹 */
export type ComponentPopovers = {
  openId: string | null
  onOpen: (id: string | null) => void
  render: (id: string) => ReactNode
  /** 这个组件有没有可填项（组件库里没有的组件也弹，好说明原因并移除） */
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
  /** 点画面轨上的一段（extend：按着 Shift）：选中它或扩选、去掉一端，播放头停在选区开头 */
  onClipClick: (clip: Layer0Clip, extend: boolean) => void
  snap: boolean
  /** 拍点（成片时间） */
  beats: readonly MusicBeat[]
  clipLabel: (clip: VideoClip) => string
  componentFace: (name: string) => ComponentFace
  urlOf: (sourceJobId: string) => string | undefined
  peaks: ReadonlyMap<string, PeaksState>
  music: MusicView | undefined
  apply: (result: EditResult) => boolean
  onViewportWidth: (width: number) => void
  tracksRef: RefObject<TracksHandle | null>
  popovers: ComponentPopovers
  /** 放进成片的字幕（每段画面里的一份句子） */
  captions: readonly PlacedCaption[]
  /** 改字时输入框里的整句：改过的字或识别结果 */
  sentenceText: (caption: PlacedCaption) => string
  onCaptionText: (caption: PlacedCaption, text: string) => void
  /** 字幕轨标题：样式选择与手动识别入口 */
  captionControls: ReactNode
  /** 识别进度、空结果或失败说明；不替换已经显示的字幕 */
  captionStatus: ReactNode
  /** 音乐轨轨名旁的按钮（生成音乐的「+」） */
  musicAction: ReactNode
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

/** 时间区左右让出的宽度：左 8 像素（播放头的头完整露出）、右 16 像素，与 whole-film.css 一致 */
const INSET_START_PX = 8
const INSET_END_PX = 16
/** 特效轨每行 24 像素（块高 22、行距 2），第一行上面留 2 像素，与 whole-film.css 一致 */
const ROW_PX = 24
const ROWS_TOP_PX = 2
/** 在所有行上方、下方这么近的地方松手就新开一行 */
const NEW_ROW_ABOVE_PX = 8
const NEW_ROW_BELOW_PX = 10
/** 画面轨上方这么近也算拖到了画面轨上 */
const DROP_SLOP_PX = 16
/** 相邻轨之间的空隙里，离哪条轨这么近就算那条轨 */
const LANE_SLOP_PX = 4
/** 带着东西靠近时间区左右边缘这么近就自动横向滚动，每秒滚这么多像素 */
const SCROLL_EDGE_PX = 40
const SCROLL_SPEED = 420
/** 拍点在切点前后这么近就算卡在拍上 */
const ON_BEAT_MS = 10

type Edge = 'start' | 'end'

/** 画面轨上连着的几段一共多长 */
const spanMs = (clips: readonly Layer0Clip[]) => clips.reduce((sum, clip) => sum + clip.duration, 0)

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

/** 按住画面轨上的段拖动排序：按住的是选中的段时拖整个选区，否则只拖这一段 */
type Lift = {
  /** 拖着的段，按画面轨先后 */
  clipIds: readonly string[]
  /** 拖着的第一段原来在第几段 */
  from: number
  /** 拖着的几段一共多长 */
  durationMs: number
  pointerId: number
  originX: number
  originY: number
  clientX: number
  clientY: number
  moved: boolean
  origin: InsertionBox
  /** 松手会插到第几段之前（按原来的顺序）；不在画面轨上为 undefined */
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
  /** 点开的浮层（组件块才有） */
  popover?: ReactNode
  clipId?: string
  shortcuts?: string
  motion?:
    | {
        driver: InsertionMotion
        x: number
        y?: number
        width: number
        opacity: number
        animate: boolean
        /** 横向拖动直接跟手，换行仍由动效驱动衔接。 */
        followX?: boolean
        initial?: MotionSnapshot | undefined
      }
    | undefined
  children: ReactNode
}

/** 轨道上的一块：整块是一个选中按钮（按住可拖），选中后在选区两端出现修剪手柄 */
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

/** 组件的缩略图；没有缩略图时是分类图标 */
function ComponentThumb({ face }: { face: ComponentFace }) {
  return face.thumbnail === undefined ? (
    <Icon decorative name={face.icon} size="xs" />
  ) : (
    <img alt="" draggable={false} src={face.thumbnail} />
  )
}

/** 特效块的样子：左边缩略图，右边名字 */
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
  const gesture = usePreviewGesture(apply)
  const shown = gesture.preview?.draft ?? draft
  const total = filmDuration(shown)
  const { pps, contentWidth } = scale
  const beatsMs = beats.map((beat) => beat.timeMs)
  const gridStep = rulerTickStep(contentWidth / Math.max(pps, 1))
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const filmLaneRef = useRef<HTMLDivElement>(null)
  const overlayLaneRef = useRef<HTMLDivElement>(null)
  const musicLaneRef = useRef<HTMLDivElement>(null)
  const clicks = useClickAfterDrag()
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
  // 拖动中指针最后在哪；靠近边缘时自动滚动用
  const pointerRef = useRef<{ clientX: number; clientY: number } | null>(null)
  const refreshRef = useRef<() => void>(() => {})

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

  // 命中使用已提交的行号；新增行只参与预演，松手前不写入草稿。
  const rows = overlayRowCount(draft.overlays)
  const carriedRow =
    carry !== null && !carry.returning && carry.point?.lane === 'overlay' && carry.attempt?.ok
      ? carry.point.overlayRow
      : undefined
  const previewRow = carriedRow ?? gesture.preview?.row
  const newRow = previewRow !== undefined && 'insertAt' in previewRow ? previewRow : undefined
  const laneRows = Math.max(1, rows + (newRow === undefined ? 0 : 1))

  /** 指针纵坐标落在特效轨的哪一行；在所有行之上、之下不远处就开一行；离得太远是 undefined */
  const overlayRowFrom = (
    clientY: number,
    activeRow = carriedRow,
    originTop = carry?.returning === false ? carry.overlayTop : undefined,
  ): OverlayRow | undefined => {
    const lane = overlayLaneRef.current?.getBoundingClientRect()
    if (lane === undefined) return undefined
    const expanding = activeRow !== undefined && 'insertAt' in activeRow && rows > 0
    // 时间线底部固定，新行向上让出空间；按展开后的几何命中，不取动画途中尚未让开的高度。
    const top = expanding
      ? lane.bottom - ((rows + 1) * ROW_PX + ROWS_TOP_PX)
      : (originTop ?? lane.top)
    let y = clientY - top - ROWS_TOP_PX
    if (expanding) {
      const previewTop = top + ROWS_TOP_PX + activeRow.insertAt * ROW_PX
      const edge = (originTop ?? lane.top) + ROWS_TOP_PX + activeRow.insertAt * ROW_PX
      // 展开时整条时间线可能上移。新行同时接住原来的边缘热区和已经展开的行，避免预览反复收开。
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

  /** 占位内保持当前插入点；跨过相邻片段中点才换位，避免让位动画反过来推动落点。 */
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

  /** 指针下是哪条轨的哪一刻；带着长度拖到特效轨时，开头、结尾吸附到切点、播放头、拍点、其他块边缘和刻度 */
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
  useEscapeAheadOfDialog(gesture.preview?.overlayId !== undefined, () => {
    clicks.swallow()
    gesture.cancel()
  })

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
        // 松手确认已经显示的落点，不能让预告导致的布局变化重新选择另一条轨。
        const point = carry !== null && !carry.returning ? carry.point : undefined
        const attempt = point === undefined ? undefined : payload.attempt(point)
        const dropped = point !== undefined && attempt !== undefined && payload.drop(point)
        let destination: InsertionBox | undefined
        if (dropped && attempt.ok && point.lane === 'film') {
          // 素材选了几个镜头时连着加入几段：缩影落到这几段一起占的位置
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
    refreshRef.current = () => {
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
    }
    return () => {
      tracksRef.current = null
    }
  })

  // 带着东西靠近时间区左右边缘：自动横向滚动，落点跟着重算
  const dragging = (carry !== null && !carry.returning) || (lift?.moved === true && !lift.returning)
  useEffect(() => {
    if (!dragging) return
    let frame = 0
    let last: number | undefined
    const tick = (now: number) => {
      const elapsed = last === undefined ? 16 : Math.min(32, now - last)
      last = now
      const pointer = pointerRef.current
      const viewport = scrollRef.current
      if (pointer !== null && viewport !== null) {
        const box = viewport.getBoundingClientRect()
        const inside =
          pointer.clientY >= box.top - DROP_SLOP_PX &&
          pointer.clientY <= box.bottom &&
          pointer.clientX >= box.left &&
          pointer.clientX <= box.right
        const direction = !inside
          ? 0
          : pointer.clientX < box.left + SCROLL_EDGE_PX
            ? -1
            : pointer.clientX > box.right - SCROLL_EDGE_PX
              ? 1
              : 0
        if (direction !== 0) {
          const before = viewport.scrollLeft
          viewport.scrollLeft += (direction * SCROLL_SPEED * elapsed) / 1000
          if (viewport.scrollLeft !== before) refreshRef.current()
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [dragging])

  const selectedOverlay = selection?.kind === 'overlay' ? selection.id : undefined
  const selectedClips = clipIdsOf(selection)
  const place = (start: number, duration: number) => ({
    left: `${msToPx(start, pps)}px`,
    width: `${Math.max(6, msToPx(duration, pps) - 2)}px`,
  })

  /** 组件库里有这个组件，知道它多长 */
  const knownComponent = (component: string) => context.components[component] !== undefined

  /** 修剪要知道视频段的素材、组件段的组件多长；组件库里没有的组件不能修剪 */
  const editable = (clip: Layer0Clip) =>
    clip.type === 'component'
      ? knownComponent(clip.component)
      : context.sources[clip.sourceJobId] !== undefined

  /** 按下之后交给拖动预览的那几个指针事件 */
  const gestureFollow: Omit<PointerHandlers, 'onPointerDown'> = {
    onPointerMove: gesture.move,
    onPointerUp: (event) => {
      if (gesture.end(event)) clicks.swallow()
    },
    onPointerCancel: gesture.cancel,
  }

  const startTrim = (event: PointerEvent<HTMLElement>, clip: Layer0Clip, edge: Edge) => {
    event.stopPropagation()
    clicks.reset()
    const edgeMs = edge === 'end' ? clip.start + clip.duration : clip.start
    // 吸附目标只取被拖段之前的边界（之后的边界随波纹一起动）、播放头与拍点
    const targets = snapTargets({
      spans: draft.layer0.slice(0, draft.layer0.indexOf(clip)),
      playheadMs,
      beatsMs,
    }).filter((target) => Math.round(target.time * 1000) !== edgeMs)
    gesture.start(event, (deltaPx): GestureStep => {
      const snapped = snapMs(edgeMs + pxToMs(deltaPx, pps), targets, pps, snap)
      const deltaMs = snapped.ms - edgeMs
      const result = trimClip(draft, { clipId: clip.id, edge, deltaMs }, context)
      const after = result.ok ? result.draft.layer0.find((c) => c.id === clip.id) : undefined
      if (!result.ok || after === undefined) return { result }
      const wanted = clip.duration + (edge === 'end' ? deltaMs : -deltaMs)
      const stopped = wanted > after.duration && layer0End(result.draft) >= MAX_FILM_MS
      return {
        result,
        guideMs: after.duration === wanted ? snapped.guideMs : null,
        note: stopped ? FILM_LIMIT_TEXT : undefined,
        noteAtMs: edge === 'end' ? after.start + after.duration : after.start,
      }
    })
  }

  const startOverlayTrim = (event: PointerEvent<HTMLElement>, overlay: OverlayClip, edge: Edge) => {
    event.stopPropagation()
    clicks.reset()
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

  /** 按住特效块中部拖：左右改时间（长度不变），上下换行；两端吸附到切点、播放头、拍点、其他块的边缘和刻度 */
  const startOverlayMove = (event: PointerEvent<HTMLElement>, overlay: OverlayClip) => {
    clicks.reset()
    const targets = snapTargets({
      spans: [...draft.layer0, ...draft.overlays.filter((o) => o.id !== overlay.id)],
      playheadMs,
      beatsMs,
    })
    // 指针离开特效轨时，仍去上一次指着的那一行
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
        // 拖过成片总长上限：停在放得下的地方并写明原因
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
        onPointerUp={(event) => {
          if (gesture.end(event)) clicks.swallow()
        }}
        pressed={false}
        style={edge === 'start' ? { left: 0 } : { left: '100%' }}
        value={durationMs / 1000}
        valueText={`${what} ${seconds(durationMs)} 秒`}
      />
    ))

  /**
   * 选中的段在选区两端的修剪手柄：前一段没选中的出开头的手柄，后一段没选中的出结尾的手柄，所以
   * 单选两端都有，多选只有第一段的开头与最后一段的结尾
   */
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

  /** 点选特效块：有可填项时弹出浮层 */
  const openPopover = (id: string, component: string) => {
    if (popovers.hasFields(component)) popovers.onOpen(id)
  }

  // ---- 画面轨上的段拖动排序：保留捕获指针的节点，预演位置，松手才提交 ----
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

  /** 组件段、特效块的浮层：锚在块上，向上弹 */
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

  /** 画面轨上的段里画的东西：视频段上面是画面、下面是原声；组件段上面是组件的画面、下面写组件名 */
  const clipBody = (clip: Layer0Clip) => {
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
        <span className="wf-clip-label">{clipLabel(clip)}</span>
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

  // ---- 插入预演只影响块的位置；播放、字幕与草稿仍使用已提交的数据 ----
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
  /** 拖着的段手上的缩影：第一段的画面与名字，拖着几段时名字后注明段数，时长是几段一共的 */
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

  /** 新行占用完整行高；已有行在预演中让出空间，取消后由同一动效驱动收回。 */
  const rowTop = (row: OverlayRow) =>
    ROWS_TOP_PX + ('track' in row ? row.track : row.insertAt) * ROW_PX

  const moving = gesture.preview?.overlayId
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

  const guideMs = gesture.preview?.guideMs ?? hover?.point?.guideMs ?? null
  const markerLeft =
    marker === undefined ? 0 : msToPx(filmDrop?.start ?? insertClock(marker.index), pps)
  const bubbleAlign = (left: number) =>
    left < 120 ? 'is-start' : left > contentWidth - 120 ? 'is-end' : undefined
  const tailLeft = msToPx(layer0End(shown), pps) + 8
  const showTail = marker === undefined && contentWidth - tailLeft > 300
  const cuts = cutsOf(shown)
  const insertionActive = hover !== null || (lift?.moved === true && !lift.returning)
  const overlayAnimating = insertionActive || moving !== undefined
  const projectedById = new Map(projected.layer0.map((clip) => [clip.id, clip]))
  // 画面轨的选区外框：选中的段每连着的一串画一个；拖着东西预演时不画
  const selectionRuns: { first: Layer0Clip; last: Layer0Clip }[] = []
  if (!insertionActive)
    shown.layer0.forEach((clip, index) => {
      if (!selectedClips.includes(clip.id)) return
      const run = selectionRuns.at(-1)
      if (run !== undefined && run.last === shown.layer0[index - 1]) run.last = clip
      else selectionRuns.push({ first: clip, last: clip })
    })
  const previewWidth = Math.max(contentWidth, msToPx(layer0End(projected), pps))

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
            clockAt={(clientX) => timeAt(clientX) / 1000}
            currentTime={playheadMs / 1000}
            onScrub={() => {}}
            onSeek={(clock) => onSeek(Math.round(clock * 1000))}
            scale={previewWidth / pps}
            total={total / 1000}
            viewportRef={scrollRef}
          />
          {/* 拍点刻度：透明度随拍点强度连续变化 */}
          {beats.map((beat) => (
            <span
              aria-hidden="true"
              className="wf-beat"
              key={beat.timeMs}
              style={{ left: `${msToPx(beat.timeMs, pps)}px`, opacity: 0.3 + 0.7 * beat.strength }}
            />
          ))}
          {/* 点轨道空处：取消选中、播放头跳过去（轨道本身不接指针，空处的点按落在这一层） */}
          <div
            className="wf-lanes"
            onPointerDown={(event) => {
              if (event.target !== event.currentTarget) return
              onSelect(null)
              onSeek(Math.min(timeAt(event.clientX), total))
            }}
          >
            <div aria-label="画面轨" className="wf-lane is-film" ref={filmLaneRef} role="group">
              {shown.layer0.map((clip, index) => {
                const name = `第 ${index + 1} 段 · ${
                  clip.type === 'video'
                    ? clipLabel(clip)
                    : `组件 · ${componentFace(clip.component).title}`
                }，${seconds(clip.duration)} 秒`
                return (
                  <Block
                    className={cn('wf-clip', clip.type === 'component' && 'is-card')}
                    clipId={clip.id}
                    handles={trimHandles(
                      clipEdges(clip, index),
                      clip.duration,
                      '该段',
                      (event, edge) => startTrim(event, clip, edge),
                      (edge, deltaMs) =>
                        trimClip(draft, { clipId: clip.id, edge, deltaMs }, context),
                    )}
                    key={clip.id}
                    name={name}
                    motion={{
                      driver: motion,
                      x: msToPx((projectedById.get(clip.id) ?? clip).start, pps),
                      width: Math.max(6, msToPx(clip.duration, pps) - 2),
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
                    style={place(clip.start, clip.duration)}
                  >
                    {clipBody(clip)}
                  </Block>
                )
              })}
              {selectionRuns.map(({ first, last }) => (
                <span
                  aria-hidden="true"
                  className="wf-selection-box"
                  key={first.id}
                  style={place(first.start, last.start + last.duration - first.start)}
                />
              ))}
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
                        alignEnd: bubbleAlign(markerLeft) === 'is-end',
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
                  isMoving && gesture.preview?.row !== undefined
                    ? rowTop(gesture.preview.row)
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
                        alignEnd: bubbleAlign(msToPx(overlayDrop.start, pps)) === 'is-end',
                      }
                }
              />
              {moving === undefined
                ? null
                : (() => {
                    const overlay = overlaysShown.find((o) => o.id === moving)
                    const row = gesture.preview?.row
                    if (overlay === undefined || row === undefined) return null
                    const note = gesture.preview?.note
                    return (
                      <span
                        className={cn(
                          'wf-time-bubble',
                          bubbleAlign(msToPx(overlay.start, pps)) === 'is-end' && 'is-end',
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
                      clicks.reset()
                      const current = draft.music
                      if (current === null || musicMedia === undefined) return
                      // 往左拖是用歌里更靠后的一段：成片 0 秒对齐的位置后移
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
          {gesture.preview?.note !== undefined && gesture.preview.noteAtMs !== undefined ? (
            <span
              className={cn('wf-drop-bubble', bubbleAlign(msToPx(gesture.preview.noteAtMs, pps)))}
              role="status"
              style={{ left: `${msToPx(gesture.preview.noteAtMs, pps)}px` }}
            >
              <Icon decorative name="blocked" size="xs" />
              {gesture.preview.note}
            </span>
          ) : null}
          {guideMs === null ? null : (
            <span
              aria-hidden="true"
              className="wf-snap-guide"
              style={{ left: `${msToPx(guideMs, pps)}px` }}
            />
          )}
          <TimelinePlayhead style={{ left: `${msToPx(Math.min(playheadMs, total), pps)}px` }} />
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
  /** 在画面上选中的那一块字幕 */
  selectedKey: string | undefined
  sentenceText: (caption: PlacedCaption) => string
  onCommit: (caption: PlacedCaption, text: string) => void
}

/**
 * 字幕轨：每段画面里的一份句子一块。点一块改这一整句的字（跨段的句子两块改的是同一句），
 * 回车或离开输入框记一步编辑，Esc 放弃；清空后回到识别结果。在画面上点中的那一块显示为选中。
 */
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

/** 改字的输入框：打开即聚焦全选；`onDone` 只调一次，放弃时传 undefined */
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
          // 只关输入框，不关整个编辑器
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
