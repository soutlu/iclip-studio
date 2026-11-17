import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import {
  AUDIO_GAIN_FADER_MAX,
  AUDIO_GAIN_FADER_MIN,
  audioGainToFaderPosition,
  audioGainToText,
} from '@hyperframes/core/audio-gain'
import { cn } from '@/shared/lib/utils'
import { DRAG_THRESHOLD, releasePointer } from '../editing/timeline-drag'
import { useEditorEscape } from './editor-keys'
import {
  envelopeHeight,
  envelopeLine,
  gainAtHeight,
  insertPoint,
  isEndPoint,
  movePoint,
  nudgedGain,
  removePoint,
  type EnvelopePoint,
} from './volume-envelope'

// 线离波形这一块的上下边留的空（占高度的百分之几），最高、最低的点不贴着边
const PAD = 12

/** 时间（秒）在这一块里的横向位置（百分比）。 */
const xPercent = (t: number, span: number) => (Math.min(span, Math.max(0, t)) / span) * 100

/** 音量（倍数）在这一块里的纵向位置（百分比，从上往下）。 */
const yPercent = (v: number) => PAD + (1 - envelopeHeight(v)) * (100 - 2 * PAD)

/**
 * 把曲线一层 `layer` 摆到片段 `clip` 里波形 `wave` 那一块上（波形里画图的那一层，按片段左上角算）；量不到时
 * 用样式表里默认的位置（片段底下一条）。
 */
function placeOnWave(layer: HTMLElement, clip: HTMLElement | null, wave: HTMLElement | null) {
  const target = wave?.firstElementChild ?? wave
  if (clip === null || !(target instanceof HTMLElement)) {
    for (const side of ['left', 'top', 'width', 'height'] as const) layer.style[side] = ''
    return
  }
  const outer = clip.getBoundingClientRect()
  const inner = target.getBoundingClientRect()
  layer.style.left = `${inner.left - outer.left}px`
  layer.style.top = `${inner.top - outer.top}px`
  layer.style.width = `${inner.width}px`
  layer.style.height = `${inner.height}px`
}

type Drag = {
  pointerId: number
  index: number
  /** 按下时的点（点在线上时已经加上了新点）。 */
  base: EnvelopePoint[]
  originX: number
  originY: number
  /** 已经改了：拖过一点，或者按在线上加了点。 */
  changed: boolean
}

const sameValues = (left: readonly EnvelopePoint[], right: readonly EnvelopePoint[]) =>
  left.length === right.length &&
  left.every((point, at) => point.t === right[at]?.t && point.v === right[at]?.v)

const nearest = (points: readonly EnvelopePoint[], t: number) =>
  points.reduce(
    (best, point, at) =>
      Math.abs(point.t - t) < Math.abs((points[best]?.t ?? Infinity) - t) ? at : best,
    0,
  )

/**
 * 时间线上片段波形上的音量曲线（波形音量关键帧，规则见 `volume-envelope.ts`）：一条折线加每个点一个圆点，叠在
 * 片段（`clipRef`）里波形（`waveRef`）那一块上；片段长 `durationSec` 秒。波形那一块的位置跟着名字、小标、缩放和
 * 片段宽窄变，每次画完和片段变大小时都重新摆。
 *
 * 只有 `editable`（选中、不在切开工具下）时能改，而且只有按在折线或圆点上才是改曲线，别处照常按到片段上（选中、
 * 挪动、裁剪）：按在线上加一个点、接着可以拖；拖圆点上下改音量，中间的点还能左右挪（不越过相邻的点），两头的点
 * 只能上下；拖的时候点旁边写着现在的音量，折线和波形跟着变（`onDraft`），松手交给 `onCommit`，算一步撤销，按 Esc
 * 放弃。双击中间的点删掉它。每个点是一个滑杆：方向键上下调音量（Shift 一次 10 格），Delete 删掉中间的点。
 */
export function ClipEnvelope({
  points,
  saved,
  durationSec,
  clipRef,
  waveRef,
  editable,
  onDraft,
  onCommit,
  onGesture,
}: {
  /** 现在显示的点：拖动中是拖着的样子。 */
  points: readonly EnvelopePoint[]
  /** 文件里存着的点：变了（撤销了、别处改了）时放弃正在拖的。同一份曲线要是同一个数组。 */
  saved: readonly EnvelopePoint[]
  durationSec: number
  clipRef: RefObject<HTMLElement | null>
  /** 波形那一块；还没有（视频片段还没读出波形）时摆在片段底下一条。 */
  waveRef: RefObject<HTMLElement | null>
  editable: boolean
  /** 拖动中的样子；拖完或放弃时是 null。 */
  onDraft: (points: EnvelopePoint[] | null) => void
  onCommit: (points: EnvelopePoint[]) => void
  onGesture: (active: boolean) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const pointsRef = useRef(new Map<number, HTMLElement>())
  const [active, setActive] = useState<number | null>(null)

  const place = useEffectEvent(() => {
    if (rootRef.current !== null) placeOnWave(rootRef.current, clipRef.current, waveRef.current)
  })
  useLayoutEffect(() => place())
  useEffect(() => {
    const clip = clipRef.current
    if (clip === null) return
    const observer = new ResizeObserver(() => place())
    observer.observe(clip)
    return () => observer.disconnect()
  }, [clipRef])

  const span = durationSec > 0 ? durationSec : 1
  /** 屏幕上的一点对着的时间（片段里的秒）和音量（倍数）。 */
  const at = (clientX: number, clientY: number) => {
    const rect = rootRef.current?.getBoundingClientRect()
    const across = rect === undefined || rect.width <= 0 ? 0 : (clientX - rect.left) / rect.width
    const down = rect === undefined || rect.height <= 0 ? 0.5 : (clientY - rect.top) / rect.height
    return {
      t: Math.min(1, Math.max(0, across)) * span,
      v: gainAtHeight(1 - (down * 100 - PAD) / (100 - 2 * PAD)),
    }
  }

  const line = envelopeLine(points, span)
    .map((point) => `${xPercent(point.t, span).toFixed(3)},${yPercent(point.v).toFixed(3)}`)
    .join(' ')
  const spot = (point: EnvelopePoint): CSSProperties => ({
    left: `${xPercent(point.t, span)}%`,
    top: `${yPercent(point.v)}%`,
  })

  const finish = () => {
    const drag = dragRef.current
    dragRef.current = null
    setActive(null)
    if (drag?.changed === true) onGesture(false)
  }

  const press = (event: PointerEvent<HTMLElement | SVGElement>, index: number | null) => {
    if (!editable || event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    const root = rootRef.current
    if (root === null) return
    const base = [...points]
    const { t } = at(event.clientX, event.clientY)
    const inserted = index === null ? insertPoint(base, t) : null
    // 按在线上、离已有的点太近：抓那个点
    const grabbed = index ?? (inserted === null ? nearest(base, t) : inserted.index)
    // 按在点上时等真拖起来再抓住指针，免得点击、双击也交给这一层而不是这个点
    if (index === null) root.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      index: grabbed,
      base: inserted?.points ?? base,
      originX: event.clientX,
      originY: event.clientY,
      changed: inserted !== null,
    }
    setActive(grabbed)
    if (inserted !== null) {
      onGesture(true)
      onDraft(inserted.points)
    }
  }

  const drag = (event: PointerEvent<HTMLDivElement>) => {
    const current = dragRef.current
    if (current === null || current.pointerId !== event.pointerId) return
    const moved = Math.hypot(event.clientX - current.originX, event.clientY - current.originY)
    if (!current.changed && moved <= DRAG_THRESHOLD) return
    if (!current.changed) {
      rootRef.current?.setPointerCapture(event.pointerId)
      onGesture(true)
    }
    current.changed = true
    const { t, v } = at(event.clientX, event.clientY)
    onDraft(movePoint(current.base, current.index, t, v))
  }

  const release = (event: PointerEvent<HTMLDivElement>) => {
    const current = dragRef.current
    if (current === null || current.pointerId !== event.pointerId) return
    releasePointer(event)
    finish()
    // 拖着时 `points` 就是拖成的样子
    if (current.changed && !sameValues(points, saved)) onCommit([...points])
    onDraft(null)
  }

  // 拖动中按 Esc：放弃这次拖动（含按在线上加的点）
  useEditorEscape(active !== null, () => {
    finish()
    onDraft(null)
  })

  // 拖着的时候曲线被换掉（撤销了，或者别处存了更新的一版）：放弃这次拖动
  const abandon = useEffectEvent(() => {
    if (dragRef.current === null) return
    finish()
    onDraft(null)
  })
  useEffect(() => () => abandon(), [])
  useEffect(() => abandon(), [saved])

  const key = (event: KeyboardEvent<HTMLElement>, index: number) => {
    const point = points[index]
    if (point === undefined) return
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopPropagation()
      const steps = (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1)
      onCommit(movePoint(points, index, point.t, nudgedGain(point.v, steps)))
      return
    }
    if (event.key !== 'Delete' && event.key !== 'Backspace') return
    // 两头的点不删，也不能让这一下删掉整个片段
    event.preventDefault()
    event.stopPropagation()
    if (isEndPoint(points, index)) return
    pointsRef.current.get(points[index - 1]?.t ?? 0)?.focus()
    onCommit(removePoint(points, index))
  }

  const shown = active === null ? undefined : points[active]
  return (
    <div
      aria-hidden={editable ? undefined : true}
      aria-label={editable ? '音量关键帧' : undefined}
      className={cn('wf-envelope', editable && 'is-editable')}
      data-testid="volume-envelope"
      onPointerCancel={() => {
        finish()
        onDraft(null)
      }}
      onPointerMove={drag}
      onPointerUp={release}
      ref={rootRef}
      role={editable ? 'group' : undefined}
    >
      <svg
        aria-hidden="true"
        className="wf-envelope-svg"
        preserveAspectRatio="none"
        viewBox="0 0 100 100"
      >
        <polyline className="wf-envelope-line" points={line} />
        {editable ? (
          <polyline
            className="wf-envelope-hit"
            data-testid="volume-envelope-line"
            onPointerDown={(event) => press(event, null)}
            points={line}
          />
        ) : null}
      </svg>
      {points.map((point, index) =>
        point.t < 0 || point.t > span ? null : (
          <span
            aria-label={`音量关键帧 ${index + 1}`}
            aria-orientation="vertical"
            aria-valuemax={AUDIO_GAIN_FADER_MAX}
            aria-valuemin={AUDIO_GAIN_FADER_MIN}
            aria-valuenow={Math.round(audioGainToFaderPosition(point.v))}
            aria-valuetext={`${audioGainToText(point.v)}，第 ${point.t.toFixed(1)} 秒`}
            className={cn(
              'wf-envelope-point',
              editable && 'ui-focus',
              active === index && 'is-active',
            )}
            key={point.t}
            onDoubleClick={(event) => {
              event.stopPropagation()
              if (editable && !isEndPoint(points, index)) onCommit(removePoint(points, index))
            }}
            onKeyDown={editable ? (event) => key(event, index) : undefined}
            onPointerDown={(event) => press(event, index)}
            ref={(element) => {
              if (element === null) pointsRef.current.delete(point.t)
              else pointsRef.current.set(point.t, element)
            }}
            role={editable ? 'slider' : undefined}
            style={spot(point)}
            tabIndex={editable ? 0 : undefined}
          />
        ),
      )}
      {shown === undefined ? null : (
        <span className="wf-envelope-readout" role="status" style={spot(shown)}>
          {audioGainToText(shown.v)}
        </span>
      )}
    </div>
  )
}
