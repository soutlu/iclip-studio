import {
  Fragment,
  useEffect,
  useEffectEvent,
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
import { useEscapeAheadOfDialog } from '@/shared/ui/dialog'
import {
  ContextMenuItem,
  ContextMenuRoot,
  ContextMenuSurface,
  ContextMenuTrigger,
} from '@/shared/ui/menu'
import {
  gapClosing,
  groupShift,
  groupTrimmed,
  groupTrimRange,
  timingOf,
  type GapClosing,
  type SourceLength,
  type Timing,
} from './block-edit'
import { thumbnailUrl, type ComponentCatalog } from './component-catalog'
import { isMediaBlock, type FilmBlock, type PictureBlock } from './composition/film'
import {
  rowHidden,
  rowsOf,
  sameRow,
  targetIn,
  zoneOf,
  type Aim,
  type Row,
  type RowKey,
  type RowTarget,
  type Zone,
} from './placement'
import { boxBetween, marqueeMode, marqueeSelection, movingWith, type Box } from './selection'
import {
  msToPx,
  pxToMs,
  snapMs,
  snapSpanStartMs,
  snapTargets,
  type TimelineScale,
} from './timeline-scale'

/** 镜头拖进来时落在哪：画面区的哪一行（或新开的一行）、成片的第几毫秒。 */
export type TimelinePoint = { row: RowTarget; timeMs: number }

export type TimelineHandle = {
  /** 屏幕上的这个点给镜头落在哪一行、对应成片的第几毫秒；不在任何一行上时是 null。 */
  locate: (clientX: number, clientY: number) => TimelinePoint | null
  /** 时间线现在横向滚到的位置（像素）。 */
  scrollLeft: () => number
}

/** 拖着的素材会落在哪里：`duration` 是它的总长（毫秒），`guideMs` 是它吸上的时间点。 */
export type DropGhost = { row: RowTarget; start: number; duration: number; guideMs: number | null }

type FilmTimelineProps = {
  /** 成片里所有的块。 */
  blocks: readonly FilmBlock[]
  /** 组件库：组件块上的小封面取自它。 */
  catalog: ComponentCatalog
  totalMs: number
  playheadMs: number
  buffered: readonly TimeSpan[]
  scale: TimelineScale
  ghost: DropGhost | null
  /** 选中的块。 */
  selected: ReadonlySet<string>
  /** 拖动和裁剪时要不要吸到别的块的两端和播放头上。 */
  snap: boolean
  /** 块上要不要显示画面缩略图；关掉只剩名字和声音。 */
  thumbnails: boolean
  /** 画面块素材的总长（毫秒），还没读到时是 undefined。音频块的总长取读波形时读到的时长。 */
  pictureSourceMs: (block: PictureBlock) => number | undefined
  /** 换成这些选中的块（空的就是全部取消）。 */
  onSelect: (ids: ReadonlySet<string>) => void
  /** 开始或结束框选、拖块；中途按 Esc 由时间线自己取消。 */
  onGesture: (active: boolean) => void
  /** 给了就把时间线横向滚到 `left`（像素）；每次给新的对象才滚。 */
  scrollRequest: { left: number } | null
  /** 改几个块各自的起止和入点（在行里挪、裁剪），一起算一步。 */
  onRetime: (timings: ReadonlyMap<string, Timing>) => void
  /**
   * 把块换到另一行（或新开的一行）的 `start` 处；`starts` 是和它一起挪的块各自的新起点，
   * 它们留在原来的行。
   */
  onMove: (id: string, row: RowTarget, start: number, starts: ReadonlyMap<string, number>) => void
  /** 把几个块各自挪到新的起点（合拢空档用）。 */
  onRestart: (starts: ReadonlyMap<string, number>) => void
  /** 把 `row` 这一行的块一起隐藏（`hidden` 为真，声音区的行就是静音）或显示回来。 */
  onHide: (row: RowKey, hidden: boolean) => void
  onSeek: (ms: number) => void
  onViewportWidth: (width: number) => void
  handleRef: RefObject<TimelineHandle | null>
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

// 指针离一条空行（待新开的那一行）的上下边这么近也算在它上面
const ROW_REACH_PX = 3

// 时间区左右留的空（whole-film.css 里 .wf-track-content 的 margin：左 8、右 16），不算进能排时间的宽度
const INSET_PX = 24

const rowKeyOf = (block: FilmBlock): RowKey => ({ zone: zoneOf(block), track: block.track })

/** 一条行在屏幕上的上下边；`insertAt` 是待新开的那一行在第几行的位置，已有的行是 null。 */
type Lane = { top: number; bottom: number; insertAt: number | null }

/**
 * 别处让出了一行（`opened`）时，各行按没让出来的样子摆回去：它下面的行往上挪回它占的高度，
 * 最下面那条空行（让行时收起来了）回到最后一行下面。块只能在自己的区里新开一行，让出来的这一行
 * 常常不在指针下面；按让完的样子量，指针下面换成了别的行，又会把这一行收回去，来回跳。
 */
const withoutOpening = (lanes: readonly Lane[], opened: Lane): Lane[] => {
  const rest = lanes.filter((lane) => lane !== opened)
  const after = rest.find((lane) => lane.top > opened.top)
  const shift = after === undefined ? 0 : after.top - opened.top
  const restored = rest.map((lane) =>
    lane.top > opened.top ? { ...lane, top: lane.top - shift, bottom: lane.bottom - shift } : lane,
  )
  const last = restored.at(-1)
  if (last === undefined) return restored
  const height = opened.bottom - opened.top
  return [
    ...restored,
    { top: last.bottom + shift - height, bottom: last.bottom + shift, insertAt: restored.length },
  ]
}

/** `row` 在页面上是哪一条：已有的行，或者待新开的那一行（让出来的空行、最下面那条空行）。 */
const laneOf = (content: HTMLElement | null, row: RowTarget) =>
  content?.querySelector<HTMLElement>(
    'track' in row
      ? `[data-zone="${row.zone}"][data-track="${row.track}"]`
      : `[data-insert-at="${row.insertAt}"]`,
  ) ?? null

/** 按着 Shift、⌘ 或 Ctrl 点块是逐个加减选中。 */
const togglesSelection = (event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) =>
  event.shiftKey || event.metaKey || event.ctrlKey

/** 在行的空白处按下：拖过一点就是框选，没拖就是点空白处。 */
type Framing = {
  pointerId: number
  /** 按下的点，按时间区左上角算，框选中途滚动也不跑。 */
  origin: { x: number; y: number }
  /** 按下时带着 ⌘ 或 Ctrl：框住的加进原有选中。 */
  adding: boolean
  /** 按下时的选中，框选在它上面换、加或减。 */
  base: ReadonlySet<string>
  /** 触摸按下只算点一下，拖动留给滚动。 */
  canFrame: boolean
  started: boolean
}

/** 正在框选：框在哪（按时间区左上角算），松手的话会选中哪些块。 */
type Marquee = { box: Box; ids: ReadonlySet<string> }

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
  /** 一起动的块（含它自己）：开始拖的那一刻定下来，中途选中变了也不换；还没开始拖时是 null。 */
  group: ReadonlySet<string> | null
  timing: Timing | null
  /** 挪的时候块要去哪一行：已有的行，或者要新开的那一行。 */
  row: RowTarget | null
  /** 跟着一起动的别的块各自的时间。 */
  followers: ReadonlyMap<string, Timing>
}

/** 拖动中的块按这个画：时间、正在拖的是哪一部分、要去哪一行（裁剪时是 null）。 */
type Preview = { timing: Timing; kind: Gesture['kind']; row: RowTarget | null }

/** 成组拖动中跟着动的块按这个画：拖的是哪一部分，各自的时间。 */
type Following = { kind: Gesture['kind']; timings: ReadonlyMap<string, Timing> }

/** 一个块这一端在成片里的时间（毫秒）。 */
const edgeAt = (block: Timing, edge: Edge) =>
  edge === 'start' ? block.start : block.start + block.duration

/** `timings` 里和成片里现在不一样的那些。 */
const changedTimings = (
  blocks: readonly FilmBlock[],
  timings: ReadonlyMap<string, Timing>,
): Map<string, Timing> =>
  new Map(
    [...timings].filter(([id, timing]) => {
      const block = blocks.find((other) => other.id === id)
      return block !== undefined && !sameTiming(timing, timingOf(block))
    }),
  )

/** 挪动的落点：被抓的块去哪一行、从哪里起，跟着走的块各自的新时间。 */
type MovePlan = { row: RowTarget; start: number; followers: Map<string, Timing> }

/**
 * 被抓的 `block` 想从 `startMs` 起、去 `row` 这一行时，它和一起挪的块（`group`，含它自己）落在哪里。
 * 一起挪的块挪同一个时间差，跟着走的块留在各自的行；被抓的块换不过去就留在自己那一行。
 * 只挪一个块也走这里，它自己就是一组。
 */
const movePlan = (
  blocks: readonly FilmBlock[],
  block: FilmBlock,
  group: ReadonlySet<string>,
  startMs: number,
  row: RowTarget,
): MovePlan => {
  const shift = groupShift(
    block,
    group,
    blocks,
    startMs - block.start,
    'track' in row ? row.track : null,
  )
  const followers = new Map(
    blocks
      .filter((other) => group.has(other.id) && other.id !== block.id)
      .map((other) => {
        const timing = timingOf(other)
        return [other.id, { ...timing, start: timing.start + shift.delta }]
      }),
  )
  return {
    row: shift.track === null ? row : { zone: zoneOf(block), track: shift.track },
    start: block.start + shift.delta,
    followers,
  }
}

/** 块身里画什么：画面块是画面和原声，组件块是小封面，音频块是整块波形。 */
function BlockContent({
  block,
  timing,
  cover,
  peaks,
}: {
  block: FilmBlock
  timing: Timing
  cover: string | null
  peaks: PeaksState
}) {
  if (block.kind === 'component')
    return cover === null ? null : <img alt="" className="wf-clip-cover" src={cover} />
  const part = {
    mediaUrl: block.src,
    start: timing.mediaStart / 1000,
    end: (timing.mediaStart + timing.duration) / 1000,
  }
  if (block.kind === 'audio')
    return (
      <span className="wf-clip-sound">
        <Wave part={part} state={peaks} />
      </span>
    )
  return (
    <span className="wf-clip-media">
      <span className="wf-clip-frames">
        <Frames part={part} />
      </span>
      <span className="wf-clip-wave">
        <Wave part={part} state={peaks} />
      </span>
    </span>
  )
}

type TimelineBlockProps = {
  block: FilmBlock
  blocks: readonly FilmBlock[]
  selected: boolean
  /** 拖这个块（挪动或裁剪）时一起动的块，含它自己。 */
  group: ReadonlySet<string>
  /** 别的块正带着一组块拖动时，跟着动的块的样子；没有时是 null。 */
  following: Following | null
  pps: number
  /** 时间线内容区，用它把屏幕上的横坐标换成成片的时间。 */
  contentRef: RefObject<HTMLDivElement | null>
  /**
   * `zone` 区的块拖到这个高度时落在哪一行，`between` 为真时两行之间也算（在那里新开一行）；
   * 不在任何一行上时是 undefined。
   */
  rowAt: (clientY: number, between: boolean, zone: Zone) => RowTarget | undefined
  /** 拖动中要在第几行的位置新开一行，那里先让出一行；不新开、松手后是 null。 */
  onOpening: (insertAt: number | null) => void
  /** `group` 里的块一起裁 `edge` 这一端时，`block` 这一端能到的范围（成片的毫秒）。 */
  trimRange: (
    block: FilmBlock,
    group: ReadonlySet<string>,
    edge: Edge,
  ) => { min: number; max: number }
  /** `group` 里的块一起裁 `edge` 这一端、`block` 这一端拖到 `edgeMs` 时，各自的起止和入点。 */
  trimTo: (
    block: FilmBlock,
    group: ReadonlySet<string>,
    edge: Edge,
    edgeMs: number,
  ) => ReadonlyMap<string, Timing>
  /** 组件块上的小封面；没有时是 null。 */
  cover: string | null
  peaks: PeaksState
  snap: boolean
  playheadMs: number
  /** 拖动中吸上了哪个时间点（毫秒），画一条线；没吸上或松手后是 null。 */
  onGuide: (ms: number | null) => void
  /** 成组拖动中跟着动的块怎么画；不是成组、松手后是 null。 */
  onFollow: (following: Following | null) => void
  /** 开始或结束拖动。 */
  onGesture: (active: boolean) => void
  /** 点了这个块：`toggle` 为真时是把它加进选中或移出去，否则只选它。 */
  onSelect: (id: string, toggle: boolean) => void
  onRetime: (timings: ReadonlyMap<string, Timing>) => void
  /** 把块换到另一行的 `start` 处，`starts` 是一起挪的块各自的新起点。 */
  onMove: (id: string, row: RowTarget, start: number, starts: ReadonlyMap<string, number>) => void
}

/**
 * 时间线上的一个块：点一下选中（带 Shift、⌘ 或 Ctrl 是加减选中），拖着挪动（在这一行里，
 * 或者拖到自己的区里别的行、新开的一行上），选中后拖两端的把手裁剪；在不止一个块的选中里时，
 * 选中的块一起挪、一起裁。松手才写进成片，拖动中按 Esc 什么都不写。
 */
function TimelineBlock({
  block,
  blocks,
  selected,
  group,
  following,
  pps,
  contentRef,
  rowAt,
  onOpening,
  trimRange,
  trimTo,
  cover,
  peaks,
  snap,
  playheadMs,
  onGuide,
  onFollow,
  onGesture,
  onSelect,
  onRetime,
  onMove,
}: TimelineBlockProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const clickAfterDrag = useClickAfterDrag()
  const [preview, setPreview] = useState<Preview>()
  const aimed = preview?.row ?? null
  // 拖去别的行时把块画到那一行上。那一行可能是这一次才让出来的，要等排好版再量它在哪
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const own = root.parentElement
    const target = aimed === null ? null : laneOf(contentRef.current, aimed)
    root.style.translate =
      own === null || target === null
        ? ''
        : `0 ${target.getBoundingClientRect().top - own.getBoundingClientRect().top}px`
  })
  const timing = preview?.timing ?? following?.timings.get(block.id) ?? timingOf(block)
  const name = `${block.label}，${seconds(timing.duration)} 秒${block.hidden ? '，已隐藏' : ''}`

  const timeAt = (clientX: number) =>
    pxToMs(clientX - (contentRef.current?.getBoundingClientRect().left ?? 0), pps)

  const press = (event: PointerEvent<HTMLElement>, kind: Gesture['kind']) => {
    if (event.button !== 0) return
    event.stopPropagation()
    clickAfterDrag.reset()
    // 带着加减选中的键按下只算点选，不开始拖
    if (togglesSelection(event)) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const box = event.currentTarget.closest('[data-block-id]')?.getBoundingClientRect()
    gestureRef.current = {
      pointerId: event.pointerId,
      kind,
      originX: event.clientX,
      originY: event.clientY,
      grabMs: box === undefined ? 0 : pxToMs(event.clientX - box.left, pps),
      group: null,
      timing: null,
      row: null,
      followers: new Map(),
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
    if (gesture.group === null) onGesture(true)
    // 开始拖的那一刻定下一起动的块
    gesture.group ??= group
    const members = gesture.group
    const at = timeAt(event.clientX)
    const { kind } = gesture
    // 开着吸附时：没在动的块的两端和播放头是能吸上去的点（一起动的块拖动前的边不算）
    const targets = snap
      ? snapTargets(
          blocks.filter((other) => !members.has(other.id)),
          playheadMs,
        )
      : null
    if (kind === 'move') {
      const wanted = Math.max(0, at - gesture.grabMs)
      const snapped =
        targets === null
          ? { ms: wanted, guideMs: null }
          : snapSpanStartMs(wanted, block.duration, targets, pps)
      // 指针在哪一行上，块就去它自己的区里对着的那一行；在两行之间就在那里新开一行；都不是就留在原来的行
      const row = rowAt(event.clientY, true, zoneOf(block)) ?? rowKeyOf(block)
      const plan = movePlan(blocks, block, members, snapped.ms, row)
      gesture.timing = { ...timingOf(block), start: plan.start }
      gesture.row = plan.row
      gesture.followers = plan.followers
      onOpening('insertAt' in plan.row ? plan.row.insertAt : null)
      // 吸上去的位置被别的块占了、又挪开了，就不画吸附线
      onGuide(plan.start === snapped.ms ? snapped.guideMs : null)
    } else {
      const snapped = targets === null ? { ms: at, guideMs: null } : snapMs(at, targets, pps)
      const timings = trimTo(block, members, kind, snapped.ms)
      const next = timings.get(block.id) ?? timingOf(block)
      gesture.timing = next
      gesture.followers = new Map([...timings].filter(([id]) => id !== block.id))
      onGuide(edgeAt(next, kind) === snapped.ms ? snapped.guideMs : null)
    }
    setPreview({ timing: gesture.timing, kind, row: gesture.row })
    onFollow(gesture.followers.size === 0 ? null : { kind, timings: gesture.followers })
  }

  /** 收起这次拖动的样子；拖动已经开始的才算结束一次拖动。 */
  const finish = () => {
    const started = (gestureRef.current?.group ?? null) !== null
    gestureRef.current = null
    setPreview(undefined)
    onGuide(null)
    onOpening(null)
    onFollow(null)
    if (started) onGesture(false)
  }

  const release = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    releasePointer(event)
    finish()
    if (gesture.timing === null) return
    // 拖完松手也会来一次点击，那一次不算选中
    clickAfterDrag.swallow()
    if (gesture.row !== null && !sameRow(gesture.row, rowKeyOf(block))) {
      const starts = new Map([...gesture.followers].map(([id, timing]) => [id, timing.start]))
      onMove(block.id, gesture.row, gesture.timing.start, starts)
      return
    }
    const changed = changedTimings(
      blocks,
      new Map([[block.id, gesture.timing], ...gesture.followers]),
    )
    if (changed.size > 0) onRetime(changed)
  }

  // 拖动中按 Esc：取消这次拖动，什么都不写；之后松手带来的那次点击也不算选中
  useEscapeAheadOfDialog(preview !== undefined, () => {
    clickAfterDrag.swallow()
    finish()
  })

  // 拖着的块中途被删掉或撤销掉：它留在时间线和编辑器里的拖动状态一起收起
  const abandon = useEffectEvent(() => {
    if ((gestureRef.current?.group ?? null) !== null) finish()
  })
  useEffect(() => () => abandon(), [])

  // 拖动中成片被换掉（撤销了，或者别处存了更新的一版）：松手会按换之前算好的位置写回去，
  // 所以取消这次拖动，之后松手带来的那次点击也不算选中
  const dropStale = useEffectEvent(() => {
    if ((gestureRef.current?.group ?? null) === null) return
    clickAfterDrag.swallow()
    finish()
  })
  useEffect(() => dropStale(), [blocks])

  const nudge = (event: KeyboardEvent<HTMLElement>, edge: Edge) => {
    const step = arrowStep(event)
    if (step === undefined) return
    event.preventDefault()
    event.stopPropagation()
    const changed = changedTimings(
      blocks,
      trimTo(block, group, edge, edgeAt(timingOf(block), edge) + Math.round(step * 1000)),
    )
    if (changed.size > 0) onRetime(changed)
  }

  return (
    <div
      aria-label={name}
      className={cn(
        'wf-clip',
        `is-${block.kind}`,
        selected && 'is-selected',
        block.hidden && 'is-hidden',
        preview?.kind === 'move' && 'is-lifted',
      )}
      data-block-id={block.id}
      ref={rootRef}
      role="group"
      style={{
        left: msToPx(timing.start, pps),
        width: Math.max(2, msToPx(timing.duration, pps) - 2),
      }}
    >
      <button
        aria-label={`选中：${name}`}
        aria-pressed={selected}
        className="wf-block-body ui-focus"
        onClick={(event) => {
          if (!clickAfterDrag.take()) onSelect(block.id, togglesSelection(event))
        }}
        onPointerCancel={finish}
        onPointerDown={(event) => press(event, 'move')}
        onPointerMove={drag}
        onPointerUp={release}
        type="button"
      >
        <span className="wf-clip-label">{block.label}</span>
        <BlockContent block={block} cover={cover} peaks={peaks} timing={timing} />
      </button>
      {selected
        ? (['start', 'end'] as const).map((edge) => {
            const bounds = trimRange(block, group, edge)
            const edgeMs = edgeAt(timing, edge)
            return (
              <TrimHandle
                bounds={{ min: bounds.min / 1000, max: bounds.max / 1000 }}
                edge={edge}
                key={edge}
                onKeyDown={(event) => nudge(event, edge)}
                onPointerCancel={finish}
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

/**
 * 行头最右边的开关：把这一行的块一起隐藏或显示回来。画面区的行画成眼睛；声音区的行画成喇叭，
 * 隐藏就是静音。`row` 是界面上的第几行。
 */
function RowToggle({
  row,
  zone,
  hidden,
  onHide,
}: {
  row: number
  zone: Zone
  hidden: boolean
  onHide: (hidden: boolean) => void
}) {
  const sound = zone === 'audio'
  const [hide, show] = sound ? ['静音', '取消静音'] : ['隐藏', '显示']
  return (
    <button
      aria-label={`${hidden ? show : hide}第 ${row} 行`}
      aria-pressed={!hidden}
      className="wf-head-eye ui-state ui-focus"
      onClick={() => onHide(!hidden)}
      title={`${hidden ? show : hide}这一行`}
      type="button"
    >
      <Icon
        decorative
        name={sound ? (hidden ? 'audio-off' : 'audio') : hidden ? 'excluded' : 'included'}
        size="sm"
      />
    </button>
  )
}

const keyOf = (row: RowKey) => `${row.zone}-${row.track}`

/**
 * 时间线：成片里的块按行排开，画面区的行在上、声音区的行在下，最下面是一条可以新开一行的空行。
 * 块可以选中一个或几个（在空白处拖出框来框选）、在自己的区里挪动、裁两端；上面是时间尺和播放头。
 */
export function FilmTimeline({
  blocks,
  catalog,
  totalMs,
  playheadMs,
  buffered,
  scale,
  ghost,
  selected,
  snap,
  thumbnails,
  pictureSourceMs,
  onSelect,
  onGesture,
  scrollRequest,
  onRetime,
  onMove,
  onRestart,
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
  // 拖着块要在第几行的位置新开一行；拖素材进来时同样由 `ghost` 带着
  const [blockOpening, setBlockOpening] = useState<number | null>(null)
  const opening =
    blockOpening ?? (ghost === null || 'track' in ghost.row ? null : ghost.row.insertAt)
  // 在一行的空处点右键时，两种合拢各自要挪哪些块
  const [closing, setClosing] = useState<GapClosing>()
  // 成组拖动中跟着动的块；每个块只知道自己素材的总长，一起裁到哪里在这一层算
  const [following, setFollowing] = useState<Following | null>(null)
  const peaks = useAudioPeaks(
    useStableValue([...new Set(blocks.filter(isMediaBlock).map((block) => block.src))]),
  )
  const sourceMs: SourceLength = (block) => {
    if (block.kind === 'picture') return pictureSourceMs(block)
    const state = block.kind === 'audio' ? peaks.get(block.src) : undefined
    return state?.kind === 'ready' ? Math.round(state.peaks.duration * 1000) : undefined
  }
  const membersOf = (group: ReadonlySet<string>) => blocks.filter((block) => group.has(block.id))
  const trimRange = (block: FilmBlock, group: ReadonlySet<string>, edge: Edge) => {
    const range = groupTrimRange(membersOf(group), edge, blocks, sourceMs)
    const edgeMs = edgeAt(timingOf(block), edge)
    return { min: edgeMs + range.min, max: edgeMs + range.max }
  }
  const trimTo = (block: FilmBlock, group: ReadonlySet<string>, edge: Edge, edgeMs: number) =>
    groupTrimmed(membersOf(group), edge, edgeMs - edgeAt(timingOf(block), edge), blocks, sourceMs)
  const { pps, contentWidth } = scale
  const rows = rowsOf(blocks)
  // 还没有块时也留一行（画面区的第 0 行），镜头拖得进来
  const shown: readonly Row[] =
    rows.length === 0 ? [{ zone: 'visual', track: 0, blocks: [] }] : rows
  // 要在别的位置新开一行时，最下面那条空行挪到那里去：总高度不变，上面的行不动、下面的行往下让
  const openedAt = opening !== null && opening < rows.length ? opening : null

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

  /**
   * 指针对着哪里：时间线上的第几行，或者在第几行的位置新开一行。只认轨道区里露出来的部分：
   * 滚到时间尺底下、滚出轨道区的行，指针看不见也落不上去。
   * 两行之间的缝（含第一行上面、最后一行下面）：`between` 为真时算在那里新开一行；
   * 为假时只有第一行上面算新开一行，别的缝归离得近的那一行。
   */
  const aimAt = (clientY: number, between: boolean): Aim | undefined => {
    const viewport = scrollRef.current
    const rulerBar = rulerBarRef.current
    if (viewport === null || rulerBar === null) return undefined
    const top = viewport.getBoundingClientRect().top + viewport.clientTop
    if (clientY < top || clientY > top + viewport.clientHeight) return undefined
    const measured: Lane[] = [
      ...(contentRef.current?.querySelectorAll<HTMLElement>('.wf-lane') ?? []),
    ].map((lane) => {
      const { top, bottom } = lane.getBoundingClientRect()
      const insertAt = lane.dataset['insertAt']
      return { top, bottom, insertAt: insertAt === undefined ? null : Number(insertAt) }
    })
    // 指针在时间尺上：第一行露着（没滚到时间尺底下）就算在最上面新开一行，不然哪一行都不算
    const rulerBottom = rulerBar.getBoundingClientRect().bottom
    if (clientY < rulerBottom) {
      const first = measured.find((lane) => lane.insertAt === null)
      return rows.length > 0 && first !== undefined && first.top >= rulerBottom
        ? { insertAt: 0 }
        : undefined
    }
    const near = (lane: Lane) =>
      clientY >= lane.top - ROW_REACH_PX && clientY <= lane.bottom + ROW_REACH_PX
    // 已经让出来的那一行：指针还在它上面就还是它
    const opened = measured.find((lane) => lane.insertAt !== null && lane.insertAt < rows.length)
    if (opened?.insertAt != null && near(opened)) return { insertAt: opened.insertAt }
    const lanes = opened === undefined ? measured : withoutOpening(measured, opened)
    // 最下面那条空行：指针在它上面就在那里新开一行
    const waiting = lanes.find((lane) => lane.insertAt !== null && near(lane))
    if (waiting?.insertAt != null) return { insertAt: waiting.insertAt }
    const existing = lanes.filter((lane) => lane.insertAt === null)
    const on = existing.findIndex((lane) => clientY >= lane.top && clientY <= lane.bottom)
    if (on !== -1) return { at: on }
    // 还没有块时只有一条空行，没有可新开的地方
    if (rows.length === 0) return undefined
    // 指针在第几行的上面那道缝里；比最后一行还靠下时只认紧挨着它的那道缝
    const under = existing.findIndex((lane) => clientY < lane.top)
    const seam = under === -1 ? existing.length : under
    const above = existing[seam - 1]
    const below = existing[seam]
    if (below === undefined && (above === undefined || clientY > above.bottom + 2 * ROW_REACH_PX))
      return undefined
    if (between || above === undefined) return { insertAt: seam }
    return below === undefined || clientY - above.bottom <= below.top - clientY
      ? { at: seam - 1 }
      : { at: seam }
  }

  /** `zone` 区的块对着这个高度时落在哪一行：块只待在自己的区里。 */
  const rowAt = (clientY: number, between: boolean, zone: Zone): RowTarget | undefined => {
    const aim = aimAt(clientY, between)
    if (aim === undefined) return undefined
    // 还没有块时只有画面区那一条空行
    if (rows.length === 0) return { zone: 'visual', track: 0 }
    return targetIn(rows, aim, zone)
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
        // 镜头只落在画面区
        const row = rowAt(clientY, false, 'visual')
        return row === undefined ? null : { row, timeMs: Math.max(0, timeAt(clientX)) }
      },
      scrollLeft: () => scrollRef.current?.scrollLeft ?? 0,
    }
    return () => {
      handleRef.current = null
    }
  })

  /** 拖着的素材会落在 `row` 这一行时，画出它会占的位置；不落在这一行是 null。 */
  const dropGhost = (row: RowTarget) =>
    ghost !== null && sameRow(ghost.row, row) ? (
      <span
        aria-hidden="true"
        className="wf-drop-ghost"
        data-testid="drop-ghost"
        style={{
          left: msToPx(ghost.start, pps),
          width: Math.max(2, msToPx(ghost.duration, pps) - 2),
        }}
      />
    ) : null

  /** 拖着的素材会落进在第 `insertAt` 行的位置新开的那一行时，画出它会占的位置。 */
  const newRowGhost = (insertAt: number) =>
    ghost !== null && 'insertAt' in ghost.row && ghost.row.insertAt === insertAt
      ? dropGhost(ghost.row)
      : null

  // 点在块上，或者这一行没有可合拢的空档：不开菜单
  const openGapMenu = (event: MouseEvent<HTMLElement>, row: RowKey) => {
    const onBlock =
      event.target instanceof Element && event.target.closest('[data-block-id]') !== null
    const next = onBlock ? undefined : gapClosing(blocks, row, timeAt(event.clientX))
    if (next === undefined || (next.one.size === 0 && next.all.size === 0)) {
      event.preventDefault()
      return
    }
    setClosing(next)
  }

  // 带着 Shift、⌘ 或 Ctrl 点块：逐个加进选中或移出去；直接点：只选这一个
  const pick = (id: string, toggle: boolean) => {
    if (!toggle) {
      onSelect(new Set([id]))
      return
    }
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelect(next)
  }

  // 缩放以后：等新的宽度排好再横向滚过去，不然会被原来的宽度挡住
  useLayoutEffect(() => {
    const viewport = scrollRef.current
    if (scrollRequest !== null && viewport !== null) viewport.scrollLeft = scrollRequest.left
  }, [scrollRequest])

  const framingRef = useRef<Framing | null>(null)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const shownSelection = marquee?.ids ?? selected

  const pointIn = (clientX: number, clientY: number) => {
    const origin = contentRef.current?.getBoundingClientRect()
    return { x: clientX - (origin?.left ?? 0), y: clientY - (origin?.top ?? 0) }
  }

  const framed = (framing: Framing, event: PointerEvent<HTMLElement>): Marquee => {
    const box = boxBetween(framing.origin, pointIn(event.clientX, event.clientY))
    const found = [
      ...(contentRef.current?.querySelectorAll<HTMLElement>('[data-block-id]') ?? []),
    ].map((element) => {
      const { left, top, width, height } = element.getBoundingClientRect()
      const at = pointIn(left, top)
      return { id: element.dataset['blockId'] ?? '', box: { left: at.x, top: at.y, width, height } }
    })
    return {
      box,
      ids: marqueeSelection(found, box, framing.base, marqueeMode(framing.adding, event)),
    }
  }

  const dropFraming = () => {
    if (framingRef.current === null && marquee === null) return
    framingRef.current = null
    setMarquee(null)
    onGesture(false)
  }
  // 框选中途按 Esc：只取消这次框选，原来的选中不变
  useEscapeAheadOfDialog(marquee !== null, dropFraming)

  const pressLanes = (event: PointerEvent<HTMLDivElement>) => {
    const { target } = event
    // 行的右键菜单挂在别处，但它的事件也会沿着组件树传到这里
    if (event.button !== 0 || !(target instanceof Element) || !event.currentTarget.contains(target))
      return
    if (target.closest('[data-block-id]') !== null) return
    const canFrame = event.pointerType !== 'touch'
    if (canFrame) event.currentTarget.setPointerCapture(event.pointerId)
    framingRef.current = {
      pointerId: event.pointerId,
      origin: pointIn(event.clientX, event.clientY),
      adding: event.metaKey || event.ctrlKey,
      base: selected,
      canFrame,
      started: false,
    }
  }

  const dragLanes = (event: PointerEvent<HTMLDivElement>) => {
    const framing = framingRef.current
    if (framing === null || framing.pointerId !== event.pointerId || !framing.canFrame) return
    if (!framing.started) {
      const at = pointIn(event.clientX, event.clientY)
      const moved = Math.max(Math.abs(at.x - framing.origin.x), Math.abs(at.y - framing.origin.y))
      if (moved <= DRAG_THRESHOLD) return
      framing.started = true
      onGesture(true)
    }
    setMarquee(framed(framing, event))
  }

  const releaseLanes = (event: PointerEvent<HTMLDivElement>) => {
    const framing = framingRef.current
    if (framing === null || framing.pointerId !== event.pointerId) return
    releasePointer(event)
    // 没拖就是点了空白处：取消全部选中
    onSelect(framing.started ? framed(framing, event).ids : new Set())
    dropFraming()
  }

  return (
    <div className={cn('wf-tracks', !thumbnails && 'is-plain')} ref={scrollRef}>
      <div className="wf-track-inner">
        <div className="wf-track-heads" ref={headsRef}>
          <span aria-hidden="true" className="wf-track-corner" />
          {shown.map((row, at) => (
            <Fragment key={keyOf(row)}>
              {openedAt === at ? (
                <span aria-hidden="true" className="wf-track-head is-opening" />
              ) : null}
              <span className="wf-track-head">
                {row.zone === 'audio' ? (
                  <Icon className="wf-head-icon" decorative name="music" size="xs" />
                ) : null}
                <span className="wf-head-name">{row.blocks[0]?.label}</span>
                {row.blocks.length > 1 ? (
                  <span aria-label={`${row.blocks.length} 个块`} className="wf-head-count">
                    {row.blocks.length}
                  </span>
                ) : null}
                {row.blocks.length > 0 ? (
                  <RowToggle
                    hidden={rowHidden(blocks, row)}
                    onHide={(hidden) => onHide({ zone: row.zone, track: row.track }, hidden)}
                    row={at + 1}
                    zone={row.zone}
                  />
                ) : null}
              </span>
            </Fragment>
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
              tickScale={scale.viewSeconds}
              total={totalMs / 1000}
              viewportRef={scrollRef}
            />
            <TimelinePlayhead style={{ left: msToPx(Math.min(playheadMs, totalMs), pps) }} />
          </div>
          <div
            className="wf-lanes"
            onPointerCancel={dropFraming}
            onPointerDown={pressLanes}
            onPointerMove={dragLanes}
            onPointerUp={releaseLanes}
          >
            {shown.map((row, at) => (
              <Fragment key={keyOf(row)}>
                {openedAt === at ? (
                  <div aria-hidden="true" className="wf-lane is-new is-opening" data-insert-at={at}>
                    {newRowGhost(at) ?? <span className="wf-lane-hint">新开一行</span>}
                  </div>
                ) : null}
                <ContextMenuRoot>
                  <ContextMenuTrigger asChild>
                    <div
                      aria-label={`第 ${at + 1} 行`}
                      className="wf-lane"
                      data-track={row.track}
                      data-zone={row.zone}
                      onContextMenu={(event) => openGapMenu(event, row)}
                      role="group"
                    >
                      {row.blocks.map((block) => (
                        <TimelineBlock
                          block={block}
                          blocks={blocks}
                          contentRef={contentRef}
                          cover={
                            block.kind === 'component'
                              ? thumbnailUrl(catalog, block.component)
                              : null
                          }
                          following={following}
                          group={movingWith(selected, block.id)}
                          key={block.id}
                          onFollow={setFollowing}
                          onGesture={onGesture}
                          onGuide={setBlockGuideMs}
                          onMove={onMove}
                          onOpening={setBlockOpening}
                          onRetime={onRetime}
                          onSelect={pick}
                          peaks={
                            isMediaBlock(block)
                              ? (peaks.get(block.src) ?? { kind: 'loading' })
                              : { kind: 'silent' }
                          }
                          playheadMs={playheadMs}
                          pps={pps}
                          rowAt={rowAt}
                          selected={shownSelection.has(block.id)}
                          snap={snap}
                          trimRange={trimRange}
                          trimTo={trimTo}
                        />
                      ))}
                      {dropGhost(row)}
                      {blocks.length === 0 && ghost === null ? (
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
              </Fragment>
            ))}
            {blocks.length === 0 || openedAt !== null ? null : (
              <div
                aria-label="新的一行"
                className="wf-lane is-new"
                data-insert-at={rows.length}
                role="group"
              >
                {newRowGhost(rows.length) ?? (
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
          {marquee === null ? null : (
            <span
              aria-hidden="true"
              className="wf-marquee"
              data-testid="marquee"
              style={marquee.box}
            />
          )}
        </div>
      </div>
    </div>
  )
}
