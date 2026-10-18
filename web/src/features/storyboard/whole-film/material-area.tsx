import { useRef, useState, type PointerEvent } from 'react'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { BlockedReason } from '../components/blocked-reason'
import { keyframeRanges } from '../editing/keyframe-segments'
import { TrimHandle } from '../editing/timeline'
import { DRAG_THRESHOLD, releasePointer } from '../editing/timeline-drag'
import { MIN_CLIP_MS } from './editing/draft'
import type { KeyframeStates } from './edit-context'
import type { Material, MaterialGroup, MaterialTake } from './materials'

/** 素材区里选中的一段：哪一版成片的哪个范围（素材时间，毫秒） */
export type MaterialRange = { jobId: string; takeId: string; startMs: number; endMs: number }

type MaterialAreaProps = {
  groups: readonly MaterialGroup[]
  group: MaterialGroup | undefined
  onGroup: (groupId: string) => void
  versionOf: (take: MaterialTake) => Material
  onVersion: (takeId: string, jobId: string) => void
  keyframes: KeyframeStates
  range: MaterialRange | null
  onRange: (range: MaterialRange) => void
  onAdd: () => void
  addBlocked: string | undefined
  /** 拖到成片轨上松手；落在轨上返回 true */
  onDrop: (clientX: number, clientY: number) => boolean
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

export function MaterialArea({
  groups,
  group,
  onGroup,
  versionOf,
  onVersion,
  keyframes,
  range,
  onRange,
  onAdd,
  addBlocked,
  onDrop,
}: MaterialAreaProps) {
  if (group === undefined)
    return (
      <section aria-label="视频素材区" className="wf-materials">
        <p className="wf-materials-empty">这段对话还没有成片，出片完成后可在这里挑选片段加入整片</p>
      </section>
    )
  return (
    <section aria-label="视频素材区" className="wf-materials">
      <div className="wf-materials-head">
        {groups.length > 1 ? (
          <MenuRoot>
            <MenuTrigger asChild>
              <button className="wf-group-switch ui-state ui-focus" type="button">
                {group.label}
                <Icon decorative name="expand" size="xs" />
              </button>
            </MenuTrigger>
            <MenuSurface align="start" side="top">
              <MenuRadioGroup onValueChange={onGroup} value={group.id}>
                {groups.map((item) => (
                  <MenuRadioItem key={item.id} value={item.id}>
                    {item.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSurface>
          </MenuRoot>
        ) : (
          <span className="wf-group-label">{group.label}</span>
        )}
        <BlockedReason reason={addBlocked}>
          <Button
            aria-disabled={addBlocked === undefined ? undefined : true}
            leadingIcon="add"
            onClick={() => {
              if (addBlocked === undefined) onAdd()
            }}
            size="md"
            variant="outlined"
          >
            加入成片
          </Button>
        </BlockedReason>
        <span className="wf-materials-hint">
          {range === null
            ? '点一个镜头选中它，拖两端调整范围'
            : `拖动两端调整范围 ${seconds(range.startMs)}–${seconds(range.endMs)} 秒`}
        </span>
      </div>
      <div className="wf-takes">
        {group.takes.map((take) => (
          <TakeRow
            key={take.id}
            keyframes={keyframes}
            onDrop={onDrop}
            onRange={onRange}
            onVersion={onVersion}
            range={range?.takeId === take.id ? range : null}
            take={take}
            version={versionOf(take)}
          />
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
  onRange: (range: MaterialRange) => void
  onVersion: (takeId: string, jobId: string) => void
  onDrop: (clientX: number, clientY: number) => boolean
}

type RangeDrag = {
  pointerId: number
  originX: number
  edge: 'start' | 'end' | 'body'
  base: MaterialRange
  moved: boolean
}

function TakeRow({ take, version, keyframes, range, onRange, onVersion, onDrop }: TakeRowProps) {
  const stripRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<RangeDrag | null>(null)
  const [lifting, setLifting] = useState(false)
  const state = keyframes.get(version.url)
  const durationMs = state?.kind === 'ready' ? Math.round(state.index.duration * 1000) : undefined

  const msPerPx = () => {
    const width = stripRef.current?.getBoundingClientRect().width ?? 0
    return durationMs === undefined || width <= 0 ? 0 : durationMs / width
  }

  const press = (event: PointerEvent<HTMLElement>, edge: RangeDrag['edge']) => {
    if (range === null || event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      edge,
      base: range,
      moved: false,
    }
  }

  const drag = (event: PointerEvent<HTMLElement>) => {
    const current = dragRef.current
    if (current === null || current.pointerId !== event.pointerId || durationMs === undefined)
      return
    const deltaPx = event.clientX - current.originX
    if (!current.moved && Math.abs(deltaPx) <= DRAG_THRESHOLD) return
    current.moved = true
    if (current.edge === 'body') {
      setLifting(true)
      return
    }
    const delta = Math.round(deltaPx * msPerPx())
    const { base } = current
    onRange(
      current.edge === 'start'
        ? {
            ...base,
            startMs: Math.min(Math.max(0, base.startMs + delta), base.endMs - MIN_CLIP_MS),
          }
        : {
            ...base,
            endMs: Math.max(Math.min(durationMs, base.endMs + delta), base.startMs + MIN_CLIP_MS),
          },
    )
  }

  const release = (event: PointerEvent<HTMLElement>) => {
    const current = dragRef.current
    if (current === null || current.pointerId !== event.pointerId) return
    releasePointer(event)
    dragRef.current = null
    setLifting(false)
    if (current.edge === 'body' && current.moved) onDrop(event.clientX, event.clientY)
  }

  const cancel = () => {
    dragRef.current = null
    setLifting(false)
  }

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
            const poster = videoSnapshotUrl(version.url, 240, (shot.start + shot.end) / 2)
            const picked =
              range !== null &&
              range.jobId === version.jobId &&
              range.startMs === startMs &&
              range.endMs === endMs
            return (
              <button
                aria-label={`${take.label} 镜头 ${at + 1}，${seconds(startMs)}–${seconds(endMs)} 秒`}
                aria-pressed={picked}
                className="wf-shot ui-focus"
                key={startMs}
                onClick={() => onRange({ jobId: version.jobId, takeId: take.id, startMs, endMs })}
                style={{ flexGrow: shot.end - shot.start }}
                type="button"
              >
                {poster === undefined ? null : <img alt="" draggable={false} src={poster} />}
                <span className="wf-shot-text">
                  <b>镜头 {at + 1}</b>
                  <span>
                    {seconds(startMs)}–{seconds(endMs)} 秒
                  </span>
                </span>
              </button>
            )
          })
        )}
        {range !== null && range.jobId === version.jobId && durationMs !== undefined ? (
          <div
            aria-label={`选中的范围 ${seconds(range.startMs)}–${seconds(range.endMs)} 秒，拖到成片轨上可加入`}
            className={cn('wf-range', lifting && 'is-lifting')}
            onPointerCancel={cancel}
            onPointerDown={(event) => press(event, 'body')}
            onPointerMove={drag}
            onPointerUp={release}
            role="group"
            style={{
              left: `${(range.startMs / durationMs) * 100}%`,
              width: `${((range.endMs - range.startMs) / durationMs) * 100}%`,
            }}
          >
            {(['start', 'end'] as const).map((edge) => (
              <TrimHandle
                bounds={{ min: 0, max: durationMs / 1000 }}
                edge={edge}
                key={edge}
                onKeyDown={(event) => {
                  const step = event.shiftKey ? 1000 : 100
                  const sign = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
                  if (sign === 0) return
                  event.preventDefault()
                  const delta = sign * step
                  onRange(
                    edge === 'start'
                      ? {
                          ...range,
                          startMs: Math.min(
                            Math.max(0, range.startMs + delta),
                            range.endMs - MIN_CLIP_MS,
                          ),
                        }
                      : {
                          ...range,
                          endMs: Math.max(
                            Math.min(durationMs, range.endMs + delta),
                            range.startMs + MIN_CLIP_MS,
                          ),
                        },
                  )
                }}
                onPointerCancel={cancel}
                onPointerDown={(event) => press(event, edge)}
                onPointerMove={drag}
                onPointerUp={release}
                pressed={false}
                style={edge === 'start' ? { left: 0 } : { left: '100%' }}
                value={(edge === 'start' ? range.startMs : range.endMs) / 1000}
                valueText={`${seconds(edge === 'start' ? range.startMs : range.endMs)} 秒`}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
