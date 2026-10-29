import {
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
} from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { useEscapeAheadOfDialog } from '@/shared/ui/dialog'
import type { SecondsRange } from '../editing/clip'
import type { PeaksState } from '../editing/media-analysis'
import { shiftSelect, stepSelect } from '../editing/range-select'
import { roundSeconds } from '../editing/time-label'
import { Frames, TimelinePlayhead, TimelineRuler, TrimHandle, Wave } from '../editing/timeline'
import {
  arrowStep,
  DRAG_THRESHOLD,
  releasePointer,
  useClickAfterDrag,
  useRovingFocus,
  type Edge,
} from '../editing/timeline-drag'
import {
  InsertionGhost,
  InsertionPreview,
  type InsertionBox,
  type InsertionFace,
  type InsertionGhostHandle,
  type InsertionPreviewHandle,
} from '../editing/timeline-insertion'
import { useInsertionMotion } from '../editing/use-insertion-motion'
import {
  draftLineOf,
  runTrimSpecOf,
  shotItemId,
  snapAhead,
  snapNear,
  totalOf,
  trimSpecOf,
  trimTo,
  type DraftItem,
  type TrimSpec,
} from './draft'
import {
  coveredSpan,
  editTitleOf,
  lanePartsOf,
  spanName,
  type EditBlock,
  type LanePart,
  type Shot,
} from './edit-blocks'
import { useDraftReflow, type Flash } from './use-draft-reflow'
import './editor-timeline.css'

const secondsText = (value: number) => value.toFixed(1)

type FrameProps = { mediaUrl: string; start: number; end: number; peaks: PeaksState }

/** 一块的画面行与原声行。 */
function Faces({ mediaUrl, start, end, peaks }: FrameProps) {
  const part = { mediaUrl, start, end }
  return (
    <>
      <span className="video-editor-timeline-frames">
        <Frames part={part} />
      </span>
      <span className="video-editor-timeline-wave">
        <Wave part={part} state={peaks} />
      </span>
    </>
  )
}

/** 按元素的横向范围把指针位置换成时间线上的时刻。 */
const clockIn = (lanes: HTMLElement | null, scale: number, clientX: number) => {
  const bounds = lanes?.getBoundingClientRect()
  if (bounds === undefined || bounds.width === 0) return 0
  return Math.min(scale, Math.max(0, ((clientX - bounds.left) / bounds.width) * scale))
}

/**
 * 剪辑视图里全页唯一的选中：原片轨上的选区（原片时间，生成用；点镜头时按整镜头，拖两端把手可以停在镜头中间）、
 * 草稿里的一块，或编辑轨上在跑的那条。
 */
export type Selection =
  | ({ kind: 'run' } & SecondsRange)
  | { kind: 'draft'; id: string }
  | { kind: 'running'; id: string }
  | undefined

/** 修剪把手落到的新起止（按这一块来源自己的时间）。 */
export type TrimChange = { id: string; edge: Edge; t0: number; t1: number }

/** 原片选区的把手落到的新起止（原片时间）。 */
export type RunChange = SecondsRange & { edge: Edge }

type ClipsTimelineProps = {
  rootUrl: string
  /** 原片时长：每秒多少像素只由它决定，草稿更长时往右滚动。 */
  duration: number
  shots: readonly Shot[]
  blocks: readonly EditBlock[]
  /** 草稿里的块，按合成时间首尾相接。 */
  items: readonly DraftItem[]
  shotOn: (no: number) => boolean
  isPicked: (editId: string, seg: number) => boolean
  selection: Selection
  /** 播放头的时刻：草稿预览时是合成时间，原片预览时是原片时间（见 `clockOn`）。 */
  clock: number
  /** 播放头按哪种时间放：两种都用同一个每秒像素。标尺始终按合成时间定位。 */
  clockOn: 'draft' | 'source'
  peaksOf: (url: string) => PeaksState
  /** 在标尺上按合成时间定位。 */
  onSeek: (clock: number) => void
  onScrub: () => void
  /** 点镜头、Shift 点、方向键：按整镜头选中这一串，为 undefined 时清掉选区。 */
  onSelectRun: (run: SecondsRange | undefined) => void
  onTrimRun: (change: RunChange) => void
  onSelectDraft: (id: string) => void
  onSelectRunning: (id: string) => void
  onToggleShot: (no: number) => void
  /** 点编辑轨上完成的一段：选用或取消，同点它的眼睛，另由编辑器决定选中。 */
  onClickPart: (editId: string, seg: number) => void
  /** 开关编辑轨上的一段：它的眼睛、把它拖进草稿、把草稿里的它拖出去都走这里。 */
  onTogglePart: (editId: string, seg: number) => void
  onTrim: (change: TrimChange) => void
  /** 把这一段拖到草稿上、还没松手时草稿的样子（见 `previewPick`）；它已在草稿里时为 undefined。 */
  previewPick: (editId: string, seg: number) => readonly DraftItem[] | undefined
  selectionBoxRef: Ref<HTMLSpanElement>
}

/** 指针下是哪条轨的哪一块：草稿块与它的来源同 id（原片镜头 `shot-3`、编辑段 `<编辑片段>#<段>`）。 */
type Hover = { track: 'draft' | 'film' | 'edit'; id: string }

/** 按指针下的元素认出悬停的块；正在收起的块、块以外的地方都不算。 */
const hoverAt = (target: EventTarget | null): Hover | undefined => {
  const node = target instanceof Element ? target.closest<HTMLElement>('[data-hover-track]') : null
  const track = node?.dataset['hoverTrack']
  const id = node?.dataset['hoverId']
  return (track === 'draft' || track === 'film' || track === 'edit') && id !== undefined
    ? { track, id }
    : undefined
}

/**
 * 按住草稿里的一块或编辑轨上完成的一段：移动超过拖动阈值才算拖，缩影跟手，松手前不改草稿。
 * 编辑段拖到草稿轨上松手 = 选用；草稿块拖出草稿轨松手 = 拿掉；别处松手取消，缩影回到原处。
 */
type Carry = {
  from: 'part' | 'draft'
  /** 编辑段的 id，或草稿块的 id。 */
  id: string
  face: InsertionFace
  pointerId: number
  x0: number
  y0: number
  x: number
  y: number
  moved: boolean
  /** 指针在草稿轨上。 */
  over: boolean
  origin: InsertionBox
  /** 按下时每秒多少像素、草稿轨多高：落点占位按它们摆。 */
  pps: number
  height: number
  /** 松了手，缩影正飞向落点或回到原处。 */
  returning: boolean
  destination?: InsertionBox | undefined
}

/** 关联描边与连线怎么淡出：常驻的为空串，开关后自动出现的那一对在停留后 `fading`、拿掉时随收起 `out`。 */
type Fade = '' | 'fading' | 'out'

const fadeOf = (flash: Flash | undefined): Fade =>
  flash === undefined ? '' : flash.out ? 'out' : flash.fading ? 'fading' : ''

const fadeClass = (fade: Fade) => cn(fade !== '' && 'is-fading', fade === 'out' && 'is-out')

/** 轨道区里 `attribute` 等于 `value` 的那个元素。 */
const nodeOf = (lanes: HTMLElement, attribute: string, value: string) =>
  [...lanes.querySelectorAll<HTMLElement>(`[${attribute}]`)].find(
    (node) => node.getAttribute(attribute) === value,
  )

/** 拖动缩影上的一块：名字、开头半秒的画面与时长。 */
const faceOf = (title: string, mediaUrl: string, t0: number, t1: number): InsertionFace => ({
  title,
  durationMs: Math.round((t1 - t0) * 1000),
  media: <Frames part={{ mediaUrl, start: t0, end: Math.min(t1, t0 + 0.5) }} />,
})

/** 修剪把手落到新起止时交给谁：草稿里的一块，或原片选区。 */
type TrimEmit = (edge: Edge, range: { t0: number; t1: number }) => void

type Drag = {
  /** 拖的是哪一对把手：草稿块的 id，或原片选区的 {@link RUN_HANDLES}。 */
  key: string
  edge: Edge
  pointerId: number
  x0: number
  from: number
  pps: number
  spec: TrimSpec
  emit: TrimEmit
  /** 按下时轨道区铺了多少秒：拖动中不比它窄，免得滚到最右时内容变短、整条时间线在指针下跳。 */
  hold: number
}

const RUN_HANDLES = 'run'

/** 横向位置：`at` 起、长 `len` 秒，换算成像素交给 CSS（每秒像素 `--pps` 只由原片时长与可视宽定）。 */
const placed = (at: number, len: number, row?: number): CSSProperties =>
  ({ '--at': at, '--len': len, ...(row === undefined ? {} : { '--row': row }) }) as CSSProperties

const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.min(a1, b1) - Math.max(a0, b0) > 0.001

/** 「第 2 段 · 」：只有一段时不写。 */
const partPrefix = (part: LanePart) =>
  part.part !== undefined && part.block.state.kind === 'ready' && part.block.state.parts.length > 1
    ? `第 ${part.part.seg} 段 · `
    : ''

/**
 * 剪辑视图的时间线，三条轨自上而下：草稿（要合成的内容，按合成时间首尾相接）、原片（全部镜头，按原片时间）、
 * 编辑（编辑片段对准它的生成区间，完成的按关键帧切段）。标尺属于草稿；只有一根播放头，草稿预览时按合成时间、
 * 原片预览时按原片时间放。原片轨、编辑轨的位置只随原片变；草稿变了时只有草稿轨的块动画到新位置（见
 * `useDraftReflow`）。编辑段可以拖进草稿、草稿块可以拖出草稿，拖动的缩影、落点占位与成片页共用。
 */
export function ClipsTimeline({
  rootUrl,
  duration,
  shots,
  blocks,
  items,
  shotOn,
  isPicked,
  selection,
  clock,
  clockOn,
  peaksOf,
  onSeek,
  onScrub,
  onSelectRun,
  onTrimRun,
  onSelectDraft,
  onSelectRunning,
  onToggleShot,
  onClickPart,
  onTogglePart,
  onTrim,
  previewPick,
  selectionBoxRef,
}: ClipsTimelineProps) {
  const lanesRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const connectorRef = useRef<SVGSVGElement>(null)
  // 指针最后在哪：块重画、横向滚动之后按它重新认悬停的块（旧元素被换掉时浏览器不发离开事件）。
  const pointerRef = useRef<{ x: number; y: number }>(undefined)
  const ghostRef = useRef<InsertionGhostHandle>(null)
  const previewRef = useRef<InsertionPreviewHandle>(null)
  const baseId = useId()
  const motion = useInsertionMotion()
  const clicks = useClickAfterDrag()
  const [hover, setHover] = useState<Hover>()
  const [drag, setDrag] = useState<Drag>()
  const [carry, setCarry] = useState<Carry>()
  const total = totalOf(items)
  const bounded = Math.max(0, Math.min(clockOn === 'source' ? duration : total, clock))
  const parts = lanePartsOf(blocks)
  const rows = Math.max(1, ...blocks.map((block) => block.row + 1))
  const blockOf = (id: string) => blocks.find((block) => block.id === id)
  const partOf = (id: string) => parts.find((part) => part.id === id)
  const shotOf = (no: number) => shots.find((shot) => shot.no === no)

  // ---- 拖放预演：编辑段拖到草稿上时，草稿轨按选用后的排序给它让出位置，落点占位画在空出来的地方 ----
  const carrying = carry?.moved === true && !carry.returning ? carry : undefined
  const carryPart = carry?.from === 'part' ? partOf(carry.id) : undefined
  const carryPicked =
    carryPart?.part !== undefined && isPicked(carryPart.block.id, carryPart.part.seg)
  const projection =
    carrying?.over === true && carryPart?.part !== undefined && !carryPicked
      ? previewPick(carryPart.block.id, carryPart.part.seg)
      : undefined
  const landing = projection?.find((item) => item.id === carryPart?.id)
  const shown =
    projection === undefined || landing === undefined
      ? items
      : projection.filter((item) => item.id !== landing.id)
  const itemOf = (id: string) => shown.find((item) => item.id === id)

  const showHover = (next: Hover | undefined) =>
    setHover((current) =>
      current?.track === next?.track && current?.id === next?.id ? current : next,
    )
  const resyncHover = () => {
    const pointer = pointerRef.current
    if (pointer === undefined || carry?.moved === true) return
    showHover(hoverAt(document.elementFromPoint(pointer.x, pointer.y)))
  }
  const syncHover = useEffectEvent(resyncHover)
  // 草稿重画后按最终位置重认悬停（在重排动画开始之前，量到的是块的新位置）。
  const shownIds = shown.map((item) => item.id).join(' ')
  useLayoutEffect(() => syncHover(), [shownIds])

  // ---- 连线：草稿里的一块 ↔ 它的来源。悬停任一边，或刚开关的那一块；选中不常驻，修剪、拖放时不画 ----
  const busy = drag !== undefined || carrying !== undefined
  const hovered = hover === undefined ? undefined : itemOf(hover.id)
  const drawConnector = () => {
    const svg = connectorRef.current
    const lanes = lanesRef.current
    if (svg === null || lanes === null || pair === undefined) return
    const from =
      nodeOf(lanes, 'data-draft-id', pair.id) ?? nodeOf(lanes, 'data-leaving-id', pair.id)
    const to = nodeOf(lanes, 'data-part-id', pair.id)
    svg.style.display = from === undefined || to === undefined ? 'none' : ''
    if (from === undefined || to === undefined) return
    const box = lanes.getBoundingClientRect()
    const a = from.getBoundingClientRect()
    const b = to.getBoundingClientRect()
    // 草稿块底边中点 → 编辑段顶边中点，两个控制点都在竖直方向上
    const x1 = a.left + a.width / 2 - box.left
    const y1 = a.bottom - box.top
    const x2 = b.left + b.width / 2 - box.left
    const y2 = b.top - box.top
    const k = (y2 - y1) / 2
    svg
      .querySelector('path')
      ?.setAttribute('d', `M${x1} ${y1}C${x1} ${y1 + k} ${x2} ${y2 - k} ${x2} ${y2}`)
    const [start, end] = svg.querySelectorAll('circle')
    start?.setAttribute('cx', String(x1))
    start?.setAttribute('cy', String(y1))
    end?.setAttribute('cx', String(x2))
    end?.setAttribute('cy', String(y2))
  }

  // 轨道区铺的秒数：原片与草稿取长者；拖修剪把手期间不比按下时窄，收起动画期间不比开关前窄
  const base = Math.max(duration, total, totalOf(projection ?? []), drag?.hold ?? 0)
  const reflow = useDraftReflow({
    lanesRef,
    scrollRef,
    shown,
    committed: items,
    previewKey: landing === undefined ? '' : `${landing.id}@${landing.at}`,
    content: base,
    frozen: drag !== undefined,
    onFrame: drawConnector,
  })
  const content = Math.max(base, reflow.hold ?? 0)
  const pair: Flash | undefined = busy
    ? undefined
    : hovered !== undefined
      ? { id: hovered.id, kind: hovered.kind, out: false, fading: false }
      : reflow.flash
  useLayoutEffect(drawConnector)
  /** 此刻每秒多少像素：轨道区的实际宽度除以它铺的秒数。 */
  const ppsNow = () => {
    const width = lanesRef.current?.getBoundingClientRect().width ?? 0
    return width > 0 ? width / content : 1
  }

  // ---- 原片轨的选区：点镜头、Shift 扩选、方向键都按整镜头算，覆盖到的镜头碰到一部分也算 ----
  const order = shots.map((shot) => shot.no)
  const run = selection?.kind === 'run' ? selection : undefined
  const covered = run === undefined ? undefined : coveredSpan(shots, run)
  const chosen =
    covered === undefined ? [] : order.filter((no) => covered.from <= no && no <= covered.to)
  /** 按整镜头选中 `nos` 这一串连续的镜头。 */
  const runOf = (nos: readonly number[]): SecondsRange | undefined => {
    const first = shotOf(nos[0] ?? 0)
    const last = shotOf(nos.at(-1) ?? 0)
    return first === undefined || last === undefined
      ? undefined
      : { start: first.start, end: last.end }
  }
  const roving = useRovingFocus(
    shots.map((shot) => shotItemId(shot.no)),
    chosen[0] === undefined ? undefined : shotItemId(chosen[0]),
  )
  const clickShot = (no: number, extend: boolean) => {
    roving.remember(shotItemId(no))
    onSelectRun(runOf(extend ? shiftSelect(order, chosen, no) : [no]))
  }
  const shotKeyDown = (event: KeyboardEvent<HTMLButtonElement>, no: number) => {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : undefined
    if (direction === undefined) return
    event.preventDefault()
    const next = stepSelect(order, chosen, no, direction, event.shiftKey)
    onSelectRun(runOf(next.selection))
    roving.focus(shotItemId(next.focus))
  }

  // ---- 关联描边：悬停一边描出另一边，选中时常驻；连线的两端也描出，跟着连线淡出 ----
  // 按位置记：同一处被描两次只画一个，已有常驻描边时不再叠一层会淡出的
  const linked = new Map<string, Fade>()
  const filmMarks = new Map<string, { start: number; end: number; fade: Fade }>()
  const laneMarks = new Map<string, { part: LanePart; fade: Fade }>()
  const put = <T extends { fade: Fade }>(marks: Map<string, T>, key: string, mark: T) => {
    if (marks.get(key)?.fade !== '') marks.set(key, mark)
  }
  const markDraft = (id: string, fade: Fade = '') => {
    if (linked.get(id) !== '') linked.set(id, fade)
  }
  const markFilm = (span: { start: number; end: number }, fade: Fade = '') =>
    put(filmMarks, `${span.start}-${span.end}`, { start: span.start, end: span.end, fade })
  const markSource = (item: { id: string; kind: DraftItem['kind'] }, fade: Fade = '') => {
    const shot = item.kind === 'shot' ? shots.find((s) => shotItemId(s.no) === item.id) : undefined
    if (shot !== undefined) markFilm(shot, fade)
    const part = item.kind === 'edit' ? partOf(item.id) : undefined
    if (part !== undefined) put(laneMarks, part.id, { part, fade })
  }
  const selectedItem = selection?.kind === 'draft' ? itemOf(selection.id) : undefined
  if (selectedItem !== undefined) markSource(selectedItem)
  for (const no of chosen) markDraft(shotItemId(no))
  if (carrying !== undefined) {
    // 拖着编辑段：描出它的生成区间；已在草稿里的描出它那块（不出落点占位）
    if (carrying.over && carryPart !== undefined) {
      markFilm(carryPart.block)
      if (carryPicked) markDraft(carryPart.id)
    }
  } else if (hover?.track === 'draft') {
    if (hovered !== undefined) markSource(hovered)
  } else if (hover?.track === 'edit') {
    const part = partOf(hover.id)
    if (part?.part !== undefined) {
      markDraft(part.id)
      markFilm(part.block)
    }
  } else if (hover?.track === 'film') markDraft(hover.id)
  if (pair !== undefined) {
    const fade = fadeOf(pair)
    if (!pair.out) markDraft(pair.id, fade)
    markSource(pair, fade)
  }

  // ---- 选中描边：也是弹出卡的定位锚点 ----
  const runningPart = selection?.kind === 'running' ? partOf(selection.id) : undefined
  const ring =
    run !== undefined
      ? { track: 'is-film', style: placed(run.start, run.end - run.start) }
      : selectedItem !== undefined
        ? { track: 'is-draft', style: placed(selectedItem.at, selectedItem.d) }
        : runningPart !== undefined
          ? {
              track: 'is-edit',
              style: placed(runningPart.at, runningPart.len, runningPart.block.row),
            }
          : undefined

  // ---- 修剪把手：草稿里选中的那块，与原片轨上的选区，同一套拖动与方向键 ----
  const pressTrim = (
    event: PointerEvent<HTMLButtonElement>,
    key: string,
    spec: TrimSpec,
    edge: Edge,
    emit: TrimEmit,
  ) => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    // 开关后的重排与连线停在最终状态，拖动中不再有任何动画
    reflow.cancel()
    setDrag({
      key,
      edge,
      pointerId: event.pointerId,
      x0: event.clientX,
      from: edge === 'end' ? spec.t1 : spec.t0,
      pps: ppsNow(),
      spec,
      emit,
      hold: content,
    })
    // 按下就把舞台换到这一端的画面
    emit(edge, { t0: spec.t0, t1: spec.t1 })
  }
  const moveTrim = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag === undefined || drag.pointerId !== event.pointerId) return
    const time = drag.from + (event.clientX - drag.x0) / drag.pps
    drag.emit(drag.edge, trimTo(drag.spec, drag.edge, time, snapNear(drag.spec.snaps, drag.pps)))
  }
  const endTrim = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag === undefined || drag.pointerId !== event.pointerId) return
    releasePointer(event)
    setDrag(undefined)
  }
  const keyTrim = (
    event: KeyboardEvent<HTMLButtonElement>,
    spec: TrimSpec,
    edge: Edge,
    emit: TrimEmit,
  ) => {
    const step = arrowStep(event)
    if (step === undefined) return
    event.preventDefault()
    const current = edge === 'end' ? spec.t1 : spec.t0
    const snap = snapAhead(spec.snaps, current, step > 0 ? 1 : -1, ppsNow())
    emit(edge, trimTo(spec, edge, current + step, snap))
  }
  const pressedEdge = (key: string) => (drag?.key === key ? drag.edge : undefined)
  const draftSpec = selectedItem === undefined ? undefined : trimSpecOf(selectedItem)
  const emitDraft: TrimEmit = (edge, range) => {
    if (selectedItem !== undefined) onTrim({ id: selectedItem.id, edge, ...range })
  }
  const runSpec = run === undefined ? undefined : runTrimSpecOf(run, shots, duration)
  const emitRun: TrimEmit = (edge, { t0, t1 }) => onTrimRun({ edge, start: t0, end: t1 })

  const draftName = (item: DraftItem) => {
    if (item.kind === 'shot') return `镜头 ${item.no} · ${draftLineOf(item)}`
    const block = blockOf(item.edit.id)
    return `${block === undefined ? '编辑片段' : editTitleOf(block)} · ${draftLineOf(item)}`
  }

  // ---- 拖放：编辑段拖进草稿 = 选用，草稿块拖出草稿 = 拿掉；只改开关，不改选中 ----
  const partTitle = (block: EditBlock, seg: number) =>
    block.state.kind === 'ready' && block.state.parts.length > 1
      ? `${editTitleOf(block)} · 第 ${seg} 段`
      : editTitleOf(block)
  /** 指针在草稿轨上：轨道区看得见的横向范围内、草稿那一条的高度里。 */
  const overDraft = (x: number, y: number) => {
    const view = scrollRef.current?.getBoundingClientRect()
    const track = dropRef.current?.getBoundingClientRect()
    return (
      view !== undefined &&
      track !== undefined &&
      x >= view.left &&
      x <= view.right &&
      y >= track.top &&
      y <= track.bottom
    )
  }
  const pressCarry = (
    event: PointerEvent<HTMLButtonElement>,
    from: Carry['from'],
    id: string,
    face: InsertionFace,
  ) => {
    if (event.button !== 0 || (carry !== undefined && !carry.returning)) return
    clicks.reset()
    event.currentTarget.setPointerCapture(event.pointerId)
    const box = (event.currentTarget.parentElement ?? event.currentTarget).getBoundingClientRect()
    setCarry({
      from,
      id,
      face,
      pointerId: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      over: from === 'draft',
      origin: { left: box.left, top: box.top, width: box.width, height: box.height },
      pps: ppsNow(),
      height: dropRef.current?.getBoundingClientRect().height ?? 0,
      returning: false,
    })
  }
  const moveCarry = (event: PointerEvent<HTMLButtonElement>) => {
    if (carry === undefined || carry.pointerId !== event.pointerId || carry.returning) return
    const { clientX: x, clientY: y } = event
    if (!carry.moved && Math.hypot(x - carry.x0, y - carry.y0) <= DRAG_THRESHOLD) return
    ghostRef.current?.follow(x, y)
    const over = overDraft(x, y)
    if (!carry.moved) {
      setHover(undefined)
      reflow.cancel()
    }
    if (!carry.moved || over !== carry.over) setCarry({ ...carry, moved: true, over, x, y })
  }
  /** 松手：按显示着的落点改草稿，返回缩影飞去的地方；没改时回到原处，拿掉时不用飞。 */
  const dropCarry = (current: Carry): InsertionBox | undefined => {
    if (current.from === 'part') {
      const part = partOf(current.id)
      if (!current.over || part?.part === undefined || carryPicked) return current.origin
      const pose = previewRef.current?.snapshot()?.value
      const track = dropRef.current?.getBoundingClientRect()
      // 新块从落点占位此刻的位置落下来，缩影飞到同一处
      if (pose?.x !== undefined && pose.width !== undefined)
        reflow.land(current.id, { left: pose.x, width: pose.width })
      onTogglePart(part.block.id, part.part.seg)
      return pose === undefined || track === undefined
        ? current.origin
        : {
            left: track.left + (pose.x ?? 0),
            top: track.top + (pose.y ?? 0),
            width: pose.width ?? 0,
            height: pose.height ?? 0,
          }
    }
    const item = items.find((candidate) => candidate.id === current.id)
    if (current.over || item === undefined) return current.origin
    if (item.kind === 'shot') onToggleShot(item.no)
    else onTogglePart(item.edit.id, item.seg)
    return undefined
  }
  const endCarry = (event: PointerEvent<HTMLButtonElement>) => {
    if (carry === undefined || carry.pointerId !== event.pointerId) return
    releasePointer(event)
    if (carry.returning) return
    if (!carry.moved) {
      setCarry(undefined)
      return
    }
    clicks.swallow()
    const destination = dropCarry(carry)
    setCarry(destination === undefined ? undefined : { ...carry, returning: true, destination })
  }
  const returnCarry = () => {
    clicks.swallow()
    setCarry((current) =>
      current === undefined || current.returning
        ? current
        : { ...current, returning: true, destination: current.origin },
    )
  }
  useEscapeAheadOfDialog(carrying !== undefined, returnCarry)
  const carryPointer = (from: Carry['from'], id: string, face: () => InsertionFace) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => pressCarry(event, from, id, face()),
    onPointerMove: moveCarry,
    onPointerUp: endCarry,
    onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => {
      releasePointer(event)
      if (carry?.moved === true) returnCarry()
      else setCarry(undefined)
    },
  })
  const draftFace = (item: DraftItem) => {
    const block = item.kind === 'edit' ? blockOf(item.edit.id) : undefined
    const title =
      item.kind === 'shot'
        ? `镜头 ${item.no}`
        : block === undefined
          ? '编辑片段'
          : partTitle(block, item.seg)
    return faceOf(title, item.mediaUrl, item.t0, item.t1)
  }
  const previewPosition =
    carrying === undefined || landing === undefined
      ? undefined
      : {
          x: landing.at * carrying.pps + 1,
          y: 0,
          width: Math.max(6, landing.d * carrying.pps - 2),
          height: carrying.height,
          text: `插入 ${secondsText(landing.at)} 秒 · ${secondsText(landing.d)} 秒`,
          blocked: false,
          // 落点离轨道区右端不到提示的宽度时，提示靠右对齐
          alignEnd: (content - landing.at) * carrying.pps < 160,
        }

  return (
    <section
      aria-label="视频编辑时间线"
      className="video-editor-timeline is-clips"
      onPointerLeave={() => {
        pointerRef.current = undefined
        showHover(undefined)
      }}
      onPointerMove={(event) => {
        pointerRef.current = { x: event.clientX, y: event.clientY }
        if (carry?.moved !== true) showHover(hoverAt(event.target))
      }}
      style={{ '--edit-rows': rows } as CSSProperties}
    >
      <div aria-hidden="true" className="video-editor-timeline-heads">
        <span className="video-editor-timeline-head is-draft">
          <Icon decorative name="composite" size="sm" />
          草稿
        </span>
        <span className="video-editor-timeline-head is-film">
          <Icon decorative name="video" size="sm" />
          原片
        </span>
        <span className="video-editor-timeline-head is-edit">
          <Icon decorative name="edit-segment" size="sm" />
          编辑
        </span>
      </div>
      <span aria-hidden="true" className="video-editor-timeline-divider is-film" />
      <span aria-hidden="true" className="video-editor-timeline-divider is-edit" />
      <div
        aria-label="时间线轨道，可横向滚动"
        className="video-editor-timeline-scroll"
        onScroll={resyncHover}
        ref={scrollRef}
        role="region"
      >
        <div
          className="video-editor-timeline-lanes"
          ref={lanesRef}
          style={{ '--duration': duration, '--content': content } as CSSProperties}
        >
          <TimelineRuler
            clockAt={(clientX) => clockIn(lanesRef.current, content, clientX)}
            currentTime={bounded}
            onScrub={onScrub}
            onSeek={(time) => onSeek(Math.min(total, time))}
            scale={content}
            tickScale={duration}
            total={total}
            viewportRef={scrollRef}
          />

          <div aria-label="草稿" className="video-editor-timeline-track" role="group">
            {shown.map((item) => (
              <div
                className="video-editor-timeline-block is-draft"
                data-draft-id={item.id}
                data-hover-id={item.id}
                data-hover-track="draft"
                data-linked={linked.get(item.id)}
                key={item.id}
                style={placed(item.at, item.d)}
              >
                <button
                  aria-label={draftName(item)}
                  aria-pressed={selection?.kind === 'draft' && selection.id === item.id}
                  className="video-editor-timeline-face ui-focus ui-focus-inline"
                  onClick={() => {
                    if (!clicks.take()) onSelectDraft(item.id)
                  }}
                  type="button"
                  {...carryPointer('draft', item.id, () => draftFace(item))}
                >
                  <DraftFace item={item} peaksOf={peaksOf} />
                </button>
              </div>
            ))}
            {/* 拿掉的块：在原地收起后消失，不能点 */}
            {reflow.leaving.map((item) => (
              <div
                aria-hidden="true"
                className="video-editor-timeline-block is-draft is-leaving"
                data-leaving-id={item.id}
                data-linked={pair?.out === true && pair.id === item.id ? 'out' : undefined}
                key={item.id}
                style={placed(item.at, item.d)}
              >
                <span className="video-editor-timeline-face">
                  <DraftFace item={item} peaksOf={peaksOf} />
                </span>
              </div>
            ))}
          </div>
          <div className="video-editor-timeline-drop" ref={dropRef}>
            <InsertionPreview
              elementRef={previewRef}
              face={carrying?.face}
              motion={motion}
              position={previewPosition}
            />
          </div>

          <div aria-label="原片" className="video-editor-timeline-track" role="group">
            {shots.map((shot) => {
              const id = shotItemId(shot.no)
              const on = shotOn(shot.no)
              const toggle = `${on ? '关闭' : '开启'}镜头 ${shot.no}`
              return (
                <div
                  className={cn('video-editor-timeline-block is-film', !on && 'is-off')}
                  data-hover-id={id}
                  data-hover-track="film"
                  key={id}
                  style={placed(shot.start, shot.end - shot.start)}
                >
                  <button
                    aria-label={`镜头 ${shot.no} · ${roundSeconds(shot.start)}–${roundSeconds(shot.end)} 秒`}
                    aria-pressed={chosen.includes(shot.no)}
                    className="video-editor-timeline-face ui-focus ui-focus-inline"
                    onClick={(event) => clickShot(shot.no, event.shiftKey)}
                    onFocus={() => roving.remember(id)}
                    onKeyDown={(event) => shotKeyDown(event, shot.no)}
                    ref={roving.register(id)}
                    tabIndex={roving.tabIndexOf(id)}
                    type="button"
                  >
                    <Faces
                      end={shot.end}
                      mediaUrl={rootUrl}
                      peaks={peaksOf(rootUrl)}
                      start={shot.start}
                    />
                    <span aria-hidden="true" className="video-editor-timeline-no">
                      {shot.no}
                    </span>
                  </button>
                  <Eye label={toggle} on={on} onToggle={() => onToggleShot(shot.no)} />
                </div>
              )
            })}
          </div>

          <div aria-label="编辑片段" className="video-editor-timeline-track" role="group">
            {shots.map((shot) =>
              parts.some(
                (part) =>
                  part.block.row === 0 &&
                  overlap(part.at, part.at + part.len, shot.start, shot.end),
              ) ? null : (
                <button
                  aria-label={`生成镜头 ${shot.no}`}
                  className="video-editor-timeline-slot ui-focus"
                  key={`slot-${shot.no}`}
                  onClick={(event) => clickShot(shot.no, event.shiftKey)}
                  style={placed(shot.start, shot.end - shot.start)}
                  tabIndex={-1}
                  type="button"
                >
                  <Icon decorative name="add" size="xs" />
                  生成
                </button>
              ),
            )}
            {parts.map((part, index) => {
              const seg = part.part
              const url = part.block.job.outputUrl
              return (
                <LaneBlock
                  key={part.id}
                  nameId={`${baseId}-part-${index}`}
                  onClickPart={(editId, at) => {
                    if (!clicks.take()) onClickPart(editId, at)
                  }}
                  onSelectRunning={onSelectRunning}
                  onTogglePart={onTogglePart}
                  part={part}
                  peaksOf={peaksOf}
                  picked={seg !== undefined && isPicked(part.block.id, seg.seg)}
                  pointer={
                    seg === undefined || url === null
                      ? undefined
                      : carryPointer('part', part.id, () =>
                          faceOf(partTitle(part.block, seg.seg), url, seg.b0, seg.b1),
                        )
                  }
                  prefix={partPrefix(part)}
                  selected={selection?.kind === 'running' && selection.id === part.id}
                />
              )
            })}
          </div>

          {[...filmMarks].map(([key, mark]) => (
            <span
              aria-hidden="true"
              className={cn('video-editor-timeline-link is-film', fadeClass(mark.fade))}
              data-testid="timeline-link"
              key={key}
              style={placed(mark.start, mark.end - mark.start)}
            />
          ))}
          {[...laneMarks.values()].map(({ part, fade }) => (
            <span
              aria-hidden="true"
              className={cn('video-editor-timeline-link is-edit', fadeClass(fade))}
              data-testid="timeline-link"
              key={part.id}
              style={placed(part.at, part.len, part.block.row)}
            />
          ))}
          {pair?.kind === 'edit' ? (
            <svg
              aria-hidden="true"
              className={cn('video-editor-timeline-connector', fadeClass(fadeOf(pair)))}
              data-testid="timeline-connector"
              ref={connectorRef}
            >
              <path />
              <circle r={2} />
              <circle r={2} />
            </svg>
          ) : null}

          {ring === undefined ? null : (
            <span
              aria-hidden="true"
              className={cn('video-editor-timeline-box', ring.track)}
              data-follows={ring.track === 'is-draft' ? selectedItem?.id : undefined}
              ref={selectionBoxRef}
              style={ring.style}
            />
          )}

          {selectedItem === undefined || draftSpec === undefined ? null : (
            <span
              className="video-editor-timeline-trim is-draft"
              data-follows={selectedItem.id}
              key={selectedItem.id}
              style={placed(selectedItem.at, selectedItem.d)}
            >
              <TrimPair
                onKeyDown={(event, edge) => keyTrim(event, draftSpec, edge, emitDraft)}
                onPointerDown={(event, edge) =>
                  pressTrim(event, selectedItem.id, draftSpec, edge, emitDraft)
                }
                onPointerEnd={endTrim}
                onPointerMove={moveTrim}
                pressed={pressedEdge(selectedItem.id)}
                spec={draftSpec}
                valueText={draftLineOf(selectedItem)}
              />
            </span>
          )}

          {run === undefined || covered === undefined || runSpec === undefined ? null : (
            <span
              className="video-editor-timeline-trim is-film"
              key={RUN_HANDLES}
              style={placed(run.start, run.end - run.start)}
            >
              <TrimPair
                onKeyDown={(event, edge) => keyTrim(event, runSpec, edge, emitRun)}
                onPointerDown={(event, edge) =>
                  pressTrim(event, RUN_HANDLES, runSpec, edge, emitRun)
                }
                onPointerEnd={endTrim}
                onPointerMove={moveTrim}
                pressed={pressedEdge(RUN_HANDLES)}
                spec={runSpec}
                valueText={`${spanName(covered)} · 原片 ${secondsText(run.start)} – ${secondsText(run.end)} 秒`}
              />
            </span>
          )}

          <TimelinePlayhead style={{ left: `${(bounded / content) * 100}%` }} />
        </div>
      </div>
      {carry?.moved === true ? (
        <InsertionGhost
          blocked={carry.from === 'part' ? !carry.over || carryPicked : carry.over}
          clientX={carry.x}
          clientY={carry.y}
          destination={carry.returning ? carry.destination : undefined}
          face={carry.face}
          motion={motion}
          onRest={() => {
            if (carry.returning) setCarry((current) => (current === carry ? undefined : current))
          }}
          ref={ghostRef}
        />
      ) : null}
    </section>
  )
}

/** 草稿里一块的样子：画面、原声与原声行左端的镜头号（编辑段是 wand 图标）。 */
function DraftFace({ item, peaksOf }: { item: DraftItem; peaksOf: (url: string) => PeaksState }) {
  return (
    <>
      <Faces
        end={item.t1}
        mediaUrl={item.mediaUrl}
        peaks={peaksOf(item.mediaUrl)}
        start={item.t0}
      />
      <span aria-hidden="true" className="video-editor-timeline-no">
        {item.kind === 'shot' ? item.no : <Icon decorative name="edit-segment" size="xs" />}
      </span>
    </>
  )
}

type TrimPairProps = {
  spec: TrimSpec
  valueText: string
  /** 正按着的那一端。 */
  pressed: Edge | undefined
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, edge: Edge) => void
  onPointerDown: (event: PointerEvent<HTMLButtonElement>, edge: Edge) => void
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerEnd: (event: PointerEvent<HTMLButtonElement>) => void
}

/** 一对修剪把手，放在按起止摆好的容器两端：草稿里选中的那块与原片选区共用。 */
function TrimPair({
  spec,
  valueText,
  pressed,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
}: TrimPairProps) {
  return (['start', 'end'] as const).map((edge) => (
    <TrimHandle
      bounds={
        edge === 'start'
          ? { min: spec.lo, max: spec.t1 - spec.min }
          : { min: spec.t0 + spec.min, max: spec.hi }
      }
      edge={edge}
      key={edge}
      onKeyDown={(event) => onKeyDown(event, edge)}
      onPointerCancel={onPointerEnd}
      onPointerDown={(event) => onPointerDown(event, edge)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      pressed={pressed === edge}
      style={edge === 'start' ? { left: 0 } : { left: '100%' }}
      value={edge === 'start' ? spec.t0 : spec.t1}
      valueText={valueText}
    />
  ))
}

type EyeProps = { label: string; on: boolean; onToggle: () => void }

/** 原声行右端的小眼睛：开关这一块在不在草稿里，永远能点，不改选中。 */
function Eye({ label, on, onToggle }: EyeProps) {
  return (
    <span className="video-editor-timeline-eye">
      <button
        aria-label={label}
        aria-pressed={on}
        className="timeline-toggle"
        onClick={onToggle}
        title={label}
        type="button"
      >
        <Icon decorative name={on ? 'included' : 'excluded'} size="xs" />
      </button>
    </span>
  )
}

type LaneBlockProps = {
  part: LanePart
  prefix: string
  picked: boolean
  selected: boolean
  /** 这一段的名字挂在哪个 id 上：这一块按它成组，眼睛的「选用这一段」就有了归属。 */
  nameId: string
  peaksOf: (url: string) => PeaksState
  /** 完成的一段按住可以拖进草稿。 */
  pointer:
    | {
        onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void
        onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void
        onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void
        onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void
      }
    | undefined
  onClickPart: (editId: string, seg: number) => void
  onTogglePart: (editId: string, seg: number) => void
  onSelectRunning: (id: string) => void
}

/** 编辑轨上的一块：完成的一段（点它或它的眼睛选用、取消，按住拖进草稿），或在跑、读取中、读不出的整条。 */
function LaneBlock({
  part,
  prefix,
  picked,
  selected,
  nameId,
  peaksOf,
  pointer,
  onClickPart,
  onTogglePart,
  onSelectRunning,
}: LaneBlockProps) {
  const { block } = part
  const style = placed(part.at, part.len, block.row)
  const { kind } = block.state
  if (kind === 'running')
    return (
      <button
        aria-label={`${block.name} · 生成中`}
        aria-pressed={selected}
        className="video-editor-timeline-block is-edit is-running ui-focus"
        data-hover-id={part.id}
        data-hover-track="edit"
        onClick={() => onSelectRunning(part.id)}
        style={style}
        type="button"
      >
        <span className="video-editor-timeline-status">
          <Icon decorative name="sparkles" size="xs" />
          生成中
        </span>
      </button>
    )
  if (part.part === undefined || block.job.outputUrl === null)
    return (
      <span
        className={cn(
          'video-editor-timeline-block is-edit',
          kind === 'unreadable' ? 'is-failed' : 'is-running',
        )}
        style={style}
      >
        <span className="video-editor-timeline-status">
          <Icon decorative name={kind === 'unreadable' ? 'alert' : 'sparkles'} size="xs" />
          {block.name} · {kind === 'unreadable' ? '无法读取' : '读取中'}
        </span>
      </span>
    )
  const { seg, b0, b1 } = part.part
  const url = block.job.outputUrl
  return (
    <div
      aria-labelledby={nameId}
      className={cn('video-editor-timeline-block is-edit', !picked && 'is-off')}
      data-hover-id={part.id}
      data-hover-track="edit"
      data-part-id={part.id}
      role="group"
      style={style}
    >
      <button
        aria-label={`${editTitleOf(block)} · ${prefix}${secondsText(b1 - b0)} 秒`}
        className="video-editor-timeline-face ui-focus ui-focus-inline"
        id={nameId}
        onClick={() => onClickPart(block.id, seg)}
        // 键盘用它的眼睛开关，这里只是鼠标的另一个入口
        tabIndex={-1}
        type="button"
        {...pointer}
      >
        <Faces end={b1} mediaUrl={url} peaks={peaksOf(url)} start={b0} />
      </button>
      <Eye
        label={picked ? '取消选用这一段' : '选用这一段'}
        on={picked}
        onToggle={() => onTogglePart(block.id, seg)}
      />
    </div>
  )
}

/** 版本视图里的一版：画面按它自己的关键帧分块。 */
export type VersionRow = {
  jobId: string
  /** 轨头写的版本名，如「V2」「V1 原片」。 */
  label: string
  original: boolean
  mediaUrl: string
  /** 关键帧还没读到（或读不出）时为 undefined，这一行先空着。 */
  shots: readonly Shot[] | undefined
  duration: number | undefined
}

type VersionsTimelineProps = {
  /** 按完成先后排；画出来最新的在最上。 */
  versions: readonly VersionRow[]
  /** 正在合成的那一版：请求里各段的总长（秒），算不出时为 undefined；没在合成时不给。 */
  composing: { duration: number | undefined } | undefined
  viewedId: string
  /** 正在看的那一版的播放头。 */
  currentTime: number
  peaksOf: (url: string) => PeaksState
  onSelect: (jobId: string) => void
  onSeek: (clock: number) => void
  onScrub: () => void
}

/**
 * 版本视图的时间线：每个版本一行，各行共用最长那一版的比例；点一行看那一版，只能在标尺上定位。
 * 行多了在下面纵向滚动，标尺与播放头留在顶上。
 */
export function VersionsTimeline({
  versions,
  composing,
  viewedId,
  currentTime,
  peaksOf,
  onSelect,
  onSeek,
  onScrub,
}: VersionsTimelineProps) {
  const rulerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rows = versions.toReversed()
  const ids = rows.map((row) => row.jobId)
  const roving = useRovingFocus(ids, viewedId)
  const scale = Math.max(0, ...versions.map((row) => row.duration ?? 0), composing?.duration ?? 0)
  const total = versions.find((row) => row.jobId === viewedId)?.duration
  const bounded = Math.max(0, Math.min(total ?? 0, currentTime))
  // 比例读到时长才有：一版都没读到时各行空着、不画标尺；看的那一版没读到时标尺不能拖。
  const percent = (time: number) => `${(time / scale) * 100}%`
  const span = (start: number, end: number): CSSProperties => ({
    left: `calc(${percent(start)} + 1px)`,
    width: `calc(${percent(end - start)} - 2px)`,
  })

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, jobId: string) => {
    // 空格在编辑器里是播放；在行上是选中这一版，拦下来不让它再去播放。
    if (event.key === ' ') {
      event.preventDefault()
      onSelect(jobId)
      return
    }
    const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : undefined
    if (direction === undefined) return
    event.preventDefault()
    const next = ids[ids.indexOf(jobId) + direction]
    if (next !== undefined) roving.focus(next)
  }

  return (
    <section
      aria-label="视频编辑时间线"
      className="video-editor-timeline is-versions"
      style={{ '--version-rows': rows.length + (composing === undefined ? 0 : 1) } as CSSProperties}
    >
      <div className="video-editor-versions-scroll" ref={scrollRef}>
        <div className="video-editor-versions-header">
          <div className="video-editor-versions-ruler" ref={rulerRef}>
            {scale === 0 ? null : (
              <>
                <TimelineRuler
                  clockAt={(clientX) => clockIn(rulerRef.current, scale, clientX)}
                  currentTime={bounded}
                  disabled={total === undefined}
                  onScrub={onScrub}
                  onSeek={onSeek}
                  scale={scale}
                  total={total ?? 0}
                  viewportRef={scrollRef}
                />
                <TimelinePlayhead style={{ left: percent(bounded) }} />
              </>
            )}
          </div>
        </div>
        <div aria-label="视频版本" className="video-editor-versions-rows" role="group">
          {composing === undefined ? null : (
            <button aria-label="合成中" className="video-editor-version-row" disabled type="button">
              <span className="video-editor-version-head">
                <Icon decorative name="composite" size="sm" />
                合成中
              </span>
              <span className="video-editor-version-lane">
                <span
                  className="video-editor-timeline-block is-running"
                  style={
                    composing.duration === undefined || scale === 0
                      ? { left: '1px', width: 'calc(100% - 2px)' }
                      : span(0, composing.duration)
                  }
                />
              </span>
            </button>
          )}
          {rows.map((row) => (
            <button
              aria-label={row.label}
              aria-pressed={row.jobId === viewedId}
              className="video-editor-version-row ui-focus"
              key={row.jobId}
              onClick={() => {
                roving.remember(row.jobId)
                onSelect(row.jobId)
              }}
              onFocus={() => roving.remember(row.jobId)}
              onKeyDown={(event) => keyDown(event, row.jobId)}
              ref={roving.register(row.jobId)}
              tabIndex={roving.tabIndexOf(row.jobId)}
              type="button"
            >
              <span className="video-editor-version-head">
                <Icon decorative name={row.original ? 'video' : 'composite'} size="sm" />
                {row.label}
              </span>
              <span className="video-editor-version-lane">
                {row.shots?.map((shot) => (
                  <span
                    className="video-editor-timeline-block"
                    key={shot.no}
                    style={span(shot.start, shot.end)}
                  >
                    <Faces
                      end={shot.end}
                      mediaUrl={row.mediaUrl}
                      peaks={peaksOf(row.mediaUrl)}
                      start={shot.start}
                    />
                  </span>
                ))}
                {row.jobId === viewedId && row.duration !== undefined ? (
                  <span className="video-editor-timeline-box" style={span(0, row.duration)} />
                ) : null}
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
