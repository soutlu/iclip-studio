/** 音乐轨：成片区第三行。音乐铺在视频段上（整片 0 秒到总长），片段上画音量包络（口播处压低、结尾淡出）与拍点刻度
 * （小节第一拍略高）；成片轨上落在拍上的切点在切线顶端标小实心点。左右拖音乐换用整首的另一部分（整首在固定的窗口下滑动），
 * 可自由微调起点；比视频段短时后面接斜纹空位。 */

import { useRef, useState, type KeyboardEvent, type PointerEvent, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import {
  beatsOf,
  gainAt,
  MUSIC_BED_GAIN,
  placeMusic,
  clampStart,
  stepStart,
  type GainPoint,
  type MusicPlacement,
  type Song,
} from './film-music'

/** 一首音乐的波形：每秒 `rate` 个 0–1 的峰值。 */
export type MusicPeaks = { rate: number; values: readonly number[] }

/** 音乐轨此刻画什么。 */
export type MusicTrackView =
  | { kind: 'empty' }
  /** 在上传、生成、读取：一句状态。 */
  | { kind: 'busy'; label: string }
  /** 生成失败、读不出来：一句原因，能重试的给重试，都能移除。 */
  | { kind: 'failed'; label: string; onRetry: (() => void) | undefined }
  | {
      kind: 'ready'
      name: string
      song: Song
      peaks: MusicPeaks
      placement: MusicPlacement
      /** 预览用的音量曲线（已叠上结尾淡出），整片时间。 */
      curve: readonly GainPoint[]
    }

type MusicTrackProps = {
  view: MusicTrackView
  /** 视频段总长。 */
  total: number
  /** 内部切点，整片时间。 */
  cuts: readonly number[]
  /** 整条宽度代表多少秒。 */
  scale: number
  /** 音乐轨与成片轨的位置，像素（见 film-timeline 的 ROW）。 */
  row: { top: number; height: number }
  filmTop: number
  /** 固定成片轨的落拍标记容器；音乐轨在下方独立滚动。 */
  cutMarkerContainer: HTMLElement | null
  selected: boolean
  /** 选中时弹出卡对准它。 */
  anchorRef: Ref<HTMLElement>
  /** 指针横向挪了多少像素合多少秒。 */
  secondsOf: (pixels: number) => number
  onSelect: (selected: boolean) => void
  /** 开始拖动：收起选中的东西。 */
  onScrub: () => void
  onMove: (start: number) => void
  onRemove: () => void
}

/** 包络每秒取几个点，至少、至多取多少。 */
const ENVELOPE_RATE = 12
const ENVELOPE_MIN = 48
const ENVELOPE_MAX = 720
/** 按下后挪过这么多像素才算拖动，不然是点。 */
const DRAG_THRESHOLD = 4
/** 按住 Shift 一次挪 1 秒，普通方向键微调 0.1 秒。 */
const FAST_STEPS = 10

const seconds = (value: number) => value.toFixed(1)

/** 整首 `from` 秒起的 `length` 秒里，每个点的波形高度（0–1）乘 `level(t)`，画成上下对称的一块。 */
const envelopePath = (
  peaks: MusicPeaks,
  from: number,
  length: number,
  level: (time: number) => number,
): string => {
  const count = Math.min(ENVELOPE_MAX, Math.max(ENVELOPE_MIN, Math.round(length * ENVELOPE_RATE)))
  const window = Math.max(1, Math.round(peaks.rate / ENVELOPE_RATE))
  const top: string[] = []
  const bottom: string[] = []
  for (let index = 0; index <= count; index += 1) {
    const time = (index / count) * length
    const at = Math.floor((from + time) * peaks.rate)
    let peak = 0
    for (let offset = 0; offset < window; offset += 1)
      peak = Math.max(peak, peaks.values[at + offset] ?? 0)
    const amplitude = Math.min(1, peak * level(time)) * 46
    const x = ((index / count) * 100).toFixed(2)
    top.push(`${x},${(50 - amplitude).toFixed(1)}`)
    bottom.unshift(`${x},${(50 + amplitude).toFixed(1)}`)
  }
  return `M${top.join('L')}L${bottom.join('L')}Z`
}

/** 整首 `from` 秒起的 `length` 秒里的拍点刻度，位置按这一截的比例。 */
function BeatTicks({ song, from, length }: { song: Song; from: number; length: number }) {
  return (
    <span aria-hidden="true" className="film-music-beats">
      {beatsOf(song)
        .filter((beat) => beat.at >= from && beat.at < from + length)
        .map((beat) => (
          <i
            className={cn('film-music-beat', beat.downbeat && 'is-bar')}
            key={beat.at}
            style={{ left: `${((beat.at - from) / length) * 100}%` }}
          />
        ))}
    </span>
  )
}

function Envelope({ path }: { path: string }) {
  return (
    <svg
      aria-hidden="true"
      className="film-music-envelope"
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      <path d={path} />
    </svg>
  )
}

/** 拖动音乐：按下时的指针与起点，此刻吸附到的起点。 */
type Drag = { pointerId: number; originX: number; origin: number; start: number; moved: boolean }

export function MusicTrack({
  view,
  total,
  cuts,
  scale,
  row,
  filmTop,
  cutMarkerContainer,
  selected,
  anchorRef,
  secondsOf,
  onSelect,
  onScrub,
  onMove,
  onRemove,
}: MusicTrackProps) {
  const [drag, setDrag] = useState<Drag | null>(null)
  // 拖完松手时浏览器还会补一个 click，那一下不算点选。
  const swallowClickRef = useRef(false)
  const percent = (time: number) => `${(time / scale) * 100}%`
  const top = row.top + 2
  const height = row.height - 4

  if (view.kind === 'empty') return null
  if (view.kind === 'busy' || view.kind === 'failed' || total === 0) {
    const label = view.kind === 'ready' ? `${view.name} · 成片轨上放入视频后自动对齐` : view.label
    return (
      <span
        className="film-music-status"
        role={view.kind === 'failed' ? 'alert' : 'status'}
        style={{
          left: 0,
          width: total === 0 ? undefined : `calc(${percent(total)} - 2px)`,
          top,
          height,
        }}
      >
        <span className="film-subtitle-status-text">
          {view.kind === 'busy' ? (
            <Icon className="motion-safe:animate-spin" decorative name="loading" size="xs" />
          ) : (
            <Icon decorative name="music" size="xs" />
          )}
          {label}
          {view.kind === 'failed' && view.onRetry !== undefined ? (
            <>
              <i>·</i>
              <button
                className="film-music-status-action ui-focus"
                onClick={view.onRetry}
                type="button"
              >
                重试
              </button>
            </>
          ) : null}
          {view.kind === 'failed' || view.kind === 'ready' ? (
            <>
              <i>·</i>
              <button
                className="film-music-status-action ui-focus"
                onClick={onRemove}
                type="button"
              >
                移除
              </button>
            </>
          ) : null}
        </span>
      </span>
    )
  }

  const { song, peaks, curve, name } = view
  // 拖动中按指针的起点重新铺；不拖时就是编辑器给的铺法。
  const placement =
    drag?.moved === true ? placeMusic(song, total, cuts, drag.start) : view.placement
  const { start } = placement
  const covered = Math.min(total, placement.available)
  const used = `使用 ${seconds(start)}–${seconds(start + covered)} 秒`
  const level = (time: number) => gainAt(curve, time * 1000) / MUSIC_BED_GAIN

  const press = (event: PointerEvent<HTMLButtonElement>) => {
    swallowClickRef.current = false
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({
      pointerId: event.pointerId,
      originX: event.clientX,
      origin: start,
      start,
      moved: false,
    })
  }
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag === null || drag.pointerId !== event.pointerId) return
    const moved = drag.moved || Math.abs(event.clientX - drag.originX) > DRAG_THRESHOLD
    if (!moved) return
    if (!drag.moved) onScrub()
    // 指针往右，整首跟着往右滑，窗口里换成更早的一截。
    const raw = drag.origin - secondsOf(event.clientX - drag.originX)
    setDrag({ ...drag, moved, start: clampStart(song, total, raw) })
  }
  const release = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag === null || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    setDrag(null)
    if (!drag.moved) return
    swallowClickRef.current = true
    onMove(drag.start)
  }
  const click = () => {
    if (swallowClickRef.current) {
      swallowClickRef.current = false
      return
    }
    onSelect(!selected)
  }
  const key = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      onRemove()
      return
    }
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : undefined
    if (direction === undefined) return
    event.preventDefault()
    onMove(stepStart(song, total, start, direction * (event.shiftKey ? FAST_STEPS : 1)))
  }

  const dragging = drag?.moved === true
  // 拖动时整首淡淡铺在下层：整首 0 秒对着整片 −起点，夹在轨道范围里。
  const songEnd = Math.min(scale, song.duration - start)
  return (
    <>
      {dragging && songEnd > 0 ? (
        <span
          aria-hidden="true"
          className="film-music-song"
          style={{ left: 0, width: percent(songEnd), top: row.top, height: row.height }}
        >
          <Envelope path={envelopePath(peaks, start, songEnd, () => 1)} />
          <BeatTicks from={start} length={songEnd} song={song} />
        </span>
      ) : null}
      <button
        aria-describedby="film-music-hint"
        aria-label={`音乐：${name}，${used}`}
        aria-pressed={selected}
        className={cn('film-music-clip ui-focus', dragging && 'is-window')}
        onClick={click}
        onKeyDown={key}
        onPointerCancel={release}
        onPointerDown={press}
        onPointerMove={move}
        onPointerUp={release}
        style={{ left: 0, width: `calc(${percent(covered)} - 2px)`, top, height }}
        type="button"
      >
        <Envelope path={envelopePath(peaks, start, covered, level)} />
        <BeatTicks from={start} length={covered} song={song} />
        <span className="film-music-name">
          <Icon decorative name="music" size="xs" />
          {name}
        </span>
      </button>
      <span className="sr-only" id="film-music-hint">
        按左右方向键换用整首里前后一拍，按住 Shift 一次一小节；按 Delete 移除音乐
      </span>
      {placement.shortBy > 0 ? (
        <span
          className="film-music-gap"
          style={{
            left: percent(covered),
            width: `calc(${percent(placement.shortBy)} - 2px)`,
            top,
            height,
          }}
        >
          <span className="film-music-gap-label">音乐比成片短 {seconds(placement.shortBy)} 秒</span>
        </span>
      ) : null}
      {selected && !dragging ? (
        <span
          aria-hidden="true"
          className="film-timeline-box"
          ref={anchorRef}
          style={{
            left: `calc(${percent(0)} - 3px)`,
            width: `calc(${percent(covered)} + 4px)`,
            top: row.top - 1,
            height: row.height + 2,
          }}
        />
      ) : null}
      {song.grid === null || cutMarkerContainer === null
        ? null
        : createPortal(
            placement.onBeat.map((cut) => (
              <span
                aria-hidden="true"
                className="film-music-cut-dot"
                key={cut}
                style={{ left: percent(cut), top: filmTop }}
              />
            )),
            cutMarkerContainer,
          )}
      {dragging ? (
        <span
          className="film-timeline-bubble"
          role="status"
          style={{ left: percent(covered / 2), top: row.top + row.height + 4 }}
        >
          <Icon decorative name="music" size="xs" />
          {used} · 落在拍上的切点 {placement.onBeat.length}/{placement.cutCount}
        </span>
      ) : null}
    </>
  )
}
