import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { useEscapeAheadOfDialog } from '@/shared/ui/dialog'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { keyframeRanges } from '../editing/keyframe-segments'
import { Frames, TrimHandle } from '../editing/timeline'
import {
  arrowStep,
  DRAG_THRESHOLD,
  releasePointer,
  useClickAfterDrag,
  type Edge,
} from '../editing/timeline-drag'
import type { KeyframeStates } from './edit-context'
import {
  trimRange,
  type Material,
  type MaterialGroup,
  type MaterialRange,
  type MaterialTake,
  type UsedSpan,
} from './materials'

/** 拖着选中的范围走：指针在哪，范围拿起时在页面上的位置与大小；松手或取消后为 null */
export type MaterialCarry = {
  clientX: number
  clientY: number
  origin: { left: number; top: number; width: number; height: number }
  range: MaterialRange
}

type MaterialAreaProps = {
  groups: readonly MaterialGroup[]
  /** 成片还没读到或读取失败时，区域里放这个 */
  placeholder: ReactNode
  versionOf: (take: MaterialTake) => Material
  onVersion: (takeId: string, jobId: string) => void
  keyframes: KeyframeStates
  range: MaterialRange | null
  /** 成片轨上每版成片已经用了的段，按 jobId 分；轨道底边画一道 */
  used: ReadonlyMap<string, readonly UsedSpan[]>
  /** 点镜头（或点选区）：选中它，预览放这一段 */
  onPick: (range: MaterialRange) => void
  /** 在选区外按下一个镜头拖起来：只选中它，不放预览 */
  onSelect: (range: MaterialRange) => void
  /** 拖或微调选区的一端：预览停在这一端 */
  onTrim: (range: MaterialRange, edge: Edge) => void
  /** 镜头或选区两端上按 Enter：把选区插到播放头处 */
  onInsert: () => void
  /** 预览在放选区时，素材里放到的时刻（毫秒） */
  previewMs: number | undefined
  /** 拖着 range 到成片轨上松手；落在轨上返回 true */
  onDrop: (clientX: number, clientY: number, range: MaterialRange) => boolean
  /** 拖动中指针移到哪；取消时为 null */
  onCarry: (carry: MaterialCarry | null) => void
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

const percent = (ms: number, durationMs: number) => `${(ms / durationMs) * 100}%`

const insertOnEnter = (event: KeyboardEvent<HTMLElement>, onInsert: () => void) => {
  if (event.key !== 'Enter') return false
  // 不让按钮再补一次点击（那会重新选中镜头）
  event.preventDefault()
  onInsert()
  return true
}

/** 视频素材区：一个镜头组一段、每条原作一条轨，区域定高、镜头组多时在区域里上下滚动。 */
export function MaterialArea({
  groups,
  placeholder,
  versionOf,
  onVersion,
  keyframes,
  range,
  used,
  onPick,
  onSelect,
  onTrim,
  onInsert,
  previewMs,
  onDrop,
  onCarry,
}: MaterialAreaProps) {
  return (
    <section aria-label="视频素材区" className="wf-materials">
      <div className="wf-materials-body">
        {placeholder ??
          (groups.length === 0 ? (
            <p className="wf-materials-empty">
              这段对话还没有成片，出片完成后可在这里挑选片段加入整片
            </p>
          ) : (
            groups.map((group) => (
              <div
                aria-label={group.label}
                className="wf-material-group"
                key={group.id}
                role="group"
              >
                <span aria-hidden="true" className="wf-group-label">
                  {group.label}
                </span>
                {group.takes.map((take) => {
                  const version = versionOf(take)
                  return (
                    <TakeRow
                      key={take.id}
                      keyframes={keyframes}
                      onCarry={onCarry}
                      onDrop={onDrop}
                      onInsert={onInsert}
                      onPick={onPick}
                      onSelect={onSelect}
                      onTrim={onTrim}
                      onVersion={onVersion}
                      previewMs={range?.takeId === take.id ? previewMs : undefined}
                      range={range?.takeId === take.id ? range : null}
                      take={take}
                      used={used.get(version.jobId) ?? []}
                      version={version}
                    />
                  )
                })}
              </div>
            ))
          ))}
      </div>
    </section>
  )
}

type TakeRowProps = {
  take: MaterialTake
  version: Material
  keyframes: KeyframeStates
  range: MaterialRange | null
  /** 这一版在成片轨上已经用了的段 */
  used: readonly UsedSpan[]
  previewMs: number | undefined
  onPick: (range: MaterialRange) => void
  onSelect: (range: MaterialRange) => void
  onTrim: (range: MaterialRange, edge: Edge) => void
  onInsert: () => void
  onVersion: (takeId: string, jobId: string) => void
  onDrop: (clientX: number, clientY: number, range: MaterialRange) => boolean
  onCarry: (carry: MaterialCarry | null) => void
}

type RangeDrag = {
  pointerId: number
  originX: number
  originY: number
  edge: Edge | 'body'
  base: MaterialRange
  moved: boolean
  /** 在选区外按下的镜头：拖起来时先选中它 */
  fromShot: boolean
  origin: MaterialCarry['origin']
}

function TakeRow({
  take,
  version,
  keyframes,
  range,
  used,
  previewMs,
  onPick,
  onSelect,
  onTrim,
  onInsert,
  onVersion,
  onDrop,
  onCarry,
}: TakeRowProps) {
  const stripRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<RangeDrag | null>(null)
  const clickAfterDrag = useClickAfterDrag()
  const [lifting, setLifting] = useState(false)
  const state = keyframes.get(version.url)
  const durationMs = state?.kind === 'ready' ? Math.round(state.index.duration * 1000) : undefined
  const shown = range !== null && range.jobId === version.jobId ? range : null

  const msPerPx = () => {
    const width = stripRef.current?.getBoundingClientRect().width ?? 0
    return durationMs === undefined || width <= 0 ? 0 : durationMs / width
  }

  const press = (
    event: PointerEvent<HTMLElement>,
    edge: RangeDrag['edge'],
    base = range,
    fromShot = false,
  ) => {
    if (base === null || event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    clickAfterDrag.reset()
    const box = event.currentTarget.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      edge,
      base,
      moved: false,
      fromShot,
      origin: { left: box.left, top: box.top, width: box.width, height: box.height },
    }
  }

  const drag = (event: PointerEvent<HTMLElement>) => {
    const current = dragRef.current
    if (current === null || current.pointerId !== event.pointerId || durationMs === undefined)
      return
    const deltaPx = event.clientX - current.originX
    const distance =
      current.edge === 'body'
        ? Math.hypot(deltaPx, event.clientY - current.originY)
        : Math.abs(deltaPx)
    if (!current.moved && distance <= DRAG_THRESHOLD) return
    if (!current.moved && current.fromShot) onSelect(current.base)
    current.moved = true
    if (current.edge === 'body') {
      setLifting(true)
      onCarry({
        clientX: event.clientX,
        clientY: event.clientY,
        origin: current.origin,
        range: current.base,
      })
      return
    }
    onTrim(
      trimRange(current.base, current.edge, Math.round(deltaPx * msPerPx()), durationMs),
      current.edge,
    )
  }

  const release = (event: PointerEvent<HTMLElement>) => {
    const current = dragRef.current
    if (current === null || current.pointerId !== event.pointerId) return
    releasePointer(event)
    dragRef.current = null
    setLifting(false)
    if (current.edge === 'body' && current.moved) {
      // 松手后浏览器还会给按下的镜头补一个 click，那一下不算点镜头
      clickAfterDrag.swallow()
      onDrop(event.clientX, event.clientY, current.base)
    }
    // 在选区里点一下（没拖动）：预览放这段选区；点选区外的镜头由它的 click 处理
    else if (current.edge === 'body' && !current.fromShot) onPick(current.base)
  }

  const cancel = () => {
    const current = dragRef.current
    if (current?.edge === 'body') {
      if (current.moved) clickAfterDrag.swallow()
      onCarry(null)
    }
    dragRef.current = null
    setLifting(false)
  }
  useEscapeAheadOfDialog(lifting, cancel)

  return (
    <div className="wf-take">
      <div className="wf-take-head">
        <span className="wf-take-label">{take.label}</span>
        {take.versions.length > 1 ? (
          <MenuRoot>
            <MenuTrigger asChild>
              <button
                aria-label={`${take.label}的版本：${version.version}`}
                className="wf-version-switch ui-state ui-focus"
                type="button"
              >
                {version.version}
                <Icon decorative name="expand" size="xs" />
              </button>
            </MenuTrigger>
            <MenuSurface align="start" side="top">
              <MenuRadioGroup
                onValueChange={(jobId) => onVersion(take.id, jobId)}
                value={version.jobId}
              >
                {take.versions.map((item) => (
                  <MenuRadioItem key={item.jobId} value={item.jobId}>
                    {item.version}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSurface>
          </MenuRoot>
        ) : (
          <span className="wf-version-label">{version.version}</span>
        )}
      </div>
      <div className="wf-take-strip" ref={stripRef}>
        {state === undefined || state.kind === 'loading' ? (
          <span className="wf-take-note">正在读取镜头…</span>
        ) : state.kind === 'failed' ? (
          <span className="wf-take-note">{state.message}</span>
        ) : (
          keyframeRanges(state.index).map((shot, at) => {
            const startMs = Math.round(shot.start * 1000)
            const endMs = Math.round(shot.end * 1000)
            const length = endMs - startMs
            const totalMs = Math.round(state.index.duration * 1000)
            const picked = shown !== null && shown.startMs === startMs && shown.endMs === endMs
            const shotRange = { jobId: version.jobId, takeId: take.id, startMs, endMs }
            return (
              <button
                aria-keyshortcuts="Enter"
                aria-label={`${take.label} 镜头 ${at + 1}，${seconds(startMs)}–${seconds(endMs)} 秒`}
                aria-pressed={picked}
                className="wf-shot ui-focus"
                key={startMs}
                onClick={() => {
                  if (!clickAfterDrag.take()) onPick(shotRange)
                }}
                onKeyDown={(event) => insertOnEnter(event, onInsert)}
                // 在选区外按下镜头即可拖：拖起来时先选中这个镜头
                onPointerCancel={cancel}
                onPointerDown={(event) => press(event, 'body', shotRange, true)}
                onPointerMove={drag}
                onPointerUp={release}
                style={{
                  left: percent(startMs, totalMs),
                  width: `calc(${percent(length, totalMs)} - 2px)`,
                }}
                type="button"
              >
                <Frames part={{ mediaUrl: version.url, start: shot.start, end: shot.end }} />
              </button>
            )
          })
        )}
        {durationMs === undefined
          ? null
          : used.map((span) => (
              <span
                aria-hidden="true"
                className="wf-used"
                key={span.clipId}
                style={{
                  left: `calc(${percent(span.startMs, durationMs)} + 2px)`,
                  width: `max(4px, calc(${percent(span.endMs - span.startMs, durationMs)} - 4px))`,
                }}
              />
            ))}
        {shown !== null && durationMs !== undefined ? (
          <div
            aria-label={`选中的范围 ${seconds(shown.startMs)}–${seconds(shown.endMs)} 秒，拖到成片轨上可加入，按 Enter 插到播放头处`}
            className={cn('wf-range', lifting && 'is-lifting')}
            onPointerCancel={cancel}
            onPointerDown={(event) => press(event, 'body')}
            onPointerMove={drag}
            onPointerUp={release}
            role="group"
            style={{
              left: percent(shown.startMs, durationMs),
              width: percent(shown.endMs - shown.startMs, durationMs),
            }}
          >
            {(['start', 'end'] as const).map((edge) => (
              <TrimHandle
                bounds={{ min: 0, max: durationMs / 1000 }}
                edge={edge}
                key={edge}
                onKeyDown={(event) => {
                  if (insertOnEnter(event, onInsert)) return
                  const step = arrowStep(event)
                  if (step === undefined) return
                  event.preventDefault()
                  onTrim(trimRange(shown, edge, Math.round(step * 1000), durationMs), edge)
                }}
                onPointerCancel={cancel}
                onPointerDown={(event) => press(event, edge)}
                onPointerMove={drag}
                onPointerUp={release}
                pressed={false}
                style={edge === 'start' ? { left: 0 } : { left: '100%' }}
                value={(edge === 'start' ? shown.startMs : shown.endMs) / 1000}
                valueText={`${seconds(edge === 'start' ? shown.startMs : shown.endMs)} 秒`}
              />
            ))}
          </div>
        ) : null}
        {shown !== null && durationMs !== undefined && previewMs !== undefined ? (
          <span
            aria-hidden="true"
            className="wf-material-playhead"
            style={{ left: percent(previewMs, durationMs) }}
          />
        ) : null}
      </div>
    </div>
  )
}
