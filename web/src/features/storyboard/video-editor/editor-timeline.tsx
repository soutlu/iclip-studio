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
import type { TimeSpan } from '@/shared/lib/time-spans'
import { cn } from '@/shared/lib/utils'
import { useEscapeAheadOfDialog } from '@/shared/ui/dialog'
import type { SecondsRange } from '../editing/clip'
import type { PeaksState } from '../editing/media-analysis'
import { trimSpans, usePreviewGesture, type TrimTarget } from '../editing/preview-gesture'
import { shiftSelect, stepSelect } from '../editing/range-select'
import { roundSeconds } from '../editing/time-label'
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
import { TRIM_LIMIT_TEXT } from '../editing/trim-limit'
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

const clockIn = (lanes: HTMLElement | null, scale: number, clientX: number) => {
  const bounds = lanes?.getBoundingClientRect()
  if (bounds === undefined || bounds.width === 0) return 0
  return Math.min(scale, Math.max(0, ((clientX - bounds.left) / bounds.width) * scale))
}

export type Selection =
  | ({ kind: 'run' } & SecondsRange)
  | { kind: 'draft'; id: string }
  | { kind: 'running'; id: string }
  | undefined

export type TrimChange = { id: string; edge: Edge; t0: number; t1: number }

export type RunChange = SecondsRange & { edge: Edge }

type Seek = { clock: number; boundary?: 'end' }

export type TrimPreview =
  | { kind: 'draft'; items: readonly DraftItem[]; seek: Seek; shown: number }
  | { kind: 'run'; run: RunChange; seek: Seek; shown: number }

type ClipsTimelineProps = {
  rootUrl: string
  duration: number
  shots: readonly Shot[]
  blocks: readonly EditBlock[]
  items: readonly DraftItem[]
  shotOn: (no: number) => boolean
  isPicked: (editId: string, seg: number) => boolean
  selection: Selection
  clock: number
  clockOn: 'draft' | 'source'
  buffered: readonly TimeSpan[]
  peaksOf: (url: string) => PeaksState
  onSeek: (clock: number) => void
  onScrub: () => void
  onSelectRun: (run: SecondsRange | undefined) => void
  onTrimRun: (change: RunChange) => void
  onSelectDraft: (id: string) => void
  onSelectRunning: (id: string) => void
  onToggleShot: (no: number) => void
  onClickPart: (editId: string, seg: number) => void
  onTogglePart: (editId: string, seg: number) => void
  onTrim: (change: TrimChange) => void
  previewTrim: (change: TrimChange) => readonly DraftItem[]
  onTrimPreview: (preview: TrimPreview | undefined) => void
  previewPick: (editId: string, seg: number) => readonly DraftItem[] | undefined
  selectionBoxRef: Ref<HTMLSpanElement>
}

type Hover = { track: 'draft' | 'film' | 'edit'; id: string }

const hoverAt = (target: EventTarget | null): Hover | undefined => {
  const node = target instanceof Element ? target.closest<HTMLElement>('[data-hover-track]') : null
  const track = node?.dataset['hoverTrack']
  const id = node?.dataset['hoverId']
  return (track === 'draft' || track === 'film' || track === 'edit') && id !== undefined
    ? { track, id }
    : undefined
}

type Carry = {
  from: 'part' | 'draft'
  id: string
  face: InsertionFace
  pointerId: number
  x0: number
  y0: number
  x: number
  y: number
  moved: boolean
  over: boolean
  origin: InsertionBox
  pps: number
  height: number
  returning: boolean
  destination?: InsertionBox | undefined
}

type Fade = '' | 'fading' | 'out'

const fadeOf = (flash: Flash | undefined): Fade =>
  flash === undefined ? '' : flash.out ? 'out' : flash.fading ? 'fading' : ''

const fadeClass = (fade: Fade) => cn(fade !== '' && 'is-fading', fade === 'out' && 'is-out')

const nodeOf = (lanes: HTMLElement, attribute: string, value: string) =>
  [...lanes.querySelectorAll<HTMLElement>(`[${attribute}]`)].find(
    (node) => node.getAttribute(attribute) === value,
  )

const faceOf = (title: string, mediaUrl: string, t0: number, t1: number): InsertionFace => ({
  title,
  durationMs: Math.round((t1 - t0) * 1000),
  media: <Frames part={{ mediaUrl, start: t0, end: Math.min(t1, t0 + 0.5) }} />,
})

type Range = { t0: number; t1: number }

type TrimStep =
  | { kind: 'draft'; change: TrimChange; items: readonly DraftItem[]; limit: string | undefined }
  | { kind: 'run'; change: RunChange }

type Pressed = {
  key: string
  edge: Edge
  content: number
}

const RUN_HANDLES = 'run'

const EDGE_EPSILON = 0.001

const trimLimitOf = (spec: TrimSpec, edge: Edge, time: number) => {
  const shortest =
    edge === 'start'
      ? time > spec.t1 - spec.min + EDGE_EPSILON
      : time < spec.t0 + spec.min - EDGE_EPSILON
  if (shortest) return TRIM_LIMIT_TEXT.shortest(spec.min)
  const outside = edge === 'start' ? time < spec.lo - EDGE_EPSILON : time > spec.hi + EDGE_EPSILON
  return outside ? TRIM_LIMIT_TEXT[edge] : undefined
}

const seekTo = (edge: Edge, clock: number): Seek =>
  edge === 'end' ? { clock, boundary: 'end' } : { clock }

const itemIn = (items: readonly DraftItem[], id: string) => {
  const item = items.find((candidate) => candidate.id === id)
  if (item === undefined) throw new Error('草稿里缺少被修剪的块')
  return item
}

const draftTrimOf = (
  step: Extract<TrimStep, { kind: 'draft' }>,
  committed: readonly DraftItem[],
) => {
  const { id, edge } = step.change
  const item = itemIn(committed, id)
  const trimmed = itemIn(step.items, id)
  const spans = trimSpans(edge, { at: item.at, len: item.d }, trimmed.d)
  const face: DraftItem = {
    ...item,
    t0: Math.min(item.t0, trimmed.t0),
    t1: Math.max(item.t1, trimmed.t1),
    at: spans.block.at,
    d: spans.block.len,
  }
  return { id, edge, face, ...spans }
}

const trimPreviewOf = (step: TrimStep, committed: readonly DraftItem[]): TrimPreview => {
  if (step.kind === 'run') {
    const { edge, start, end } = step.change
    const clock = edge === 'end' ? end : start
    return { kind: 'run', run: step.change, seek: seekTo(edge, clock), shown: clock }
  }
  const { edge, kept } = draftTrimOf(step, committed)
  const trimmed = itemIn(step.items, step.change.id)
  return {
    kind: 'draft',
    items: step.items,
    seek: seekTo(edge, edge === 'end' ? trimmed.at + trimmed.d : trimmed.at),
    shown: edge === 'end' ? kept.at + kept.len : kept.at,
  }
}

const placed = (at: number, len: number, row?: number): CSSProperties =>
  ({ '--at': at, '--len': len, ...(row === undefined ? {} : { '--row': row }) }) as CSSProperties

const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.min(a1, b1) - Math.max(a0, b0) > 0.001

const partPrefix = (part: LanePart) =>
  part.part !== undefined && part.block.state.kind === 'ready' && part.block.state.parts.length > 1
    ? `第 ${part.part.seg} 段 · `
    : ''

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
  buffered,
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
  previewTrim,
  onTrimPreview,
  previewPick,
  selectionBoxRef,
}: ClipsTimelineProps) {
  const lanesRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const connectorRef = useRef<SVGSVGElement>(null)
  const pointerRef = useRef<{ x: number; y: number }>(undefined)
  const ghostRef = useRef<InsertionGhostHandle>(null)
  const previewRef = useRef<InsertionPreviewHandle>(null)
  const baseId = useId()
  const motion = useInsertionMotion()
  const clicks = useClickAfterDrag()
  const [hover, setHover] = useState<Hover>()
  const [pressed, setPressed] = useState<Pressed>()
  const [carry, setCarry] = useState<Carry>()
  const trimGesture = usePreviewGesture<TrimStep>({
    containerRef: lanesRef,
    viewportRef: scrollRef,
    clicks,
    onCommit: (last) => (last.kind === 'draft' ? onTrim(last.change) : onTrimRun(last.change)),
    onPreview: (preview) => {
      onTrimPreview(preview === null ? undefined : trimPreviewOf(preview.last, items))
      if (preview?.last.kind !== 'draft') return
      const reached = totalOf(preview.last.items)
      setPressed((current) =>
        current === undefined || current.content >= reached
          ? current
          : { ...current, content: reached },
      )
    },
    onEnd: () => setPressed(undefined),
  })
  const trimming = trimGesture.preview?.last
  const draftTrim = trimming?.kind === 'draft' ? draftTrimOf(trimming, items) : undefined
  const trimStep = trimGesture.preview?.step
  const trimLimit = trimStep?.kind === 'draft' ? trimStep.limit : undefined
  const total = totalOf(items)
  const bounded = Math.max(0, Math.min(clockOn === 'source' ? duration : total, clock))
  const parts = lanePartsOf(blocks)
  const rows = Math.max(1, ...blocks.map((block) => block.row + 1))
  const blockOf = (id: string) => blocks.find((block) => block.id === id)
  const partOf = (id: string) => parts.find((part) => part.id === id)
  const shotOf = (no: number) => shots.find((shot) => shot.no === no)

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
  const playheadAt =
    draftTrim === undefined
      ? bounded
      : draftTrim.edge === 'end'
        ? draftTrim.kept.at + draftTrim.kept.len
        : draftTrim.kept.at
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
  const shownIds = shown.map((item) => item.id).join(' ')
  useLayoutEffect(() => syncHover(), [shownIds])

  const busy = pressed !== undefined || carrying !== undefined
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

  const base = Math.max(
    duration,
    total,
    totalOf(projection ?? []),
    trimming?.kind === 'draft' ? totalOf(trimming.items) : 0,
    pressed?.content ?? 0,
  )
  const reflow = useDraftReflow({
    lanesRef,
    scrollRef,
    shown,
    committed: items,
    previewKey: landing === undefined ? '' : `${landing.id}@${landing.at}`,
    content: base,
    frozen: pressed !== undefined,
    onFrame: drawConnector,
  })
  const content = Math.max(base, reflow.hold ?? 0)
  const pair: Flash | undefined = busy
    ? undefined
    : hovered !== undefined
      ? { id: hovered.id, kind: hovered.kind, out: false, fading: false }
      : reflow.flash
  useLayoutEffect(drawConnector)
  const ppsNow = () => {
    const width = lanesRef.current?.getBoundingClientRect().width ?? 0
    return width > 0 ? width / content : 1
  }

  const order = shots.map((shot) => shot.no)
  const run: SecondsRange | undefined =
    trimming?.kind === 'run'
      ? { start: trimming.change.start, end: trimming.change.end }
      : selection?.kind === 'run'
        ? selection
        : undefined
  const covered = run === undefined ? undefined : coveredSpan(shots, run)
  const chosen =
    covered === undefined ? [] : order.filter((no) => covered.from <= no && no <= covered.to)
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

  const runningPart = selection?.kind === 'running' ? partOf(selection.id) : undefined
  const keptSpan =
    selectedItem === undefined
      ? undefined
      : (draftTrim?.kept ?? { at: selectedItem.at, len: selectedItem.d })
  const ring =
    run !== undefined
      ? { track: 'is-film', style: placed(run.start, run.end - run.start) }
      : keptSpan !== undefined
        ? { track: 'is-draft', style: placed(keptSpan.at, keptSpan.len) }
        : runningPart !== undefined
          ? {
              track: 'is-edit',
              style: placed(runningPart.at, runningPart.len, runningPart.block.row),
            }
          : undefined

  const pressTrim = (
    event: PointerEvent<HTMLButtonElement>,
    key: string,
    spec: TrimSpec,
    edge: Edge,
    stepOf: (range: Range, time: number) => TrimStep,
    target?: TrimTarget,
  ) => {
    if (event.button !== 0) return
    reflow.cancel()
    const pps = ppsNow()
    const from = edge === 'end' ? spec.t1 : spec.t0
    const compute = (deltaPx: number) => {
      const time = from + deltaPx / pps
      return stepOf(trimTo(spec, edge, time, snapNear(spec.snaps, pps)), time)
    }
    if (target === undefined) {
      event.stopPropagation()
      trimGesture.start(event, compute)
    } else trimGesture.startTrim(event, target, compute)
    setPressed({ key, edge, content })
    onTrimPreview(trimPreviewOf(stepOf({ t0: spec.t0, t1: spec.t1 }, from), items))
  }
  const keyTrim = (
    event: KeyboardEvent<HTMLButtonElement>,
    spec: TrimSpec,
    edge: Edge,
    commit: (range: Range) => void,
  ) => {
    const step = arrowStep(event)
    if (step === undefined) return
    event.preventDefault()
    const current = edge === 'end' ? spec.t1 : spec.t0
    const snap = snapAhead(spec.snaps, current, step > 0 ? 1 : -1, ppsNow())
    commit(trimTo(spec, edge, current + step, snap))
  }
  const pressedEdge = (key: string) => (pressed?.key === key ? pressed.edge : undefined)
  const draftSpec = selectedItem === undefined ? undefined : trimSpecOf(selectedItem)
  const handleItem =
    selectedItem !== undefined && trimming?.kind === 'draft'
      ? (trimming.items.find((item) => item.id === selectedItem.id) ?? selectedItem)
      : selectedItem
  const draftStep = (
    id: string,
    spec: TrimSpec,
    edge: Edge,
    range: Range,
    time: number,
  ): TrimStep => {
    const change = { id, edge, ...range }
    return {
      kind: 'draft',
      change,
      items: previewTrim(change),
      limit: trimLimitOf(spec, edge, time),
    }
  }
  const runSpec = run === undefined ? undefined : runTrimSpecOf(run, shots, duration)
  const runChange = (edge: Edge, { t0, t1 }: Range): RunChange => ({ edge, start: t0, end: t1 })

  const draftName = (item: DraftItem) => {
    if (item.kind === 'shot') return `镜头 ${item.no} · ${draftLineOf(item)}`
    const block = blockOf(item.edit.id)
    return `${block === undefined ? '编辑片段' : editTitleOf(block)} · ${draftLineOf(item)}`
  }

  const partTitle = (block: EditBlock, seg: number) =>
    block.state.kind === 'ready' && block.state.parts.length > 1
      ? `${editTitleOf(block)} · 第 ${seg} 段`
      : editTitleOf(block)
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
  const dropCarry = (current: Carry): InsertionBox | undefined => {
    if (current.from === 'part') {
      const part = partOf(current.id)
      if (!current.over || part?.part === undefined || carryPicked) return current.origin
      const pose = previewRef.current?.snapshot()?.value
      const track = dropRef.current?.getBoundingClientRect()
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
            buffered={buffered}
            clockAt={(clientX) => clockIn(lanesRef.current, content, clientX)}
            currentTime={playheadAt}
            onScrub={onScrub}
            onSeek={(time) => onSeek(Math.min(total, time))}
            scale={content}
            tickScale={duration}
            total={total}
            viewportRef={scrollRef}
          />

          <div aria-label="草稿" className="video-editor-timeline-track" role="group">
            {shown.map((item) => {
              const face = draftTrim?.id === item.id ? draftTrim.face : item
              return (
                <div
                  className={cn(
                    'video-editor-timeline-block is-draft',
                    face !== item && 'is-trimming',
                  )}
                  data-draft-id={item.id}
                  data-hover-id={item.id}
                  data-hover-track="draft"
                  data-linked={linked.get(item.id)}
                  data-slide={`draft:${item.id}`}
                  key={item.id}
                  style={placed(face.at, face.d)}
                >
                  <button
                    aria-label={draftName(item)}
                    aria-pressed={selectedItem?.id === item.id}
                    className="video-editor-timeline-face ui-focus ui-focus-inline"
                    onClick={() => {
                      if (!clicks.take()) onSelectDraft(item.id)
                    }}
                    type="button"
                    {...carryPointer('draft', item.id, () => draftFace(item))}
                  >
                    <DraftFace item={face} peaksOf={peaksOf} />
                  </button>
                </div>
              )
            })}
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
          {draftTrim?.cut === undefined ? null : (
            <span
              aria-hidden="true"
              className="timeline-trim-cut video-editor-timeline-cut"
              data-testid="trim-cut"
              style={placed(draftTrim.cut.at, draftTrim.cut.len)}
            />
          )}
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
                  className={cn(
                    'video-editor-timeline-block is-film',
                    !on && 'is-off timeline-dimmed',
                  )}
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
              data-slide={ring.track === 'is-draft' ? 'ring' : undefined}
              ref={selectionBoxRef}
              style={ring.style}
            />
          )}

          {selectedItem === undefined ||
          handleItem === undefined ||
          keptSpan === undefined ||
          draftSpec === undefined ? null : (
            <span
              className="video-editor-timeline-trim is-draft"
              data-follows={selectedItem.id}
              data-slide="trim"
              key={selectedItem.id}
              style={placed(keptSpan.at, keptSpan.len)}
            >
              <TrimPair
                onKeyDown={(event, edge) =>
                  keyTrim(event, draftSpec, edge, (range) =>
                    onTrim({ id: selectedItem.id, edge, ...range }),
                  )
                }
                onPointerCancel={trimGesture.cancel}
                onPointerDown={(event, edge) =>
                  pressTrim(
                    event,
                    selectedItem.id,
                    draftSpec,
                    edge,
                    (range, time) => draftStep(selectedItem.id, draftSpec, edge, range, time),
                    { slide: `draft:${selectedItem.id}`, edge },
                  )
                }
                onPointerMove={trimGesture.move}
                onPointerUp={trimGesture.end}
                pressed={pressedEdge(selectedItem.id)}
                spec={trimSpecOf(handleItem)}
                valueText={draftLineOf(handleItem)}
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
                onKeyDown={(event, edge) =>
                  keyTrim(event, runSpec, edge, (range) => onTrimRun(runChange(edge, range)))
                }
                onPointerCancel={trimGesture.cancel}
                onPointerDown={(event, edge) =>
                  pressTrim(event, RUN_HANDLES, runSpec, edge, (range) => ({
                    kind: 'run',
                    change: runChange(edge, range),
                  }))
                }
                onPointerMove={trimGesture.move}
                onPointerUp={trimGesture.end}
                pressed={pressedEdge(RUN_HANDLES)}
                spec={runSpec}
                valueText={`${spanName(covered)} · 原片 ${secondsText(run.start)} – ${secondsText(run.end)} 秒`}
              />
            </span>
          )}

          <TimelinePlayhead style={{ left: `${(playheadAt / content) * 100}%` }} />

          {trimLimit === undefined ? null : (
            <LimitBubble
              left={`calc(${playheadAt} * var(--pps))`}
              text={trimLimit}
              viewportRef={scrollRef}
            />
          )}
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
  pressed: Edge | undefined
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, edge: Edge) => void
  onPointerDown: (event: PointerEvent<HTMLButtonElement>, edge: Edge) => void
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerCancel: () => void
}

function TrimPair({
  spec,
  valueText,
  pressed,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
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
      onPointerCancel={onPointerCancel}
      onPointerDown={(event) => onPointerDown(event, edge)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      pressed={pressed === edge}
      style={edge === 'start' ? { left: 0 } : { left: '100%' }}
      value={edge === 'start' ? spec.t0 : spec.t1}
      valueText={valueText}
    />
  ))
}

type EyeProps = { label: string; on: boolean; onToggle: () => void }

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
  nameId: string
  peaksOf: (url: string) => PeaksState
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
      className={cn('video-editor-timeline-block is-edit', !picked && 'is-off timeline-dimmed')}
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

export type VersionRow = {
  jobId: string
  label: string
  original: boolean
  mediaUrl: string
  shots: readonly Shot[] | undefined
  duration: number | undefined
}

type VersionsTimelineProps = {
  versions: readonly VersionRow[]
  composing: { duration: number | undefined } | undefined
  viewedId: string
  currentTime: number
  buffered: readonly TimeSpan[]
  peaksOf: (url: string) => PeaksState
  onSelect: (jobId: string) => void
  onSeek: (clock: number) => void
  onScrub: () => void
}

export function VersionsTimeline({
  versions,
  composing,
  viewedId,
  currentTime,
  buffered,
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
  const percent = (time: number) => `${(time / scale) * 100}%`
  const span = (start: number, end: number): CSSProperties => ({
    left: `calc(${percent(start)} + 1px)`,
    width: `calc(${percent(end - start)} - 2px)`,
  })

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, jobId: string) => {
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
                  buffered={buffered}
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
