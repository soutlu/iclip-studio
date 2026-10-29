import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
} from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import type { PeaksState } from '../editing/media-analysis'
import { shiftSelect, stepSelect } from '../editing/range-select'
import { roundSeconds } from '../editing/time-label'
import { Frames, TimelinePlayhead, TimelineRuler, TrimHandle, Wave } from '../editing/timeline'
import { arrowStep, releasePointer, useRovingFocus, type Edge } from '../editing/timeline-drag'
import {
  draftLineOf,
  shotItemId,
  snapAhead,
  snapNear,
  totalOf,
  trimSpecOf,
  trimTo,
  type DraftItem,
  type TrimSpec,
} from './draft'
import { editTitleOf, lanePartsOf, type EditBlock, type LanePart, type Shot } from './edit-blocks'
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

/** 剪辑视图里全页唯一的选中：原片轨上的几个镜头、草稿里的一块，或编辑轨上在跑的那条。 */
export type Selection =
  | { kind: 'shots'; nos: readonly number[] }
  | { kind: 'draft'; id: string }
  | { kind: 'running'; id: string }
  | undefined

/** 修剪把手落到的新起止（按这一块来源自己的时间）。 */
export type TrimChange = { id: string; edge: Edge; t0: number; t1: number }

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
  /** 播放头的合成时间。 */
  clock: number
  peaksOf: (url: string) => PeaksState
  onSeek: (clock: number) => void
  onScrub: () => void
  onSelectShots: (nos: readonly number[]) => void
  onSelectDraft: (id: string) => void
  onSelectRunning: (id: string) => void
  onToggleShot: (no: number) => void
  /** 点编辑轨上完成的一段：选用或取消，同点它的眼睛，另由编辑器决定选中。 */
  onClickPart: (editId: string, seg: number) => void
  onTogglePart: (editId: string, seg: number) => void
  onTrim: (change: TrimChange) => void
  selectionBoxRef: Ref<HTMLSpanElement>
}

type Hover = { track: 'draft' | 'film' | 'edit'; id: string }

type Drag = {
  id: string
  edge: Edge
  pointerId: number
  x0: number
  from: number
  pps: number
  spec: TrimSpec
  /** 按下时轨道区铺了多少秒：拖动中不比它窄，免得滚到最右时内容变短、整条时间线在指针下跳。 */
  hold: number
}

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
 * 编辑（编辑片段对准它的生成区间，完成的按关键帧切段）。标尺与播放头属于草稿；原片轨、编辑轨的位置只随原片变。
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
  peaksOf,
  onSeek,
  onScrub,
  onSelectShots,
  onSelectDraft,
  onSelectRunning,
  onToggleShot,
  onClickPart,
  onTogglePart,
  onTrim,
  selectionBoxRef,
}: ClipsTimelineProps) {
  const lanesRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const baseId = useId()
  const [hover, setHover] = useState<Hover>()
  const [drag, setDrag] = useState<Drag>()
  const total = totalOf(items)
  const content = Math.max(duration, total, drag?.hold ?? 0)
  const bounded = Math.max(0, Math.min(total, clock))
  const parts = lanePartsOf(blocks)
  const rows = Math.max(1, ...blocks.map((block) => block.row + 1))
  const blockOf = (id: string) => blocks.find((block) => block.id === id)
  const itemOf = (id: string) => items.find((item) => item.id === id)
  const partOf = (id: string) => parts.find((part) => part.id === id)
  const shotOf = (no: number) => shots.find((shot) => shot.no === no)
  /** 此刻每秒多少像素：轨道区的实际宽度除以它铺的秒数。 */
  const ppsNow = () => {
    const width = lanesRef.current?.getBoundingClientRect().width ?? 0
    return width > 0 ? width / content : 1
  }

  // ---- 原片轨的选区：整镜头，Shift 扩选，方向键挪 ----
  const order = shots.map((shot) => shot.no)
  const chosen = selection?.kind === 'shots' ? selection.nos : []
  const roving = useRovingFocus(
    shots.map((shot) => shotItemId(shot.no)),
    chosen[0] === undefined ? undefined : shotItemId(chosen[0]),
  )
  const clickShot = (no: number, extend: boolean) => {
    roving.remember(shotItemId(no))
    onSelectShots(extend ? shiftSelect(order, chosen, no) : [no])
  }
  const shotKeyDown = (event: KeyboardEvent<HTMLButtonElement>, no: number) => {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : undefined
    if (direction === undefined) return
    event.preventDefault()
    const next = stepSelect(order, chosen, no, direction, event.shiftKey)
    onSelectShots(next.selection)
    roving.focus(shotItemId(next.focus))
  }

  // ---- 关联描边：悬停一边描出另一边，选中时常驻 ----
  const linked = new Set<string>()
  // 按位置记：同一处被描两次（选中与悬停）只画一个
  const filmMarks = new Map<string, { start: number; end: number }>()
  const laneMarks = new Map<string, LanePart>()
  const markFilm = (span: { start: number; end: number }) =>
    filmMarks.set(`${span.start}-${span.end}`, span)
  const markSource = (item: DraftItem) => {
    if (item.kind === 'shot') {
      const shot = shotOf(item.no)
      if (shot !== undefined) markFilm(shot)
      return
    }
    const part = partOf(item.id)
    if (part !== undefined) laneMarks.set(part.id, part)
  }
  const selectedItem = selection?.kind === 'draft' ? itemOf(selection.id) : undefined
  if (selectedItem !== undefined) markSource(selectedItem)
  for (const no of chosen) linked.add(shotItemId(no))
  if (hover?.track === 'draft') {
    const item = itemOf(hover.id)
    if (item !== undefined) markSource(item)
  } else if (hover?.track === 'edit') {
    const part = partOf(hover.id)
    if (part?.part !== undefined) {
      linked.add(part.id)
      markFilm(part.block)
    }
  } else if (hover?.track === 'film') linked.add(hover.id)
  const hovering = (track: Hover['track'], id: string) => ({
    onPointerEnter: () => setHover({ track, id }),
    onPointerLeave: () =>
      setHover((current) => (current?.track === track && current.id === id ? undefined : current)),
  })

  // ---- 选中描边：也是弹出卡的定位锚点 ----
  const firstShot = shotOf(chosen[0] ?? 0)
  const lastShot = shotOf(chosen.at(-1) ?? 0)
  const runningPart = selection?.kind === 'running' ? partOf(selection.id) : undefined
  const ring =
    firstShot !== undefined && lastShot !== undefined
      ? { track: 'is-film', style: placed(firstShot.start, lastShot.end - firstShot.start) }
      : selectedItem !== undefined
        ? { track: 'is-draft', style: placed(selectedItem.at, selectedItem.d) }
        : runningPart !== undefined
          ? {
              track: 'is-edit',
              style: placed(runningPart.at, runningPart.len, runningPart.block.row),
            }
          : undefined

  // ---- 草稿里选中那块的修剪把手 ----
  const pressTrim = (event: PointerEvent<HTMLButtonElement>, item: DraftItem, edge: Edge) => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const spec = trimSpecOf(item)
    setDrag({
      id: item.id,
      edge,
      pointerId: event.pointerId,
      x0: event.clientX,
      from: edge === 'end' ? spec.t1 : spec.t0,
      pps: ppsNow(),
      spec,
      hold: content,
    })
    // 按下就把舞台换到这一端的画面
    onTrim({ id: item.id, edge, t0: spec.t0, t1: spec.t1 })
  }
  const moveTrim = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag === undefined || drag.pointerId !== event.pointerId) return
    const time = drag.from + (event.clientX - drag.x0) / drag.pps
    const range = trimTo(drag.spec, drag.edge, time, snapNear(drag.spec.snaps, drag.pps))
    onTrim({ id: drag.id, edge: drag.edge, ...range })
  }
  const endTrim = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag === undefined || drag.pointerId !== event.pointerId) return
    releasePointer(event)
    setDrag(undefined)
  }
  const keyTrim = (event: KeyboardEvent<HTMLButtonElement>, item: DraftItem, edge: Edge) => {
    const step = arrowStep(event)
    if (step === undefined) return
    event.preventDefault()
    const spec = trimSpecOf(item)
    const current = edge === 'end' ? spec.t1 : spec.t0
    const snap = snapAhead(spec.snaps, current, step > 0 ? 1 : -1, ppsNow())
    onTrim({ id: item.id, edge, ...trimTo(spec, edge, current + step, snap) })
  }

  const draftName = (item: DraftItem) => {
    if (item.kind === 'shot') return `镜头 ${item.no} · ${draftLineOf(item)}`
    const block = blockOf(item.edit.id)
    return `${block === undefined ? '编辑片段' : editTitleOf(block)} · ${draftLineOf(item)}`
  }

  return (
    <section
      aria-label="视频编辑时间线"
      className="video-editor-timeline is-clips"
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
            {items.map((item) => (
              <div
                className="video-editor-timeline-block is-draft"
                data-linked={linked.has(item.id) ? '' : undefined}
                key={item.id}
                style={placed(item.at, item.d)}
                {...hovering('draft', item.id)}
              >
                <button
                  aria-label={draftName(item)}
                  aria-pressed={selection?.kind === 'draft' && selection.id === item.id}
                  className="video-editor-timeline-face ui-focus ui-focus-inline"
                  onClick={() => onSelectDraft(item.id)}
                  type="button"
                >
                  <Faces
                    end={item.t1}
                    mediaUrl={item.mediaUrl}
                    peaks={peaksOf(item.mediaUrl)}
                    start={item.t0}
                  />
                  <span aria-hidden="true" className="video-editor-timeline-no">
                    {item.kind === 'shot' ? (
                      item.no
                    ) : (
                      <Icon decorative name="edit-segment" size="xs" />
                    )}
                  </span>
                </button>
              </div>
            ))}
          </div>

          <div aria-label="原片" className="video-editor-timeline-track" role="group">
            {shots.map((shot) => {
              const id = shotItemId(shot.no)
              const on = shotOn(shot.no)
              const toggle = `${on ? '关闭' : '开启'}镜头 ${shot.no}`
              return (
                <div
                  className={cn('video-editor-timeline-block is-film', !on && 'is-off')}
                  key={id}
                  style={placed(shot.start, shot.end - shot.start)}
                  {...hovering('film', id)}
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
            {parts.map((part, index) => (
              <LaneBlock
                hover={hovering('edit', part.id)}
                key={part.id}
                nameId={`${baseId}-part-${index}`}
                onClickPart={onClickPart}
                onSelectRunning={onSelectRunning}
                onTogglePart={onTogglePart}
                part={part}
                peaksOf={peaksOf}
                picked={part.part !== undefined && isPicked(part.block.id, part.part.seg)}
                prefix={partPrefix(part)}
                selected={selection?.kind === 'running' && selection.id === part.id}
              />
            ))}
          </div>

          {[...filmMarks].map(([key, mark]) => (
            <span
              aria-hidden="true"
              className="video-editor-timeline-link is-film"
              data-testid="timeline-link"
              key={key}
              style={placed(mark.start, mark.end - mark.start)}
            />
          ))}
          {[...laneMarks.values()].map((part) => (
            <span
              aria-hidden="true"
              className="video-editor-timeline-link is-edit"
              data-testid="timeline-link"
              key={part.id}
              style={placed(part.at, part.len, part.block.row)}
            />
          ))}

          {ring === undefined ? null : (
            <span
              aria-hidden="true"
              className={cn('video-editor-timeline-box', ring.track)}
              ref={selectionBoxRef}
              style={ring.style}
            />
          )}

          {selectedItem === undefined ? null : (
            <span
              className="video-editor-timeline-trim"
              key={selectedItem.id}
              style={placed(selectedItem.at, selectedItem.d)}
            >
              {(['start', 'end'] as const).map((edge) => {
                const spec = trimSpecOf(selectedItem)
                return (
                  <TrimHandle
                    bounds={
                      edge === 'start'
                        ? { min: spec.lo, max: spec.t1 - spec.min }
                        : { min: spec.t0 + spec.min, max: spec.hi }
                    }
                    edge={edge}
                    key={edge}
                    onKeyDown={(event) => keyTrim(event, selectedItem, edge)}
                    onPointerCancel={endTrim}
                    onPointerDown={(event) => pressTrim(event, selectedItem, edge)}
                    onPointerMove={moveTrim}
                    onPointerUp={endTrim}
                    pressed={drag?.id === selectedItem.id && drag.edge === edge}
                    style={edge === 'start' ? { left: 0 } : { left: '100%' }}
                    value={edge === 'start' ? spec.t0 : spec.t1}
                    valueText={draftLineOf(selectedItem)}
                  />
                )
              })}
            </span>
          )}

          <TimelinePlayhead style={{ left: `${(bounded / content) * 100}%` }} />
        </div>
      </div>
    </section>
  )
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
  hover: { onPointerEnter: () => void; onPointerLeave: () => void }
  onClickPart: (editId: string, seg: number) => void
  onTogglePart: (editId: string, seg: number) => void
  onSelectRunning: (id: string) => void
}

/** 编辑轨上的一块：完成的一段（点它或它的眼睛选用、取消），或在跑、读取中、读不出的整条。 */
function LaneBlock({
  part,
  prefix,
  picked,
  selected,
  nameId,
  peaksOf,
  hover,
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
        onClick={() => onSelectRunning(part.id)}
        style={style}
        type="button"
        {...hover}
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
      role="group"
      style={style}
      {...hover}
    >
      <button
        aria-label={`${editTitleOf(block)} · ${prefix}${secondsText(b1 - b0)} 秒`}
        className="video-editor-timeline-face ui-focus ui-focus-inline"
        id={nameId}
        onClick={() => onClickPart(block.id, seg)}
        // 键盘用它的眼睛开关，这里只是鼠标的另一个入口
        tabIndex={-1}
        type="button"
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
