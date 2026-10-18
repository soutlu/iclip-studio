import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import type { PeaksState } from '../editing/media-analysis'
import { Frames, TimelinePlayhead, TimelineRuler, TrimHandle, Wave } from '../editing/timeline'
import {
  arrowStep,
  DRAG_THRESHOLD,
  releasePointer,
  useClickAfterDrag,
} from '../editing/timeline-drag'
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
import { moveClip, trimClip } from './editing/layer0'
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
import {
  msToPx,
  pxToMs,
  rulerTickStep,
  snapMs,
  snapSpanStartMs,
  snapTargets,
  type TimelineScale,
} from './timeline-scale'
import { usePreviewGesture, type GestureStep } from './use-preview-gesture'

export type Selection =
  { kind: 'clip'; id: string } | { kind: 'overlay'; id: string } | { kind: 'music' } | null

export type MusicView = { url: string; title: string; peaks: PeaksState }

/** 组件在轨道上的样子：中文名，与组件栏卡片同一张缩略图（没有时用分类图标） */
export type ComponentFace = { title: string; thumbnail: string | undefined; icon: IconName }

/**
 * 指针落在成片区的哪一处：哪条轨的哪个时刻（毫秒），以及在特效轨上对应哪一行。拖到特效轨的东西
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

/** 从素材区、组件栏拖到成片区的东西 */
export type CarryPayload = {
  durationMs: number
  /**
   * 手上的缩影：拿起时的位置与大小（松手没放下时退回这里），以及里面画的东西。素材的缩影和拿起的
   * 那段一样大；组件卡的缩影是按内容排开的小条（预览图加名字）。
   */
  ghost?: { body: ReactNode; origin: GhostBox; kind?: 'material' | 'card' } | undefined
  /** 是组件时，特效轨上的虚线块画它 */
  face?: ComponentFace | undefined
  /** 落在这一处会怎样；这条轨不收它时为 undefined（不提示） */
  attempt: (point: DropPoint) => Attempt | undefined
  /** 松手落在这一处：真的放进去，返回放进去了没有 */
  drop: (point: DropPoint) => boolean
}

/** 成片区给拖东西过来的一方用的接口 */
export type TracksHandle = {
  /** 带着东西移到这里：只在能接收的轨上画会放到哪，轨道上的东西不动 */
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

type GhostBox = { left: number; top: number; width: number; height: number }

type FilmTracksProps = {
  draft: WholeFilmDraft
  context: EditContext
  scale: TimelineScale
  playheadMs: number
  onSeek: (ms: number) => void
  selection: Selection
  onSelect: (selection: Selection) => void
  /** 点成片轨上的一段：选中它，从段首播这一段 */
  onClipClick: (clip: Layer0Clip) => void
  snap: boolean
  /** 拍点（整片时间） */
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
  /** 放进整片的字幕（每段画面里的一份句子） */
  captions: readonly PlacedCaption[]
  /** 改字时输入框里的整句：改过的字或识别结果 */
  sentenceText: (caption: PlacedCaption) => string
  onCaptionText: (caption: PlacedCaption, text: string) => void
  /** 字幕样式的中文名；点它到组件栏换样式 */
  captionStyle: string
  onCaptionStyle: () => void
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
/** 成片轨上方这么近也算拖到了成片轨上 */
const DROP_SLOP_PX = 16
/** 相邻轨之间的空隙里，离哪条轨这么近就算那条轨 */
const LANE_SLOP_PX = 4
/** 手上的缩影在指针右下这么远，不盖住插入标记 */
const GHOST_OFFSET_PX = 12
/** 缩影退回拿起处的时长，与 whole-film.css 的 --dur-m 一致 */
const RETURN_MS = 260
/** 带着东西靠近时间区左右边缘这么近就自动横向滚动，每秒滚这么多像素 */
const SCROLL_EDGE_PX = 40
const SCROLL_SPEED = 420
/** 拍点在切点前后这么近就算卡在拍上 */
const ON_BEAT_MS = 10

type Edge = 'start' | 'end'

type Carrying = {
  clientX: number
  clientY: number
  payload: CarryPayload
  point: DropPoint | undefined
  attempt: Attempt | undefined
  returning: boolean
}

type Lift = {
  clipId: string
  from: number
  pointerId: number
  originX: number
  originY: number
  clientX: number
  clientY: number
  moved: boolean
  origin: GhostBox
  /** 松手会插到第几段之前（按原来的顺序）；不在成片轨上为 undefined */
  to: number | undefined
  returning: boolean
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
  onSelect: () => void
  pointer: PointerHandlers
  handles: ReactNode
  /** 点开的浮层（组件块才有） */
  popover?: ReactNode
  clipId?: string
  shortcuts?: string
  onAnimationEnd?: () => void
  children: ReactNode
}

/** 轨道上的一块：整块是一个选中按钮（按住可拖），选中后两端出现修剪手柄 */
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
  onAnimationEnd,
  children,
}: BlockProps) {
  return (
    <div
      aria-label={name}
      className={cn(className, selected && 'is-selected')}
      onAnimationEnd={onAnimationEnd}
      role="group"
      style={style}
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

/** 手上的缩影：跟在指针右下；松手没放下时退回拿起的地方再消失 */
function Ghost({
  clientX,
  clientY,
  origin,
  returning,
  blocked,
  className,
  fitContent = false,
  children,
}: {
  clientX: number
  clientY: number
  origin: GhostBox
  returning: boolean
  blocked: boolean
  className: string
  /** 大小按内容，不取拿起时的大小 */
  fitContent?: boolean
  children: ReactNode
}) {
  return createPortal(
    <div
      aria-hidden="true"
      className={cn('wf-ghost', className, blocked && 'is-blocked', returning && 'is-returning')}
      style={{
        left: returning ? origin.left : clientX + GHOST_OFFSET_PX,
        top: returning ? origin.top : clientY + GHOST_OFFSET_PX,
        ...(fitContent ? {} : { width: origin.width, height: origin.height }),
      }}
    >
      {children}
    </div>,
    document.body,
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
  captionStyle,
  onCaptionStyle,
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
  const captionLaneRef = useRef<HTMLDivElement>(null)
  const musicLaneRef = useRef<HTMLDivElement>(null)
  const clicks = useClickAfterDrag()
  const [carry, setCarry] = useState<Carrying | null>(null)
  const [lift, setLift] = useState<Lift | null>(null)
  // 刚放下、排好的那一段播一次落位动画
  const [settling, setSettling] = useState<string | null>(null)
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

  // 行数按拿起、拖动之前的草稿算：拖动中轨道上的行不变
  const rows = overlayRowCount(draft.overlays)
  const laneRows = Math.max(1, rows)

  /** 指针纵坐标落在特效轨的哪一行；在所有行之上、之下不远处就开一行；离得太远是 undefined */
  const overlayRowFrom = (clientY: number): OverlayRow | undefined => {
    const lane = overlayLaneRef.current?.getBoundingClientRect()
    if (lane === undefined) return undefined
    const y = clientY - (lane.top + ROWS_TOP_PX)
    const below = rows === 0 ? lane.height : rows * ROW_PX + NEW_ROW_BELOW_PX
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
        : near(captionLaneRef.current)
          ? 'caption'
          : near(musicLaneRef.current)
            ? 'music'
            : undefined
    if (lane === undefined) return undefined
    const row = overlayRow ?? { insertAt: 0 }
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
      returning: false,
    }
  }

  const liftTo = (current: Lift, clientX: number, clientY: number): Lift => ({
    ...current,
    clientX,
    clientY,
    to: overFilm(clientX, clientY) ? insertIndexAt(draft.layer0, timeAt(clientX)) : undefined,
  })

  /** 松手没放下：缩影退回拿起的地方再消失 */
  const settleBack = <T,>(set: (update: (current: T | null) => T | null) => void, value: T) => {
    set(() => value)
    window.setTimeout(() => set(() => null), RETURN_MS)
  }

  useEffect(() => {
    tracksRef.current = {
      carry: (clientX, clientY, payload) => {
        pointerRef.current = { clientX, clientY }
        setCarry(carryTo(clientX, clientY, payload))
      },
      release: (clientX, clientY, payload) => {
        pointerRef.current = null
        const point = pointAt(clientX, clientY, payload.durationMs)
        const attempt = point === undefined ? undefined : payload.attempt(point)
        const dropped = point !== undefined && attempt !== undefined && payload.drop(point)
        if (dropped && attempt.ok) {
          const added = attempt.draft.layer0.find(
            (clip) => !draft.layer0.some((before) => before.id === clip.id),
          )
          if (added !== undefined) setSettling(added.id)
        }
        if (!dropped && carry !== null && carry.payload.ghost !== undefined)
          settleBack(setCarry, { ...carry, returning: true })
        else setCarry(null)
        return dropped
      },
      cancel: () => {
        pointerRef.current = null
        setCarry(null)
      },
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
          : carryTo(current.clientX, current.clientY, current.payload),
      )
      setLift((current) =>
        current === null || !current.moved || current.returning
          ? current
          : liftTo(current, current.clientX, current.clientY),
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

  const selectedId = selection !== null && 'id' in selection ? selection.id : undefined
  const place = (start: number, duration: number) => ({
    left: `${msToPx(start, pps)}px`,
    width: `${Math.max(6, msToPx(duration, pps) - 2)}px`,
  })

  /** 视频段要知道素材多长才能修剪；组件段随时可以 */
  const editable = (clip: Layer0Clip) =>
    clip.type === 'component' || context.sources[clip.sourceJobId] !== undefined

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
      const result = trimOverlay(draft, {
        overlayId: overlay.id,
        edge,
        deltaMs: snapped.ms - edgeMs,
      })
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
    gesture.start(event, (deltaPx, clientY): GestureStep => {
      row = overlayRowFrom(clientY) ?? row
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
        // 拖过整片总长上限：停在放得下的地方并写明原因
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

  const clipEdges = (clip: Layer0Clip): Edge[] => (editable(clip) ? ['start', 'end'] : [])

  /** 点选组件段或特效块：有可填项时弹出浮层 */
  const openPopover = (id: string, component: string) => {
    if (popovers.hasFields(component)) popovers.onOpen(id)
  }

  // ---- 成片段拖动排序：拿起的段留在原处变淡，手上跟着它的缩影；在成片轨上只画插入标记，松手才挪 ----
  const liftPointer = (clip: Layer0Clip, index: number): PointerHandlers => ({
    onPointerDown: (event) => {
      if (event.button !== 0) return
      clicks.reset()
      event.currentTarget.setPointerCapture(event.pointerId)
      const box = event.currentTarget.getBoundingClientRect()
      setLift({
        clipId: clip.id,
        from: index,
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        clientX: event.clientX,
        clientY: event.clientY,
        moved: false,
        origin: { left: box.left, top: box.top, width: box.width, height: box.height },
        to: undefined,
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
      setLift(liftTo({ ...lift, moved: true }, event.clientX, event.clientY))
    },
    onPointerUp: (event) => {
      if (lift === null || lift.pointerId !== event.pointerId) return
      releasePointer(event)
      pointerRef.current = null
      if (!lift.moved) {
        setLift(null)
        return
      }
      clicks.swallow()
      const done = liftTo(lift, event.clientX, event.clientY)
      if (done.to === undefined) {
        settleBack(setLift, { ...done, returning: true })
        return
      }
      setLift(null)
      if (apply(moveClip(draft, { clipId: clip.id, to: done.to }))) {
        onSelect({ kind: 'clip', id: clip.id })
        setSettling(clip.id)
      }
    },
    onPointerCancel: () => {
      pointerRef.current = null
      setLift(null)
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

  /** 成片段里画的东西：视频段上面是画面、下面是原声；组件段上面是组件的画面、下面写组件名 */
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

  // ---- 拖放提示：插入标记、虚线块、新开一行的横线；轨道上的东西一概不动 ----
  const hover = carry !== null && !carry.returning ? carry : null
  const insertClock = (index: number) => draft.layer0[index]?.start ?? layer0End(draft)
  const marker: { index: number; text: string; blocked: boolean } | undefined = (() => {
    if (lift !== null && lift.moved && !lift.returning && lift.to !== undefined) {
      const final = lift.to > lift.from ? lift.to - 1 : lift.to
      return { index: lift.to, text: `挪到第 ${final + 1} 段`, blocked: false }
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
  const overlayDrop = (() => {
    if (hover?.point?.lane !== 'overlay' || hover.attempt === undefined) return undefined
    const face = hover.payload.face
    if (face === undefined) return undefined
    const placed = hover.attempt.ok
      ? hover.attempt.draft.overlays.find(
          (overlay) => !draft.overlays.some((before) => before.id === overlay.id),
        )
      : undefined
    return {
      face,
      start: placed?.start ?? hover.point.timeMs,
      duration: placed?.duration ?? hover.payload.durationMs,
      row: hover.point.overlayRow,
      reason: hover.attempt.ok ? undefined : hover.attempt.reason,
    }
  })()
  const captionDrop = hover?.point?.lane === 'caption' && hover.attempt?.ok === true

  /** 特效块画在第几行的高度：已有的行，或要新开一行时的横线上（轨道不动，松手才多出这一行） */
  const lineTop = (row: { insertAt: number }) =>
    row.insertAt === 0 ? ROWS_TOP_PX - 4 : ROWS_TOP_PX + rows * ROW_PX + 1
  const rowTop = (row: OverlayRow) =>
    'track' in row
      ? ROWS_TOP_PX + row.track * ROW_PX
      : rows === 0
        ? ROWS_TOP_PX
        : lineTop(row) - ROW_PX / 2 + 2
  const newRow = (() => {
    if (rows === 0) return undefined
    const row = overlayDrop?.row ?? gesture.preview?.row
    return row !== undefined && 'insertAt' in row ? row : undefined
  })()

  const moving = gesture.preview?.overlayId
  const overlaysShown = draft.overlays.map((overlay) => {
    if (overlay.id !== moving) return overlay
    const after = shown.overlays.find((o) => o.id === overlay.id)
    return after === undefined ? overlay : { ...overlay, start: after.start }
  })
  const trimmed = (overlay: OverlayClip) =>
    moving === undefined ? (shown.overlays.find((o) => o.id === overlay.id) ?? overlay) : overlay

  const guideMs = gesture.preview?.guideMs ?? hover?.point?.guideMs ?? null
  const markerLeft = marker === undefined ? 0 : msToPx(insertClock(marker.index), pps)
  const bubbleAlign = (left: number) =>
    left < 120 ? 'is-start' : left > contentWidth - 120 ? 'is-end' : undefined
  const tailLeft = msToPx(layer0End(shown), pps) + 8
  const showTail = marker === undefined && contentWidth - tailLeft > 300
  const cuts = cutsOf(shown)

  return (
    <div className="wf-tracks" style={{ '--wf-overlay-rows': laneRows } as CSSProperties}>
      <div className="wf-track-heads">
        <span aria-hidden="true" className="wf-track-head is-film">
          <Icon decorative name="video" size="sm" />
          成片
        </span>
        <span aria-hidden="true" className="wf-track-head is-overlay">
          <Icon decorative name="layers" size="sm" />
          特效
        </span>
        <span className="wf-track-head">
          <Icon decorative name="captions" size="sm" />
          <span aria-hidden="true">字幕</span>
          <button
            aria-label={`字幕样式：${captionStyle}，点此到组件栏换样式`}
            className="wf-head-pill ui-state ui-focus"
            onClick={onCaptionStyle}
            title={`字幕样式：${captionStyle}`}
            type="button"
          >
            {captionStyle}
          </button>
        </span>
        <span className="wf-track-head">
          <Icon decorative name="music" size="sm" />
          <span aria-hidden="true">音乐</span>
          {musicAction}
        </span>
      </div>
      <div className="wf-track-scroll" ref={scrollRef}>
        <div className="wf-track-content" ref={contentRef} style={{ width: `${contentWidth}px` }}>
          <TimelineRuler
            clockAt={(clientX) => timeAt(clientX) / 1000}
            currentTime={playheadMs / 1000}
            onScrub={() => {}}
            onSeek={(clock) => onSeek(Math.round(clock * 1000))}
            scale={contentWidth / pps}
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
            <div aria-label="成片画面轨" className="wf-lane is-film" ref={filmLaneRef} role="group">
              {shown.layer0.map((clip, index) => {
                const name = `第 ${index + 1} 段 · ${
                  clip.type === 'video'
                    ? clipLabel(clip)
                    : `组件 · ${componentFace(clip.component).title}`
                }，${seconds(clip.duration)} 秒`
                return (
                  <Block
                    className={cn(
                      'wf-clip',
                      clip.type === 'component' && 'is-card',
                      lift?.clipId === clip.id && lift.moved && 'is-lifted',
                      settling === clip.id && 'is-settling',
                    )}
                    clipId={clip.id}
                    handles={trimHandles(
                      clipEdges(clip),
                      clip.duration,
                      '该段',
                      (event, edge) => startTrim(event, clip, edge),
                      (edge, deltaMs) =>
                        trimClip(draft, { clipId: clip.id, edge, deltaMs }, context),
                    )}
                    key={clip.id}
                    name={name}
                    onAnimationEnd={() => setSettling(null)}
                    onSelect={() => {
                      if (clicks.take()) return
                      onClipClick(clip)
                      if (clip.type === 'component') openPopover(clip.id, clip.component)
                    }}
                    pointer={liftPointer(clip, index)}
                    popover={
                      clip.type === 'component'
                        ? popoverOf(clip.id, `组件 · ${componentFace(clip.component).title}`)
                        : undefined
                    }
                    selected={selectedId === clip.id}
                    shortcuts="Delete Alt+ArrowLeft Alt+ArrowRight"
                    style={place(clip.start, clip.duration)}
                  >
                    {clipBody(clip)}
                  </Block>
                )
              })}
              {showTail ? (
                <span className="wf-lane-hint is-tail" style={{ left: `${tailLeft}px` }}>
                  <Icon decorative name="insert" size="xs" />
                  把镜头或特效拖到这里
                </span>
              ) : null}
            </div>
            <div
              aria-label="特效轨"
              className={cn('wf-lane is-overlay', overlayDrop !== undefined && 'is-drop')}
              ref={overlayLaneRef}
              role="group"
            >
              {draft.overlays.length === 0 && overlayDrop === undefined ? (
                <span className="wf-lane-hint">把左侧的特效拖到这里</span>
              ) : null}
              {newRow === undefined ? null : (
                <span className="wf-overlay-insert" style={{ top: `${lineTop(newRow)}px` }} />
              )}
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
                    handles={trimHandles(
                      ['start', 'end'],
                      timed.duration,
                      '该段特效',
                      (event, edge) => startOverlayTrim(event, overlay, edge),
                      (edge, deltaMs) =>
                        trimOverlay(draft, { overlayId: overlay.id, edge, deltaMs }),
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
                    selected={selectedId === overlay.id}
                    shortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Delete"
                    style={{ ...place(timed.start, timed.duration), top: `${top}px` }}
                  >
                    <OverlayFace face={face} />
                  </Block>
                )
              })}
              {overlayDrop === undefined ? null : (
                <span
                  aria-hidden="true"
                  className={cn(
                    'wf-overlay is-ghost',
                    overlayDrop.reason !== undefined && 'is-blocked',
                  )}
                  style={{
                    ...place(overlayDrop.start, overlayDrop.duration),
                    top: `${rowTop(overlayDrop.row)}px`,
                  }}
                >
                  <OverlayFace face={overlayDrop.face} />
                </span>
              )}
              {overlayDrop?.reason === undefined ? null : (
                <span
                  className={cn(
                    'wf-time-bubble',
                    bubbleAlign(msToPx(overlayDrop.start, pps)) === 'is-end' && 'is-end',
                  )}
                  role="status"
                  style={{
                    left: `${msToPx(overlayDrop.start, pps)}px`,
                    top: `${rowTop(overlayDrop.row) - 3}px`,
                  }}
                >
                  <Icon decorative name="blocked" size="xs" />
                  {overlayDrop.reason}
                </span>
              )}
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
                          `${seconds(overlay.start)}–${seconds(overlay.start + overlay.duration)} 秒`
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
              className={cn('wf-lane', captionDrop && 'is-drop')}
              ref={captionLaneRef}
              role="group"
            >
              <CaptionChips
                captions={captions}
                onCommit={onCaptionText}
                place={place}
                sentenceText={sentenceText}
              />
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
                      // 往左拖是用歌里更靠后的一段：整片 0 秒对齐的位置后移
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
                  音乐比整片短 {seconds(shortfall)} 秒，不循环补齐
                </span>
              ) : null}
            </div>
          </div>
          {marker === undefined ? null : (
            <>
              <span
                aria-hidden="true"
                className={cn('wf-drop-marker', marker.blocked && 'is-blocked')}
                style={{ left: `${markerLeft}px` }}
              />
              <span
                className={cn('wf-drop-bubble', bubbleAlign(markerLeft))}
                role="status"
                style={{ left: `${markerLeft}px` }}
              >
                <Icon decorative name={marker.blocked ? 'blocked' : 'insert'} size="xs" />
                {marker.text}
              </span>
            </>
          )}
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
      {carry?.payload.ghost === undefined ? null : (
        <Ghost
          blocked={carry.attempt?.ok === false}
          className={carry.payload.ghost.kind === 'card' ? 'is-card' : 'is-material'}
          fitContent={carry.payload.ghost.kind === 'card'}
          clientX={carry.clientX}
          clientY={carry.clientY}
          origin={carry.payload.ghost.origin}
          returning={carry.returning}
        >
          {carry.payload.ghost.body}
        </Ghost>
      )}
      {lift === null || !lift.moved
        ? null
        : (() => {
            const clip = draft.layer0.find((c) => c.id === lift.clipId)
            return clip === undefined ? null : (
              <Ghost
                blocked={false}
                className={cn('is-lift', clip.type === 'component' && 'is-card')}
                clientX={lift.clientX}
                clientY={lift.clientY}
                origin={lift.origin}
                returning={lift.returning}
              >
                {clipBody(clip)}
              </Ghost>
            )
          })()}
    </div>
  )
}

const captionKey = (caption: PlacedCaption) =>
  `${caption.clipId}:${caption.subtitleJobId}:${caption.sentenceIndex}`

type CaptionChipsProps = {
  captions: readonly PlacedCaption[]
  place: (start: number, duration: number) => { left: string; width: string }
  sentenceText: (caption: PlacedCaption) => string
  onCommit: (caption: PlacedCaption, text: string) => void
}

/**
 * 字幕轨：每段画面里的一份句子一块。点一块改这一整句的字（跨段的句子两块改的是同一句），
 * 回车或离开输入框记一步编辑，Esc 放弃；清空后回到识别结果。
 */
function CaptionChips({ captions, place, sentenceText, onCommit }: CaptionChipsProps) {
  const [editing, setEditing] = useState<string | null>(null)
  if (captions.length === 0)
    return <span className="wf-lane-hint">成片里的视频识别出字幕后显示在这里</span>
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
        className="wf-caption ui-state ui-focus"
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
