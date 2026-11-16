import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/shared/lib/utils'
import type { PeaksState } from '../editing/media-analysis'
import { Frames, TrimHandle, Wave } from '../editing/timeline'
import { arrowStep, releasePointer, type Edge } from '../editing/timeline-drag'
import { slipped, timingOf, type SlipGrip, type Timing } from './clip-edit'
import type { FilmClip, MediaClip } from './composition/film'
import { useEditorEscape } from './editor-keys'
import type { KeyframeState } from './material-media'

const seconds = (ms: number) => (ms / 1000).toFixed(2)

const percent = (ms: number, total: number) => `${(ms / total) * 100}%`

const sameTiming = (a: Timing, b: Timing) =>
  a.start === b.start && a.duration === b.duration && a.mediaStart === b.mediaStart

/** 素材总长还不知道时条里写的那句：视频照「镜头」页签读镜头的写法，音频按波形的状态写。 */
const pendingNote = (clip: MediaClip, keyframe: KeyframeState | undefined, peaks: PeaksState) => {
  if (clip.kind === 'video') return keyframe?.kind === 'failed' ? keyframe.message : '正在读取镜头…'
  if (peaks.kind === 'failed') return '音频读取失败'
  return peaks.kind === 'silent' ? '该音频没有声音' : '正在读取音频…'
}

type Drag = {
  pointerId: number
  grip: SlipGrip
  /** 按下时指针的横坐标、抓着的那一端在素材里的毫秒；拖整段时不用。 */
  originX: number
  originMs: number
  timing: Timing
}

/**
 * 「原片截取」：一条画着整条素材的条，框出片段用掉的那一段（从入点起，长 时长 × 速度），框里两头按淡入、
 * 淡出压暗。拖两端的抓手改入点、出点，在条上按下或拖动框换一截素材（规则见 `slipped`）；抓手按方向键微调。
 * 拖动中只动这里，松手才写进 final-cut，一次算一步撤销；拖动中按 Esc 什么都不写。
 * 素材总长还不知道时不画框、不能拖。
 */
export function SourceTrim({
  clip,
  clips,
  sourceMs,
  keyframe,
  peaks,
  onRetime,
  onGesture,
}: {
  clip: MediaClip
  clips: readonly FilmClip[]
  /** 素材的总长；还不知道时是 undefined。 */
  sourceMs: number | undefined
  /** 视频片段素材的镜头读取状态。 */
  keyframe: KeyframeState | undefined
  /** 素材的波形读取状态：音频片段画在条上。 */
  peaks: PeaksState
  onRetime: (timings: ReadonlyMap<string, Timing>) => void
  /** 开始或结束拖动。 */
  onGesture: (active: boolean) => void
}) {
  const stripRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  // 拖动中被卸掉（换了选中的片段）时收不到松手，这里补一下
  useEffect(
    () => () => {
      if (dragRef.current !== null) onGesture(false)
    },
    [onGesture],
  )
  const [dragged, setDragged] = useState<{ grip: SlipGrip; timing: Timing } | null>(null)
  const timing = dragged?.timing ?? timingOf(clip)
  const rate = clip.playbackRate
  const inPoint = timing.mediaStart
  const outPoint = inPoint + timing.duration * rate

  const msAt = (clientX: number) => {
    const box = stripRef.current?.getBoundingClientRect()
    return box === undefined || box.width <= 0 || sourceMs === undefined
      ? 0
      : ((clientX - box.left) / box.width) * sourceMs
  }

  const commit = (next: Timing) => {
    if (!sameTiming(next, timingOf(clip))) onRetime(new Map([[clip.id, next]]))
  }

  const press = (event: PointerEvent<HTMLElement>, grip: SlipGrip) => {
    if (sourceMs === undefined || event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const next =
      grip === 'body' ? slipped(clip, 'body', msAt(event.clientX), clips, sourceMs) : timingOf(clip)
    dragRef.current = {
      pointerId: event.pointerId,
      grip,
      originX: event.clientX,
      originMs: grip === 'start' ? clip.mediaStart : clip.mediaStart + clip.duration * rate,
      timing: next,
    }
    setDragged({ grip, timing: next })
    onGesture(true)
  }

  const move = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation()
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId || sourceMs === undefined) return
    // 抓手按着的那一端跟着指针挪过的距离走，按下时不跳到指针处
    const at =
      drag.grip === 'body'
        ? msAt(event.clientX)
        : drag.originMs + msAt(event.clientX) - msAt(drag.originX)
    drag.timing = slipped(clip, drag.grip, at, clips, sourceMs)
    setDragged({ grip: drag.grip, timing: drag.timing })
  }

  const release = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation()
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    releasePointer(event)
    dragRef.current = null
    setDragged(null)
    onGesture(false)
    commit(drag.timing)
  }

  const cancel = (event?: PointerEvent<HTMLElement>) => {
    event?.stopPropagation()
    if (dragRef.current === null) return
    dragRef.current = null
    setDragged(null)
    onGesture(false)
  }
  useEditorEscape(dragged !== null, cancel)

  const nudge = (event: KeyboardEvent<HTMLButtonElement>, edge: Edge) => {
    const step = arrowStep(event)
    if (step === undefined || sourceMs === undefined) return
    event.preventDefault()
    const from = edge === 'start' ? clip.mediaStart : clip.mediaStart + clip.duration * rate
    commit(slipped(clip, edge, from + step * 1000, clips, sourceMs))
  }

  const total = sourceMs ?? 0
  const known = sourceMs !== undefined && sourceMs > 0
  const pointOf = (edge: Edge, at: Timing) =>
    edge === 'start' ? at.mediaStart : at.mediaStart + at.duration * rate
  // 入点、出点在素材里能去的范围（秒）：往两头拖到底各停在哪
  const reach = (edge: Edge) => ({
    min: pointOf(edge, slipped(clip, edge, -Infinity, clips, total)) / 1000,
    max: pointOf(edge, slipped(clip, edge, Infinity, clips, total)) / 1000,
  })

  return (
    <section className="wf-prop-section">
      <div className="wf-prop-title-row">
        <h4 className="wf-prop-title">原片截取</h4>
        <span className="wf-prop-subtitle" title={clip.label}>
          · {clip.label}
        </span>
        {known ? (
          <span className="wf-slip-summary" data-testid="slip-summary">
            {seconds(inPoint)} – {seconds(outPoint)}s
            <span className="wf-slip-total"> / {(total / 1000).toFixed(1)}s</span>
          </span>
        ) : null}
      </div>
      <div
        aria-label="原片截取条"
        className={cn('wf-slip', known && 'is-ready')}
        onPointerCancel={cancel}
        onPointerDown={(event) => press(event, 'body')}
        onPointerMove={move}
        onPointerUp={release}
        ref={stripRef}
        role="group"
      >
        {!known ? (
          <span className="wf-slip-note">{pendingNote(clip, keyframe, peaks)}</span>
        ) : (
          <>
            <span aria-hidden="true" className="wf-slip-source">
              {clip.kind === 'video' ? (
                <Frames part={{ mediaUrl: clip.src, start: 0, end: total / 1000 }} />
              ) : (
                <Wave part={{ mediaUrl: clip.src, start: 0, end: total / 1000 }} state={peaks} />
              )}
            </span>
            <div
              className="wf-range wf-slip-window"
              data-testid="slip-window"
              style={{
                left: percent(inPoint, total),
                width: percent(Math.min(total - inPoint, outPoint - inPoint), total),
              }}
            >
              <span
                aria-hidden="true"
                className="wf-slip-fade is-in"
                style={{ width: `${Math.min(50, (clip.fadeIn / timing.duration) * 100)}%` }}
              />
              <span
                aria-hidden="true"
                className="wf-slip-fade is-out"
                style={{ width: `${Math.min(50, (clip.fadeOut / timing.duration) * 100)}%` }}
              />
              {(['start', 'end'] as const).map((edge) => {
                const at = pointOf(edge, timing)
                return (
                  <TrimHandle
                    bounds={reach(edge)}
                    edge={edge}
                    key={edge}
                    onKeyDown={(event) => nudge(event, edge)}
                    onPointerCancel={cancel}
                    onPointerDown={(event) => press(event, edge)}
                    onPointerMove={move}
                    onPointerUp={release}
                    pressed={dragged?.grip === edge}
                    style={edge === 'start' ? { left: 0 } : { left: '100%' }}
                    value={at / 1000}
                    valueText={`${edge === 'start' ? '入点' : '出点'} ${seconds(at)} 秒`}
                  />
                )
              })}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
