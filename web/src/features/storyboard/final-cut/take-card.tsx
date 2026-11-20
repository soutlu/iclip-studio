import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/shared/lib/utils'
import { mintUuid } from '@/shared/lib/uuid'
import { Frames, TrimHandle } from '../editing/timeline'
import {
  arrowStep,
  DRAG_THRESHOLD,
  releasePointer,
  useClickAfterDrag,
  type Edge,
} from '../editing/timeline-drag'
import { MIN_CLIP_MS } from './composition/film'
import { useEditorEscape } from './editor-keys'
import { takeDurationMs, takeShots, type KeyframeState } from './material-media'
import type { MaterialView } from './material-preview'
import {
  addSpan,
  edgeLimits,
  extendToShot,
  removeSpan,
  slideSpan,
  spanIndexAt,
  spanPieces,
  trimSpan,
  type Material,
  type MaterialTake,
  type MediaSpan,
  type PickSpan,
  type UsedSpan,
} from './materials'
import { TakeHead } from './take-head'

export type CarryPoint = { clientX: number; clientY: number }

type TakeCardProps = {
  take: MaterialTake
  /** 这条原作显示着的版本：镜头、选区、已用的段都按它算。 */
  version: Material
  keyframe: KeyframeState | undefined
  /** 这条原作上选中的几段（按时间排）。 */
  spans: readonly PickSpan[]
  /** 素材预览正放着这一版里的一段。 */
  previewing: boolean
  /** 时间线上用掉的素材段，按素材地址分（见 `usedSpans`）。 */
  used: ReadonlyMap<string, readonly UsedSpan[]>
  /** 素材预览在播时播到哪里（毫秒）；只在预览放着这一版时给。 */
  playingMs: number | undefined
  /** 选区改了；`view` 是改完要在素材预览里放的那一段，去掉一段时是 null。 */
  onChange: (spans: readonly PickSpan[], view: MaterialView | null) => void
  onInsert: () => void
  /** 「+」：把显示着的版本从头到尾整条加入轨道。 */
  onInsertWhole: (span: MediaSpan) => void
  onVersion: (takeId: string, jobId: string) => void
  /** 选区被拖出镜头条：带着这条原作上的选区跟着指针走；null 是取消了。 */
  onCarry: (point: CarryPoint | null, spans: readonly PickSpan[]) => void
  onDrop: (point: CarryPoint, spans: readonly PickSpan[]) => void
}

type GestureKind =
  | { kind: 'draw'; anchorMs: number; shot: MediaSpan; drawn: MediaSpan | null }
  | { kind: 'slide'; index: number }
  | { kind: 'trim'; index: number; edge: Edge }

type Gesture = GestureKind & {
  pointerId: number
  originX: number
  /** 按下时的选区，拖动按它加上挪过的距离算。 */
  base: readonly PickSpan[]
  moved: boolean
  /** 拖出了镜头条以后跟着指针走的选区。 */
  carried: readonly PickSpan[] | null
}

/** 新选上的一段。 */
const picked = (span: MediaSpan): PickSpan => ({ ...span, id: mintUuid() })

/** 素材很长时镜头条至少这么宽（每秒像素），放不下就在卡片里横着滚，镜头不会挤成一条缝。 */
const STRIP_PX_PER_SECOND = 28

/** 选区至少这么长才在左上角写秒数（照稿子）：按上面的最小宽度，写得下「0.0s」。 */
const PICK_TIME_MIN_MS = 1_800

/** 拖动提示气泡宽度的一半左右：气泡跟着指针走，但不伸出卡片。 */
const TIP_HALF_WIDTH = 64

const seconds = (ms: number) => (ms / 1000).toFixed(1)

const percent = (ms: number, durationMs: number) => `${(ms / durationMs) * 100}%`

const insertOnEnter = (event: KeyboardEvent<HTMLElement>, onInsert: () => void) => {
  if (event.key !== 'Enter') return false
  event.preventDefault()
  onInsert()
  return true
}

/** 选区以外的几段：照稿子压暗。 */
const dimmedOf = (spans: readonly MediaSpan[], durationMs: number): MediaSpan[] => {
  const gaps: MediaSpan[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.startMs > cursor) gaps.push({ startMs: cursor, endMs: span.startMs })
    cursor = Math.max(cursor, span.endMs)
  }
  if (cursor < durationMs) gaps.push({ startMs: cursor, endMs: durationMs })
  return gaps
}

/** 「镜头」页签里的一条原作：顶行见 `TakeHead`，下面是满宽的镜头条，入了轨的段和选区都画在镜头条上。 */
export function TakeCard({
  take,
  version,
  keyframe,
  spans,
  previewing,
  used,
  playingMs,
  onChange,
  onInsert,
  onInsertWhole,
  onVersion,
  onCarry,
  onDrop,
}: TakeCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const clickAfterDrag = useClickAfterDrag()
  const [lifting, setLifting] = useState(false)
  const [draft, setDraft] = useState<MediaSpan | null>(null)
  const [tip, setTip] = useState<{ text: string; left: number } | null>(null)
  const durationMs = takeDurationMs(keyframe)
  const shots = takeShots(keyframe)

  /** 改完的选区里盖着 `at` 的那一段放进素材预览，停在 `show` 那一端。 */
  const show = (next: readonly PickSpan[], at: number, edge: Edge) => {
    const index = spanIndexAt(next, at)
    const span = index === undefined ? undefined : next[index]
    onChange(next, span === undefined ? null : { jobId: version.jobId, span, show: edge })
  }

  const msAt = (clientX: number) => {
    const box = stripRef.current?.getBoundingClientRect()
    if (box === undefined || box.width <= 0 || durationMs === undefined) return 0
    return Math.min(durationMs, Math.max(0, ((clientX - box.left) / box.width) * durationMs))
  }

  const showTip = (span: MediaSpan, clientX: number) => {
    const card = cardRef.current?.getBoundingClientRect()
    if (card === undefined) return
    setTip({
      text: `${seconds(span.startMs)}s – ${seconds(span.endMs)}s · ${seconds(span.endMs - span.startMs)}s`,
      left: Math.min(card.width - TIP_HALF_WIDTH, Math.max(TIP_HALF_WIDTH, clientX - card.left)),
    })
  }

  /** 点一个镜头：落在选区里时去掉那一段（同点选区），不然把它整个并进选区；按着 Shift 时从最后一段连过来。 */
  const pickShot = (shot: MediaSpan, extend: boolean) => {
    const inside = spanIndexAt(spans, (shot.startMs + shot.endMs) / 2)
    if (inside !== undefined) onChange(removeSpan(spans, inside), null)
    else show((extend ? extendToShot : addSpan)(spans, picked(shot)), shot.startMs, 'start')
  }

  const press = (event: PointerEvent<HTMLElement>, kind: GestureKind) => {
    if (event.button !== 0 || durationMs === undefined) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    clickAfterDrag.reset()
    gestureRef.current = {
      ...kind,
      pointerId: event.pointerId,
      originX: event.clientX,
      base: spans,
      moved: false,
      carried: null,
    }
  }

  const drag = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    const box = stripRef.current?.getBoundingClientRect()
    if (gesture?.pointerId !== event.pointerId || durationMs === undefined || box === undefined)
      return
    const point = { clientX: event.clientX, clientY: event.clientY }
    if (gesture.carried !== null) {
      onCarry(point, gesture.carried)
      return
    }
    // 划选、平移拖出了镜头条：退回按下时的样子（从没选的镜头上拖出来时先选上它），整组选区跟着指针去时间线
    if (gesture.kind !== 'trim' && (event.clientY < box.top || event.clientY > box.bottom)) {
      const carried =
        gesture.kind === 'draw' ? addSpan(gesture.base, picked(gesture.shot)) : gesture.base
      gesture.carried = carried
      gesture.moved = true
      setDraft(null)
      setTip(null)
      setLifting(true)
      show(
        carried,
        gesture.kind === 'draw'
          ? gesture.shot.startMs
          : (gesture.base[gesture.index]?.startMs ?? 0),
        'start',
      )
      onCarry(point, carried)
      return
    }
    const deltaPx = event.clientX - gesture.originX
    if (!gesture.moved && Math.abs(deltaPx) <= DRAG_THRESHOLD) return
    gesture.moved = true
    const deltaMs = box.width > 0 ? Math.round((deltaPx / box.width) * durationMs) : 0
    if (gesture.kind === 'draw') {
      const at = Math.round(msAt(event.clientX))
      const span = {
        startMs: Math.min(gesture.anchorMs, at),
        endMs: Math.max(gesture.anchorMs, at),
      }
      gesture.drawn = span.endMs - span.startMs >= MIN_CLIP_MS ? span : null
      setDraft(gesture.drawn)
      showTip(span, event.clientX)
      return
    }
    const next =
      gesture.kind === 'slide'
        ? slideSpan(gesture.base, gesture.index, deltaMs, durationMs)
        : trimSpan(gesture.base, gesture.index, gesture.edge, deltaMs, durationMs)
    const span = next[gesture.index]
    if (span === undefined) return
    onChange(next, {
      jobId: version.jobId,
      span,
      show: gesture.kind === 'trim' ? gesture.edge : 'start',
    })
    showTip(span, event.clientX)
  }

  const finish = () => {
    gestureRef.current = null
    setLifting(false)
    setDraft(null)
    setTip(null)
  }

  const release = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (gesture?.pointerId !== event.pointerId) return
    releasePointer(event)
    finish()
    if (gesture.carried !== null) {
      clickAfterDrag.swallow()
      onDrop({ clientX: event.clientX, clientY: event.clientY }, gesture.carried)
    } else if (gesture.kind === 'draw') {
      // 没拖开、拖得不够一个最短片段时不划：松手算点了这个镜头，交给它的点击
      if (gesture.drawn === null) return
      clickAfterDrag.swallow()
      show(addSpan(gesture.base, picked(gesture.drawn)), gesture.drawn.startMs, 'start')
    } else if (gesture.kind === 'slide' && !gesture.moved) {
      onChange(removeSpan(gesture.base, gesture.index), null)
    }
  }

  const cancel = () => {
    const gesture = gestureRef.current
    finish()
    if (gesture === null) return
    if (gesture.moved) clickAfterDrag.swallow()
    if (gesture.carried !== null) onCarry(null, gesture.carried)
  }
  useEditorEscape(lifting, cancel)

  const handlers = { onPointerCancel: cancel, onPointerMove: drag, onPointerUp: release }
  const dimmed: readonly MediaSpan[] = draft === null ? spans : addSpan<MediaSpan>(spans, draft)
  // 已用段按选区的并段规则（addSpan）连起来画：整条加入时一个镜头一个片段，不连起来会断成一截一截
  const usedHere = (used.get(version.url) ?? []).reduce<UsedSpan[]>(addSpan, [])

  return (
    <article
      aria-label={take.label}
      className={cn('wf-take', previewing && 'is-previewing')}
      ref={cardRef}
    >
      <TakeHead
        blocked={
          keyframe?.kind === 'failed'
            ? '镜头读取失败，无法加入轨道'
            : durationMs === undefined
              ? '正在读取镜头，请稍后加入轨道'
              : undefined
        }
        durationMs={durationMs}
        onInsertWhole={() => {
          if (durationMs !== undefined) onInsertWhole({ startMs: 0, endMs: durationMs })
        }}
        onVersion={onVersion}
        shotCount={durationMs === undefined ? undefined : shots.length}
        take={take}
        used={used}
        version={version}
      />
      <div className="wf-take-scroll">
        <div
          className="wf-take-strip"
          ref={stripRef}
          style={
            durationMs === undefined
              ? undefined
              : { minWidth: (durationMs / 1000) * STRIP_PX_PER_SECOND }
          }
        >
          {keyframe === undefined || keyframe.kind === 'loading' ? (
            <span className="wf-take-note">正在读取镜头…</span>
          ) : keyframe.kind === 'failed' ? (
            <span className="wf-take-note">{keyframe.message}</span>
          ) : durationMs === undefined ? null : (
            <>
              {shots.map((shot, at) => (
                <button
                  aria-keyshortcuts="Enter"
                  aria-label={`${take.label} 镜头 ${at + 1}，${seconds(shot.startMs)}–${seconds(shot.endMs)} 秒`}
                  aria-pressed={spanIndexAt(spans, (shot.startMs + shot.endMs) / 2) !== undefined}
                  className="wf-shot ui-focus"
                  key={shot.startMs}
                  onClick={(event) => {
                    if (!clickAfterDrag.take()) pickShot(shot, event.shiftKey)
                  }}
                  onKeyDown={(event) => insertOnEnter(event, onInsert)}
                  onPointerDown={(event) =>
                    press(event, {
                      kind: 'draw',
                      anchorMs: Math.round(msAt(event.clientX)),
                      shot,
                      drawn: null,
                    })
                  }
                  {...handlers}
                  style={{
                    left: percent(shot.startMs, durationMs),
                    width: percent(shot.endMs - shot.startMs, durationMs),
                  }}
                  type="button"
                >
                  <Frames
                    part={{
                      mediaUrl: version.url,
                      start: shot.startMs / 1000,
                      end: shot.endMs / 1000,
                    }}
                  />
                </button>
              ))}
              <span aria-hidden="true" className="wf-take-marks">
                {shots.slice(1).map((shot) => (
                  <span
                    className="wf-take-cut"
                    key={shot.startMs}
                    style={{ left: percent(shot.startMs, durationMs) }}
                  />
                ))}
                {usedHere.map((span) => (
                  <span
                    className="wf-take-used"
                    key={span.clipId}
                    style={{
                      left: percent(span.startMs, durationMs),
                      right: percent(durationMs - span.endMs, durationMs),
                    }}
                  />
                ))}
                {dimmed.length === 0
                  ? null
                  : dimmedOf(dimmed, durationMs).map((gap) => (
                      <span
                        className="wf-take-dim"
                        key={gap.startMs}
                        style={{
                          left: percent(gap.startMs, durationMs),
                          width: percent(gap.endMs - gap.startMs, durationMs),
                        }}
                      />
                    ))}
              </span>
              {spans.map((span, index) => (
                <div
                  aria-label={`选中的范围 ${seconds(span.startMs)}–${seconds(span.endMs)} 秒，${spanPieces(span, shots).length} 个镜头，按 Enter 可加入轨道`}
                  className={cn('wf-pick', lifting && 'is-lifting')}
                  key={span.id}
                  onPointerDown={(event) => press(event, { kind: 'slide', index })}
                  {...handlers}
                  role="group"
                  style={{
                    left: percent(span.startMs, durationMs),
                    width: percent(span.endMs - span.startMs, durationMs),
                  }}
                >
                  {span.endMs - span.startMs >= PICK_TIME_MIN_MS ? (
                    <span aria-hidden="true" className="wf-pick-time">
                      {seconds(span.endMs - span.startMs)}s
                    </span>
                  ) : null}
                  {(['start', 'end'] as const).map((edge) => {
                    const limits = edgeLimits(spans, index, edge, durationMs)
                    const value = edge === 'start' ? span.startMs : span.endMs
                    return (
                      <TrimHandle
                        bounds={{ min: limits.min / 1000, max: limits.max / 1000 }}
                        edge={edge}
                        key={edge}
                        onKeyDown={(event) => {
                          if (insertOnEnter(event, onInsert)) return
                          const step = arrowStep(event)
                          if (step === undefined) return
                          event.preventDefault()
                          const next = trimSpan(
                            spans,
                            index,
                            edge,
                            Math.round(step * 1000),
                            durationMs,
                          )
                          const trimmed = next[index]
                          if (trimmed !== undefined)
                            onChange(next, { jobId: version.jobId, span: trimmed, show: edge })
                        }}
                        onPointerDown={(event) => press(event, { kind: 'trim', index, edge })}
                        {...handlers}
                        pressed={false}
                        style={edge === 'start' ? { left: 0 } : { left: '100%' }}
                        value={value / 1000}
                        valueText={`${seconds(value)} 秒`}
                      />
                    )
                  })}
                </div>
              ))}
              {draft === null ? null : (
                <span
                  aria-hidden="true"
                  className="wf-pick is-draft"
                  style={{
                    left: percent(draft.startMs, durationMs),
                    width: percent(draft.endMs - draft.startMs, durationMs),
                  }}
                />
              )}
              {previewing && playingMs !== undefined ? (
                <span
                  aria-hidden="true"
                  className="wf-material-playhead"
                  data-testid="material-playhead"
                  style={{ left: percent(playingMs, durationMs) }}
                />
              ) : null}
            </>
          )}
        </div>
      </div>
      {tip === null ? null : (
        <span aria-hidden="true" className="wf-take-tip" style={{ left: tip.left }}>
          {tip.text}
        </span>
      )}
    </article>
  )
}
