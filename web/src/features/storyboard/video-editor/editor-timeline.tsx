/** 时间线：视频轨铺按时间截的缩略图，原声轨画真实波形，两条轨一一对应（一段就是上下一对）。
 * 点段选中、拖两端裁剪、按住中间拖动调序；比例按所看那一版的时长排，草稿短了右边留一个细框。 */

import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
} from 'react'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { useTakeElapsed } from '../components/use-take-elapsed'
import {
  selectedRange,
  stepSelect,
  trimBounds,
  type Draft,
  type DraftClip,
  type Selection,
} from './draft'
import type { PlaySegment } from './play-layout'
import { roundSeconds, timeLabel } from './time-label'
import type { PeaksState } from './use-media-analysis'
import './editor-timeline.css'

type Edge = 'start' | 'end'

/** 时间线上的一项：一段素材，或一个 AI 正在改的占位（画被换下的那几段）。 */
export type TimelineEntry = {
  id: string
  /** 在草稿时钟上的起点与长度，秒。 */
  at: number
  duration: number
  /** 画面与原声取自哪几截素材。 */
  parts: readonly PlaySegment[]
  /** 能剪的素材段；占位没有。 */
  clip: DraftClip | undefined
  /** 不是这一版没动过的关键帧段，底下画一道灰线。 */
  changed: boolean
  /** 占位：AI 从这一刻起在改。 */
  runningSince: string | undefined
}

type EditorTimelineProps = {
  draft: Draft
  entries: readonly TimelineEntry[]
  /** 整条宽度代表多少秒：所看那一版的时长，草稿更长时取草稿的。 */
  scale: number
  /** 草稿总长。 */
  total: number
  currentTime: number
  selection: Selection
  /** 能剪：看的是草稿，没在提交、没在等合成。 */
  editable: boolean
  peaksOf: (url: string) => PeaksState
  onSeek: (clock: number) => void
  /** 点了能剪的一段（鼠标点、或聚焦时回车与空格）：选中怎么变由调用方定。 */
  onClickSegment: (id: string) => void
  /** 键盘左右键改了选中。 */
  onSelect: (selection: Selection) => void
  /** 开始拖动：播放头、裁剪手柄，或按住段挪过了阈值。 */
  onScrub: () => void
  /** 选区外框（视频轨那一圈），弹出卡按它对准；没有选区或拖着段时不在。 */
  selectionBoxRef: Ref<HTMLSpanElement>

  /** 拖完一端：把这段的这一端定在 `value`（这段素材自己的时间，秒）。 */
  onTrim: (id: string, edge: Edge, value: number) => void
  /** 拖动中：预览停到裁剪边界那一刻的画面。 */
  onTrimPreview: (clock: number, edge: Edge) => void
  /** 把这几段挪到草稿第 `before` 项之前。 */
  onMove: (ids: Selection, before: number) => void
  onDelete: () => void
}

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60]
/** 按下后挪过这么多像素才算拖动，不然是点。 */
const DRAG_THRESHOLD = 4
/** 键盘裁剪一步多少秒；按住 Shift 一步一秒。 */
const KEY_TRIM_STEP = 0.1

/** 一截素材的缩略图：按时间均匀截几张；地址截不了帧（不是 OSS）或截失败时露出中性底色。 */
function Frames({ part }: { part: PlaySegment }) {
  const length = part.end - part.start
  const count = Math.max(1, Math.min(24, Math.round(length * 2)))
  const shots = Array.from({ length: count }).flatMap((_, at) => {
    const url = videoSnapshotUrl(part.mediaUrl, 96, part.start + ((at + 0.5) * length) / count)
    return url === undefined ? [] : [url]
  })
  return (
    <span className="video-editor-timeline-frames" style={{ flexGrow: length }}>
      {shots.length === 0 ? (
        <Icon decorative name="video" size="sm" />
      ) : (
        shots.map((src) => <Frame key={src} src={src} />)
      )}
    </span>
  )
}

function Frame({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  return failed ? (
    <span className="video-editor-timeline-frame-empty" />
  ) : (
    <img alt="" draggable={false} onError={() => setFailed(true)} src={src} />
  )
}

/** 一截素材在一段里的标识：同一段里不会有两截一样的。 */
const partKey = (part: PlaySegment) => `${part.mediaUrl}@${part.start}-${part.end}`

/** 一截素材的原声：读中一条低调的占位线，没有音轨写「无声」，读不出写明，读到画波形。 */
function Wave({ part, state }: { part: PlaySegment; state: PeaksState }) {
  const length = part.end - part.start
  const body = (() => {
    switch (state.kind) {
      case 'loading':
        return <span className="video-editor-timeline-wave-loading" />
      case 'silent':
        return <span className="video-editor-timeline-wave-note">无声</span>
      case 'failed':
        return <span className="video-editor-timeline-wave-note">原声读取失败</span>
      case 'ready': {
        const { rate, peaks } = state.peaks
        const from = Math.floor(part.start * rate)
        const count = Math.max(1, Math.ceil(part.end * rate) - from)
        let path = ''
        for (let at = 0; at < count; at += 1) {
          const height = Math.max(4, (peaks[from + at] ?? 0) * 92)
          path += `M${at + 0.5} ${50 - height / 2}v${height}`
        }
        return (
          <svg data-testid="timeline-wave" preserveAspectRatio="none" viewBox={`0 0 ${count} 100`}>
            <path d={path} />
          </svg>
        )
      }
    }
  })()
  return (
    <span className="video-editor-timeline-wave" style={{ flexGrow: length }}>
      {body}
    </span>
  )
}

/** 占位上那层「生成中 0:42」，盖住视频与原声。 */
function RunningCover({ since, style }: { since: string; style: CSSProperties }) {
  const elapsed = useTakeElapsed(since)
  return (
    <span className="video-editor-timeline-running" role="status" style={style}>
      <Icon className="motion-safe:animate-spin" decorative name="loading" size="sm" />
      生成中 {elapsed}
    </span>
  )
}

type Lift = {
  pointerId: number
  ids: Selection
  originX: number
  /** 按下处离被拖那一串起点多少秒，浮起的那串跟着指针保持这个距离。 */
  grab: number
  clock: number
  moved: boolean
}

type Trim = { pointerId: number; id: string; edge: Edge; value: number }

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
  const buttonsRef = useRef(new Map<string, HTMLButtonElement>())
  // 拖完松手时浏览器还会补一个 click，那一下不算点选。
  const swallowClickRef = useRef(false)
  const [focusId, setFocusId] = useState<string>()
  const [lift, setLift] = useState<Lift | null>(null)
  const [trim, setTrim] = useState<Trim | null>(null)
  // 播放位置滑块是被指针按住拿到的焦点：Chrome 对 range 点一下也算 :focus-visible，刻度区的焦点环
  // 只留给键盘，按下键盘或失焦时清掉这个记号。
  const [seekByPointer, setSeekByPointer] = useState(false)

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

  const range = selectedRange(draft, selection)
  const selected = (id: string) => selection.includes(id)
  const single =
    editable && selection.length === 1 && trim === null && lift === null
      ? entries.find((entry) => entry.id === selection[0] && entry.clip !== undefined)
      : undefined
  const tabStop =
    entries.find((entry) => entry.id === focusId && entry.clip !== undefined)?.id ??
    selection[0] ??
    entries.find((entry) => entry.clip !== undefined)?.id

  const focusEntry = (id: string) => {
    setFocusId(id)
    buttonsRef.current.get(id)?.focus()
  }

  // ---------- 点选与键盘 ----------

  const click = (entry: TimelineEntry) => {
    if (swallowClickRef.current) {
      swallowClickRef.current = false
      return
    }
    setFocusId(entry.id)
    if (editable) onClickSegment(entry.id)
    else onSeek(entry.at)
  }

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, entry: TimelineEntry) => {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : undefined
    if (direction !== undefined && event.altKey) {
      // Alt + 左右：把选中的那串往前后挪一格。
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
        if (next?.clip !== undefined) focusEntry(next.id)
        return
      }
      const next = stepSelect(draft, selection, entry.id, direction, event.shiftKey)
      onSelect(next.selection)
      focusEntry(next.focus)
      return
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && editable) {
      event.preventDefault()
      // 焦点所在的段被删掉后落回对话框，键盘就断了：交给后面（没有就前面）留下来的那段。
      const neighbor =
        range === undefined
          ? undefined
          : (entries
              .slice(range.to + 1)
              .concat(entries.slice(0, range.from).reverse())
              .find((item) => item.clip !== undefined)?.id ?? undefined)
      onDelete()
      if (neighbor !== undefined) requestAnimationFrame(() => focusEntry(neighbor))
    }
  }

  // ---------- 拖动调序 ----------

  const pressClip = (event: PointerEvent<HTMLButtonElement>, entry: TimelineEntry) => {
    // 拖完松手后浏览器不一定补那个 click（段已经挪走了），记号留到下一次按下就作废。
    swallowClickRef.current = false
    if (!editable || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    // 按在选区里拖整串，按在选区外只拖这一段。
    const ids = selected(entry.id) && range !== undefined ? selection : [entry.id]
    const first = entries.find((item) => item.id === ids[0])
    const clock = clockAt(event.clientX)
    setLift({
      pointerId: event.pointerId,
      ids,
      originX: event.clientX,
      grab: clock - (first?.at ?? entry.at),
      clock,
      moved: false,
    })
  }

  const insertBefore = (clock: number) => {
    const index = entries.findIndex((entry) => entry.at + entry.duration / 2 > clock)
    return index < 0 ? entries.length : index
  }

  const dragClip = (event: PointerEvent<HTMLButtonElement>) => {
    if (lift === null || lift.pointerId !== event.pointerId) return
    const moved = lift.moved || Math.abs(event.clientX - lift.originX) > DRAG_THRESHOLD
    if (moved && !lift.moved) onScrub()
    setLift({ ...lift, clock: clockAt(event.clientX), moved })
  }

  const releaseClip = (event: PointerEvent<HTMLButtonElement>) => {
    if (lift === null || lift.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    setLift(null)
    if (!lift.moved) return
    swallowClickRef.current = true
    onMove(lift.ids, insertBefore(lift.clock))
  }

  // ---------- 裁剪 ----------

  const trimValue = (entry: TimelineEntry, clip: DraftClip, edge: Edge, clock: number) => {
    const { min, max } = trimBounds(clip, edge)
    return Math.min(max, Math.max(min, clip.start + (clock - entry.at)))
  }

  const pressHandle = (
    event: PointerEvent<HTMLButtonElement>,
    entry: TimelineEntry,
    edge: Edge,
  ) => {
    if (entry.clip === undefined) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    onScrub()
    const value = entry.clip[edge]
    setTrim({ pointerId: event.pointerId, id: entry.id, edge, value })
    onTrimPreview(entry.at + (value - entry.clip.start), edge)
  }

  const dragHandle = (event: PointerEvent<HTMLButtonElement>) => {
    if (trim === null || trim.pointerId !== event.pointerId) return
    const entry = entries.find((item) => item.id === trim.id)
    if (entry?.clip === undefined) return
    const value = trimValue(entry, entry.clip, trim.edge, clockAt(event.clientX))
    setTrim({ ...trim, value })
    onTrimPreview(entry.at + (value - entry.clip.start), trim.edge)
  }

  const releaseHandle = (event: PointerEvent<HTMLButtonElement>) => {
    if (trim === null || trim.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    setTrim(null)
    onTrim(trim.id, trim.edge, trim.value)
  }

  const keyHandle = (event: KeyboardEvent<HTMLButtonElement>, entry: TimelineEntry, edge: Edge) => {
    const step = event.shiftKey ? 1 : KEY_TRIM_STEP
    const delta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : undefined
    if (delta === undefined || entry.clip === undefined) return
    event.preventDefault()
    const value = entry.clip[edge] + delta
    onTrim(entry.id, edge, value)
    onTrimPreview(entry.at + (value - entry.clip.start), edge)
  }

  // ---------- 刻度 ----------

  const tickStep = TICK_STEPS.find((step) => step >= scale / 8) ?? Math.ceil(scale / 8 / 60) * 60
  const ticks = Array.from({ length: Math.floor(scale / tickStep) + 1 }, (_, at) => at * tickStep)
  const boundedTime = Math.max(0, Math.min(total, currentTime))

  // ---------- 拖动中的画法 ----------

  const trimmed = (() => {
    if (trim === null) return undefined
    const entry = entries.find((item) => item.id === trim.id)
    if (entry?.clip === undefined) return undefined
    const offset = trim.value - entry.clip.start
    const from = trim.edge === 'start' ? entry.at + offset : entry.at
    const to = trim.edge === 'start' ? entry.at + entry.duration : entry.at + offset
    const shorter = entry.duration - (to - from)
    return { entry, from, to, shorter }
  })()
  const lifted =
    lift?.moved === true ? entries.filter((entry) => lift.ids.includes(entry.id)) : undefined
  const liftedDuration = lifted?.reduce((sum, entry) => sum + entry.duration, 0) ?? 0
  const liftRange = lifted === undefined ? undefined : selectedRange(draft, lift?.ids ?? [])
  const insertAt = lift?.moved === true ? insertBefore(lift.clock) : undefined
  // 插回原处（选中那串之内或紧挨着它）等于没挪，不画墨线。
  const showInsert =
    insertAt !== undefined &&
    liftRange !== undefined &&
    (insertAt < liftRange.from || insertAt > liftRange.to + 1)
  const insertClock = insertAt === undefined ? 0 : (entries[insertAt]?.at ?? total)

  // 只选中一段、能剪时两端有手柄；拖着的时候跟着被拖的那段。
  const handleOwner = single ?? trimmed?.entry
  const handleEntry =
    handleOwner?.clip === undefined ? undefined : { entry: handleOwner, clip: handleOwner.clip }

  const selectionBox =
    trimmed !== undefined
      ? { from: trimmed.from, to: trimmed.to }
      : range !== undefined && lifted === undefined
        ? (() => {
            const first = entries[range.from]
            const last = entries[range.to]
            return first === undefined || last === undefined
              ? undefined
              : { from: first.at, to: last.at + last.duration }
          })()
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
        role="region"
      >
        <div
          className={cn('video-editor-timeline-lanes', !editable && 'is-readonly')}
          ref={lanesRef}
        >
          <div className="video-editor-timeline-ruler">
            {ticks.map((time) => (
              <span
                aria-hidden="true"
                className={cn(
                  'video-editor-timeline-tick',
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
              className="video-editor-timeline-seek"
              data-pointer={seekByPointer ? '' : undefined}
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
                onClick={() => click(entry)}
                onFocus={() => setFocusId(entry.id)}
                onKeyDown={(event) => keyDown(event, entry)}
                onPointerCancel={releaseClip}
                onPointerDown={(event) => pressClip(event, entry)}
                onPointerMove={dragClip}
                onPointerUp={releaseClip}
                ref={(element) => {
                  if (element === null) buttonsRef.current.delete(entry.id)
                  else buttonsRef.current.set(entry.id, element)
                }}
                style={span(entry.at, entry.duration)}
                tabIndex={entry.id === tabStop ? 0 : -1}
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
            <>
              <span
                aria-hidden="true"
                className="video-editor-timeline-box"
                ref={selectionBoxRef}
                style={{
                  left: `calc(${percent(selectionBox.from)} - 3px)`,
                  width: `calc(${percent(selectionBox.to - selectionBox.from)} + 4px)`,
                }}
              />
              <span
                aria-hidden="true"
                className="video-editor-timeline-box is-linked"
                style={{
                  left: `calc(${percent(selectionBox.from)} - 1px)`,
                  width: percent(selectionBox.to - selectionBox.from),
                }}
              />
            </>
          )}

          {handleEntry === undefined
            ? null
            : (['start', 'end'] as const).map((edge) => {
                const { entry, clip } = handleEntry
                const value = trim !== null && trim.edge === edge ? trim.value : clip[edge]
                const bounds = trimBounds(clip, edge)
                return (
                  <button
                    aria-label={edge === 'start' ? '裁剪该段开头' : '裁剪该段结尾'}
                    aria-valuemax={roundSeconds(bounds.max)}
                    aria-valuemin={roundSeconds(bounds.min)}
                    aria-valuenow={roundSeconds(value)}
                    aria-valuetext={`${roundSeconds(value)} 秒`}
                    className={cn(
                      'video-editor-timeline-handle ui-focus',
                      `is-${edge}`,
                      trim?.edge === edge && 'is-pressed',
                    )}
                    key={edge}
                    onKeyDown={(event) => keyHandle(event, entry, edge)}
                    onPointerCancel={releaseHandle}
                    onPointerDown={(event) => pressHandle(event, entry, edge)}
                    onPointerMove={dragHandle}
                    onPointerUp={releaseHandle}
                    role="slider"
                    style={{ left: percent(entry.at + (value - clip.start)) }}
                    title="拖动可裁剪，按方向键可微调，按住 Shift 每次调整 1 秒"
                    type="button"
                  />
                )
              })}

          {trimmed === undefined ? null : (
            <span
              className="video-editor-timeline-bubble"
              role="status"
              style={{ left: percent(trim?.edge === 'start' ? trimmed.from : trimmed.to) }}
            >
              裁剪后 {(trimmed.to - trimmed.from).toFixed(1)} 秒 ·{' '}
              {trimmed.shorter >= 0
                ? `缩短 ${trimmed.shorter.toFixed(1)} 秒`
                : `延长 ${(-trimmed.shorter).toFixed(1)} 秒`}
            </span>
          )}

          {entries.map((entry) =>
            entry.runningSince === undefined ? null : (
              <RunningCover
                key={entry.id}
                since={entry.runningSince}
                style={span(entry.at, entry.duration)}
              />
            ),
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

          <span
            aria-hidden="true"
            className="video-editor-timeline-playhead"
            style={{ left: percent(boundedTime) }}
          />
        </div>
      </div>
    </section>
  )
}
