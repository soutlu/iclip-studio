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
  shiftShot,
  shotRange,
  trimLimits,
  trimRange,
  type Material,
  type MaterialGroup,
  type MaterialRange,
  type MaterialTake,
  type ShotSpan,
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
  /** 素材片还没读到或读取失败时，区域里放这个 */
  placeholder: ReactNode
  versionOf: (take: MaterialTake) => Material
  onVersion: (takeId: string, jobId: string) => void
  keyframes: KeyframeStates
  range: MaterialRange | null
  /** 画面轨上每版素材片已经用了的段，按 jobId 分；轨道底边画一道 */
  used: ReadonlyMap<string, readonly UsedSpan[]>
  /** 点镜头、Shift 点镜头（在选区上点也是点它下面的镜头）：选中这一段，预览停在它开头、不播放 */
  onPick: (range: MaterialRange) => void
  /** Shift 点掉了最后一个选中的镜头：什么也不选 */
  onClear: () => void
  /** 在选区外按下一个镜头拖起来：只选中它，预览不切到素材 */
  onSelect: (range: MaterialRange) => void
  /** 拖或微调选区的一端：预览停在这一端 */
  onTrim: (range: MaterialRange, edge: Edge) => void
  /** 镜头或选区两端上按 Enter：把选区插到播放头处 */
  onInsert: () => void
  /** 素材预览在播放时，素材里放到的时刻（毫秒）；不在播放时为 undefined，选区里不画播放头 */
  playingMs: number | undefined
  /** 拖着 range 到画面轨上松手；落在轨上返回 true */
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

/** 视频素材区：一个镜头组一段、每条原作一行，区域定高、原作多时在区域里上下滚动。 */
export function MaterialArea({
  groups,
  placeholder,
  versionOf,
  onVersion,
  keyframes,
  range,
  used,
  onPick,
  onClear,
  onSelect,
  onTrim,
  onInsert,
  playingMs,
  onDrop,
  onCarry,
}: MaterialAreaProps) {
  return (
    <section aria-label="视频素材区" className="wf-materials">
      <div className="wf-materials-body">
        {placeholder ??
          (groups.length === 0 ? (
            <p className="wf-materials-empty">
              这段对话还没有素材片，出片完成后可在这里挑选片段加入成片
            </p>
          ) : (
            groups.map((group) => (
              <div
                aria-label={group.label}
                className="wf-material-group"
                key={group.id}
                role="group"
              >
                {group.takes.map((take, index) => {
                  const version = versionOf(take)
                  return (
                    <TakeRow
                      groupLabel={index === 0 ? group.label : undefined}
                      key={take.id}
                      keyframes={keyframes}
                      onCarry={onCarry}
                      onDrop={onDrop}
                      onClear={onClear}
                      onInsert={onInsert}
                      onPick={onPick}
                      onSelect={onSelect}
                      onTrim={onTrim}
                      onVersion={onVersion}
                      playingMs={range?.takeId === take.id ? playingMs : undefined}
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
  /** 组里第一条原作带上组名，放在左列原作名上面 */
  groupLabel: string | undefined
  take: MaterialTake
  version: Material
  keyframes: KeyframeStates
  range: MaterialRange | null
  /** 这一版在画面轨上已经用了的段 */
  used: readonly UsedSpan[]
  playingMs: number | undefined
  onPick: (range: MaterialRange) => void
  onClear: () => void
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
  groupLabel,
  take,
  version,
  keyframes,
  range,
  used,
  playingMs,
  onPick,
  onClear,
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
  const shots: ShotSpan[] =
    state?.kind === 'ready'
      ? keyframeRanges(state.index).map((shot) => ({
          startMs: Math.round(shot.start * 1000),
          endMs: Math.round(shot.end * 1000),
        }))
      : []

  const msPerPx = () => {
    const width = stripRef.current?.getBoundingClientRect().width ?? 0
    return durationMs === undefined || width <= 0 ? 0 : durationMs / width
  }

  /** 点一个镜头：按着 Shift 时扩选或去掉一端，否则只选它 */
  const pickShot = (shot: ShotSpan, extend: boolean) => {
    const clicked = shotRange(version.jobId, take.id, shot)
    const next = extend ? shiftShot(range, clicked, shots) : clicked
    if (next === null) onClear()
    else onPick(next)
  }

  /** 指针横坐标下的镜头；选区盖住了选中的镜头，在选区上点时靠它知道点的是哪个 */
  const shotAtX = (clientX: number) => {
    const left = stripRef.current?.getBoundingClientRect().left ?? 0
    const ms = (clientX - left) * msPerPx()
    return shots.find((shot) => shot.startMs <= ms && ms < shot.endMs)
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
    // 在选区里点一下（没拖动）就是点指针下的那个镜头，同点选区外的镜头；点选区外的镜头由它的 click
    // 处理
    else if (current.edge === 'body' && !current.fromShot) {
      const shot = shotAtX(event.clientX)
      if (shot !== undefined) pickShot(shot, event.shiftKey)
    }
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
        {groupLabel === undefined ? null : (
          <span aria-hidden="true" className="wf-group-label">
            {groupLabel}
          </span>
        )}
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
          shots.map((shot, at) => {
            const { startMs, endMs } = shot
            const totalMs = Math.round(state.index.duration * 1000)
            const picked = shown?.shots.some((item) => item.startMs === startMs) === true
            return (
              <button
                aria-keyshortcuts="Enter"
                aria-label={`${take.label} 镜头 ${at + 1}，${seconds(startMs)}–${seconds(endMs)} 秒`}
                aria-pressed={picked}
                className="wf-shot ui-focus"
                key={startMs}
                onClick={(event) => {
                  if (!clickAfterDrag.take()) pickShot(shot, event.shiftKey)
                }}
                onKeyDown={(event) => insertOnEnter(event, onInsert)}
                // 在选区外按下镜头即可拖：拖起来时先选中这个镜头
                onPointerCancel={cancel}
                onPointerDown={(event) =>
                  press(event, 'body', shotRange(version.jobId, take.id, shot), true)
                }
                onPointerMove={drag}
                onPointerUp={release}
                style={{
                  left: percent(startMs, totalMs),
                  width: `calc(${percent(endMs - startMs, totalMs)} - 2px)`,
                }}
                type="button"
              >
                <Frames
                  part={{ mediaUrl: version.url, start: startMs / 1000, end: endMs / 1000 }}
                />
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
            aria-label={`选中的范围 ${seconds(shown.startMs)}–${seconds(shown.endMs)} 秒，${shown.shots.length} 个镜头，拖到画面轨上可加入，按 Enter 插到播放头处`}
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
            {(['start', 'end'] as const).map((edge) => {
              const limits = trimLimits(shown, edge, durationMs)
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
              )
            })}
          </div>
        ) : null}
        {shown !== null && durationMs !== undefined && playingMs !== undefined ? (
          <span
            aria-hidden="true"
            className="wf-material-playhead"
            data-testid="material-playhead"
            style={{ left: percent(playingMs, durationMs) }}
          />
        ) : null}
      </div>
    </div>
  )
}
