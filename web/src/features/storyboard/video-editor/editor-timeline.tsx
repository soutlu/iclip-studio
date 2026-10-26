import { useRef, useState, type KeyboardEvent, type PointerEvent, type Ref } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import type { PeaksState } from '../editing/media-analysis'
import type { PlaySegment } from '../editing/play-layout'
import { roundSeconds } from '../editing/time-label'
import {
  Frames,
  TimelinePlayhead,
  TimelineRuler,
  TrimBubble,
  TrimHandle,
  Wave,
} from '../editing/timeline'
import {
  arrowStep,
  releasePointer,
  useClickAfterDrag,
  useLiftDrag,
  useRovingFocus,
  type Edge,
} from '../editing/timeline-drag'
import {
  selectedRange,
  stepSelect,
  trimBounds,
  type Draft,
  type DraftClip,
  type Selection,
} from './draft'
import './editor-timeline.css'

export type TimelineEntry = {
  id: string
  at: number
  duration: number
  parts: readonly PlaySegment[]
  clip: DraftClip | undefined
  changed: boolean
  runningSince: string | undefined
  versionLabel?: string | undefined
}

type EditorTimelineProps = {
  draft: Draft
  entries: readonly TimelineEntry[]
  scale: number
  total: number
  currentTime: number
  selection: Selection
  editable: boolean
  peaksOf: (url: string) => PeaksState
  onSeek: (clock: number) => void
  onClickSegment: (id: string, extend?: boolean) => void
  onSelect: (selection: Selection) => void
  onScrub: () => void
  selectionBoxRef: Ref<HTMLSpanElement>
  /** 裁选区的一端：开头对应第一段的开头，结尾对应最后一段的结尾 */
  onTrim: (edge: Edge, value: number) => void
  onTrimPreview: (clock: number, edge: Edge) => void
  onMove: (ids: Selection, before: number) => void
  onDelete: () => void
}

const partKey = (part: PlaySegment) => `${part.mediaUrl}@${part.start}-${part.end}`

type Trim = { pointerId: number; edge: Edge; value: number }

/** 抓手挂着的那段：选区第一段管开头，最后一段管结尾 */
type HandleOwner = { entry: TimelineEntry; clip: DraftClip }

/** 这段素材里的某个时刻在时间线上的位置 */
const clockOf = ({ entry, clip }: HandleOwner, value: number) => entry.at + (value - clip.start)

export function EditorTimeline({
  draft,
  entries,
  scale,
  total,
  currentTime,
  selection,
  editable,
  peaksOf,
  onSeek,
  onClickSegment,
  onSelect,
  onScrub,
  selectionBoxRef,
  onTrim,
  onTrimPreview,
  onMove,
  onDelete,
}: EditorTimelineProps) {
  const lanesRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [trim, setTrim] = useState<Trim | null>(null)

  const percent = (time: number) => `${(time / scale) * 100}%`
  const span = (at: number, duration: number) => ({
    left: percent(at),
    width: `calc(${percent(duration)} - 2px)`,
  })
  const clockAt = (clientX: number) => {
    const bounds = lanesRef.current?.getBoundingClientRect()
    if (bounds === undefined || bounds.width === 0) return 0
    return Math.min(scale, Math.max(0, ((clientX - bounds.left) / bounds.width) * scale))
  }

  const clickAfterDrag = useClickAfterDrag()
  const reorder = useLiftDrag<Selection>({ clockAt, onScrub })
  const lift = reorder.lift
  const roving = useRovingFocus(
    entries.flatMap((entry) => (entry.clip === undefined ? [] : [entry.id])),
    selection[0],
  )

  const range = selectedRange(draft, selection)
  const selected = (id: string) => selection.includes(id)
  const rangeFirst = range === undefined ? undefined : entries[range.from]
  const rangeLast = range === undefined ? undefined : entries[range.to]
  // 抓手只挂在选区最外两端：单选时两个落在同一段上。
  const handleOwners: Record<Edge, HandleOwner> | undefined =
    editable && lift === null && rangeFirst?.clip !== undefined && rangeLast?.clip !== undefined
      ? {
          start: { entry: rangeFirst, clip: rangeFirst.clip },
          end: { entry: rangeLast, clip: rangeLast.clip },
        }
      : undefined

  const click = (entry: TimelineEntry, extend: boolean) => {
    if (clickAfterDrag.take()) return
    roving.remember(entry.id)
    if (editable) onClickSegment(entry.id, extend)
    else onSeek(entry.at)
  }

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, entry: TimelineEntry) => {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : undefined
    if (direction !== undefined && event.altKey) {
      event.preventDefault()
      if (!editable || range === undefined) return
      const before = direction < 0 ? range.from - 1 : range.to + 2
      if (before >= 0 && before <= draft.length) onMove(selection, before)
      return
    }
    if (direction !== undefined) {
      event.preventDefault()
      if (!editable) {
        const next = entries[entries.indexOf(entry) + direction]
        if (next?.clip !== undefined) roving.focus(next.id)
        return
      }
      const next = stepSelect(draft, selection, entry.id, direction, event.shiftKey)
      onSelect(next.selection)
      roving.focus(next.focus)
      return
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && editable) {
      event.preventDefault()
      // 焦点所在的段被删掉后焦点落回对话框，交给后面（没有就前面）留下来的那段。
      const neighbor =
        range === undefined
          ? undefined
          : (entries
              .slice(range.to + 1)
              .concat(entries.slice(0, range.from).reverse())
              .find((item) => item.clip !== undefined)?.id ?? undefined)
      onDelete()
      if (neighbor !== undefined) requestAnimationFrame(() => roving.focus(neighbor))
    }
  }

  const pressClip = (event: PointerEvent<HTMLButtonElement>, entry: TimelineEntry) => {
    clickAfterDrag.reset()
    if (!editable || event.button !== 0) return
    const ids = selected(entry.id) && range !== undefined ? selection : [entry.id]
    const first = entries.find((item) => item.id === ids[0])
    reorder.press(event, ids, first?.at ?? entry.at)
  }

  const insertBefore = (clock: number) => {
    const index = entries.findIndex((entry) => entry.at + entry.duration / 2 > clock)
    return index < 0 ? entries.length : index
  }

  const releaseClip = (event: PointerEvent<HTMLButtonElement>) => {
    const dropped = reorder.release(event)
    if (dropped === undefined) return
    clickAfterDrag.swallow()
    onMove(dropped.payload, insertBefore(dropped.clock))
  }

  const pressHandle = (event: PointerEvent<HTMLButtonElement>, owner: HandleOwner, edge: Edge) => {
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    onScrub()
    const value = owner.clip[edge]
    setTrim({ pointerId: event.pointerId, edge, value })
    onTrimPreview(clockOf(owner, value), edge)
  }

  const dragHandle = (event: PointerEvent<HTMLButtonElement>) => {
    if (trim === null || trim.pointerId !== event.pointerId || handleOwners === undefined) return
    const owner = handleOwners[trim.edge]
    const { min, max } = trimBounds(owner.clip, trim.edge)
    const clock = clockAt(event.clientX)
    const value = Math.min(max, Math.max(min, owner.clip.start + (clock - owner.entry.at)))
    setTrim({ ...trim, value })
    onTrimPreview(clockOf(owner, value), trim.edge)
  }

  const releaseHandle = (event: PointerEvent<HTMLButtonElement>) => {
    if (trim === null || trim.pointerId !== event.pointerId) return
    releasePointer(event)
    setTrim(null)
    onTrim(trim.edge, trim.value)
  }

  const keyHandle = (event: KeyboardEvent<HTMLButtonElement>, owner: HandleOwner, edge: Edge) => {
    const delta = arrowStep(event)
    if (delta === undefined) return
    event.preventDefault()
    const value = owner.clip[edge] + delta
    onTrim(edge, value)
    onTrimPreview(clockOf(owner, value), edge)
  }

  const boundedTime = Math.max(0, Math.min(total, currentTime))

  // 拖动中的选区：被拖的一端跟着抓手，另一端不动；气泡说的是整个选区裁后多长。
  const trimmed = (() => {
    if (trim === null || handleOwners === undefined) return undefined
    const { start, end } = handleOwners
    const entry = handleOwners[trim.edge].entry
    const selectionEnd = end.entry.at + end.entry.duration
    const from = trim.edge === 'start' ? clockOf(start, trim.value) : start.entry.at
    const to = trim.edge === 'end' ? clockOf(end, trim.value) : selectionEnd
    const shorter = selectionEnd - start.entry.at - (to - from)
    return { entry, from, to, shorter }
  })()
  const lifted =
    lift?.moved === true ? entries.filter((entry) => lift.payload.includes(entry.id)) : undefined
  const liftedDuration = lifted?.reduce((sum, entry) => sum + entry.duration, 0) ?? 0
  const liftRange = lifted === undefined ? undefined : selectedRange(draft, lift?.payload ?? [])
  const insertAt = lift?.moved === true ? insertBefore(lift.clock) : undefined
  const showInsert =
    insertAt !== undefined &&
    liftRange !== undefined &&
    (insertAt < liftRange.from || insertAt > liftRange.to + 1)
  const insertClock = insertAt === undefined ? 0 : (entries[insertAt]?.at ?? total)

  const selectionBox =
    trimmed !== undefined
      ? { from: trimmed.from, to: trimmed.to }
      : rangeFirst !== undefined && rangeLast !== undefined && lifted === undefined
        ? { from: rangeFirst.at, to: rangeLast.at + rangeLast.duration }
        : undefined

  return (
    <section aria-label="视频编辑时间线" className="video-editor-timeline">
      <div aria-hidden="true" className="video-editor-timeline-heads">
        <span className="video-editor-timeline-head is-video">
          <Icon decorative name="video" size="sm" />
          视频
        </span>
        <span className="video-editor-timeline-head is-audio">
          <Icon decorative name="waveform" size="sm" />
          原声
        </span>
      </div>
      <div
        aria-label="时间线轨道，窄屏可横向滚动"
        className="video-editor-timeline-scroll"
        ref={scrollRef}
        role="region"
      >
        <div
          className={cn('video-editor-timeline-lanes', !editable && 'is-readonly')}
          ref={lanesRef}
        >
          <TimelineRuler
            clockAt={clockAt}
            currentTime={currentTime}
            onScrub={onScrub}
            onSeek={onSeek}
            scale={scale}
            total={total}
            viewportRef={scrollRef}
          />

          {entries.map((entry, index) => {
            const isSelected = selected(entry.id)
            const isLifted = lifted?.some((item) => item.id === entry.id) === true
            const name = `第 ${index + 1} 段 · ${roundSeconds(entry.at)}–${roundSeconds(entry.at + entry.duration)} 秒`
            const faces = (
              <>
                <span className="video-editor-timeline-face is-video">
                  {entry.parts.map((part) => (
                    <Frames key={partKey(part)} part={part} />
                  ))}
                  {entry.versionLabel === undefined ? null : (
                    <span className="video-editor-timeline-version">{entry.versionLabel}</span>
                  )}
                </span>
                <span className="video-editor-timeline-face is-gap">
                  {entry.changed ? (
                    <span className="video-editor-timeline-mark" data-testid="timeline-mark" />
                  ) : null}
                </span>
                <span className="video-editor-timeline-face is-audio">
                  {entry.parts.map((part) => (
                    <Wave key={partKey(part)} part={part} state={peaksOf(part.mediaUrl)} />
                  ))}
                </span>
              </>
            )
            if (entry.clip === undefined)
              return (
                <div
                  aria-label={`${name} · AI 生成中`}
                  className="video-editor-timeline-item is-pending"
                  key={entry.id}
                  role="img"
                  style={span(entry.at, entry.duration)}
                >
                  {faces}
                </div>
              )
            return (
              <button
                aria-disabled={editable ? undefined : true}
                aria-label={name}
                aria-pressed={isSelected}
                className={cn(
                  'video-editor-timeline-item ui-focus',
                  isSelected && 'is-selected',
                  isLifted && 'is-slot',
                )}
                key={entry.id}
                onClick={(event) => click(entry, event.shiftKey)}
                onFocus={() => roving.remember(entry.id)}
                onKeyDown={(event) => keyDown(event, entry)}
                onPointerCancel={releaseClip}
                onPointerDown={(event) => pressClip(event, entry)}
                onPointerMove={reorder.move}
                onPointerUp={releaseClip}
                ref={roving.register(entry.id)}
                style={span(entry.at, entry.duration)}
                tabIndex={roving.tabIndexOf(entry.id)}
                type="button"
              >
                {faces}
              </button>
            )
          })}

          {total < scale - 0.01 ? (
            <span
              aria-hidden="true"
              className="video-editor-timeline-tail"
              data-testid="timeline-tail"
              style={span(total, scale - total)}
            />
          ) : null}

          {trimmed === undefined ? null : (
            <span
              aria-hidden="true"
              className="video-editor-timeline-ghost"
              style={
                trim?.edge === 'start'
                  ? span(trimmed.entry.at, Math.max(0, trimmed.from - trimmed.entry.at))
                  : span(
                      trimmed.to,
                      Math.max(0, trimmed.entry.at + trimmed.entry.duration - trimmed.to),
                    )
              }
            />
          )}

          {selectionBox === undefined ? null : (
            <span
              aria-hidden="true"
              className="video-editor-timeline-box"
              ref={selectionBoxRef}
              style={span(selectionBox.from, selectionBox.to - selectionBox.from)}
            />
          )}

          {handleOwners === undefined
            ? null
            : (['start', 'end'] as const).map((edge) => {
                const owner = handleOwners[edge]
                const value = trim !== null && trim.edge === edge ? trim.value : owner.clip[edge]
                return (
                  <TrimHandle
                    bounds={trimBounds(owner.clip, edge)}
                    edge={edge}
                    key={edge}
                    onKeyDown={(event) => keyHandle(event, owner, edge)}
                    onPointerCancel={releaseHandle}
                    onPointerDown={(event) => pressHandle(event, owner, edge)}
                    onPointerMove={dragHandle}
                    onPointerUp={releaseHandle}
                    pressed={trim?.edge === edge}
                    style={{ left: percent(clockOf(owner, value)) }}
                    value={value}
                    valueText={`${roundSeconds(value)} 秒`}
                  />
                )
              })}

          {trimmed === undefined ? null : (
            <TrimBubble
              length={trimmed.to - trimmed.from}
              shorter={trimmed.shorter}
              style={{ left: percent(trim?.edge === 'start' ? trimmed.from : trimmed.to) }}
            />
          )}

          {lifted === undefined || lift === null ? null : (
            <span
              aria-hidden="true"
              className="video-editor-timeline-lifted"
              style={span(
                Math.min(Math.max(0, lift.clock - lift.grab), Math.max(0, scale - liftedDuration)),
                liftedDuration,
              )}
            >
              {lifted
                .flatMap((entry) => entry.parts)
                .map((part) => (
                  <Frames key={partKey(part)} part={part} />
                ))}
            </span>
          )}
          {showInsert ? (
            <span
              aria-hidden="true"
              className="video-editor-timeline-insert"
              data-testid="timeline-insert"
              style={{ left: percent(insertClock) }}
            />
          ) : null}

          <TimelinePlayhead style={{ left: percent(boundedTime) }} />
        </div>
      </div>
    </section>
  )
}
