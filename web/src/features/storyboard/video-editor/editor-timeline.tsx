import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import type { PeaksState } from '../editing/media-analysis'
import { roundSeconds } from '../editing/time-label'
import { Frames, TimelinePlayhead, TimelineRuler, Wave } from '../editing/timeline'
import { useRovingFocus } from '../editing/timeline-drag'
import { shiftSelect } from '../editing/range-select'
import { selectedUnits, shotUnitId, stepSelect, type Selection, type Unit } from './composition'
import { spansOverlap, type EditBlock, type Shot } from './edit-blocks'
import './editor-timeline.css'

const secondsText = (value: number) => value.toFixed(1)

type Span = { start: number; end: number }

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

type ShellProps = {
  scale: number
  position: number
  heads: ReactNode
  /** 编辑轨的行数。 */
  editRows: number
  onSeek: (time: number) => void
  onScrub: () => void
  children: ReactNode
}

/** 按元素的横向范围把指针位置换成时间线上的时刻。 */
const clockIn = (lanes: HTMLElement | null, scale: number, clientX: number) => {
  const bounds = lanes?.getBoundingClientRect()
  if (bounds === undefined || bounds.width === 0) return 0
  return Math.min(scale, Math.max(0, ((clientX - bounds.left) / bounds.width) * scale))
}

/** 剪辑视图的时间线外壳：轨头一列、标尺（只有它能定位）、轨道与播放头；刻度按原片时间。 */
function TimelineShell({
  scale,
  position,
  heads,
  editRows,
  onSeek,
  onScrub,
  children,
}: ShellProps) {
  const lanesRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bounded = Math.max(0, Math.min(scale, position))
  return (
    <section
      aria-label="视频编辑时间线"
      className="video-editor-timeline"
      style={{ '--edit-rows': editRows } as CSSProperties}
    >
      <div aria-hidden="true" className="video-editor-timeline-heads">
        {heads}
      </div>
      <span aria-hidden="true" className="video-editor-timeline-divider" />
      <div
        aria-label="时间线轨道，窄屏可横向滚动"
        className="video-editor-timeline-scroll"
        ref={scrollRef}
        role="region"
      >
        <div className="video-editor-timeline-lanes" ref={lanesRef}>
          <TimelineRuler
            clockAt={(clientX) => clockIn(lanesRef.current, scale, clientX)}
            currentTime={bounded}
            onScrub={onScrub}
            onSeek={onSeek}
            scale={scale}
            total={scale}
            viewportRef={scrollRef}
          />
          {children}
          <TimelinePlayhead style={{ left: `${(bounded / scale) * 100}%` }} />
        </div>
      </div>
    </section>
  )
}

type ClipsTimelineProps = {
  rootUrl: string
  /** 原片时长：时间线的刻度，选用不改变它。 */
  duration: number
  shots: readonly Shot[]
  blocks: readonly EditBlock[]
  /** 原片轨上的选区单位（没被替换的镜头与已选用的编辑片段）。 */
  units: readonly Unit[]
  selection: Selection
  /** 播放头在原片时间轴上的位置。 */
  anchor: number
  peaksOf: (url: string) => PeaksState
  onSeek: (anchor: number) => void
  onScrub: () => void
  onSelectUnits: (ids: readonly string[]) => void
  onClickBlock: (id: string) => void
  selectionBoxRef: Ref<HTMLSpanElement>
}

const blockStatus = (block: EditBlock, picked: boolean): { chip: string; name: string } => {
  switch (block.state.kind) {
    case 'ready': {
      const length = `${secondsText(block.state.duration)} 秒`
      return {
        chip: `${block.name} · ${length}`,
        name: `${block.name} · ${length} · ${picked ? '已选用' : '未选用'}`,
      }
    }
    case 'running':
      return { chip: `${block.name} · 生成中`, name: `${block.name} · 生成中` }
    case 'measuring':
      return { chip: `${block.name} · 读取中`, name: `${block.name} · 读取中` }
    case 'unreadable':
      return { chip: `${block.name} · 无法读取`, name: `${block.name} · 无法读取` }
  }
}

/** 片段的时间线：上面原片轨按镜头摆、固定在原片时间；下面编辑轨，每条编辑片段正对它替换的镜头。 */
export function ClipsTimeline({
  rootUrl,
  duration,
  shots,
  blocks,
  units,
  selection,
  anchor,
  peaksOf,
  onSeek,
  onScrub,
  onSelectUnits,
  onClickBlock,
  selectionBoxRef,
}: ClipsTimelineProps) {
  const percent = (time: number) => `${(time / duration) * 100}%`
  const span = ({ start, end }: Span): CSSProperties => ({
    left: `calc(${percent(start)} + 1px)`,
    width: `calc(${percent(end - start)} - 2px)`,
  })
  const order = units.map((unit) => unit.id)
  const unitOf = (shot: Shot) =>
    units.find((unit) => unit.start <= shot.start && shot.end <= unit.end)
  const chosen = selectedUnits(units, selection)
  const chosenIds = chosen.map((unit) => unit.id)
  const first = chosen[0]
  const last = chosen.at(-1)
  const editIds = new Set(units.flatMap((unit) => (unit.kind === 'edit' ? [unit.id] : [])))
  const rows = Math.max(1, ...blocks.map((block) => block.row + 1))
  const roving = useRovingFocus(
    shots.map(shotUnitId),
    first === undefined ? undefined : shotIdAt(shots, first.start),
  )

  const clickShot = (shot: Shot, extend: boolean) => {
    const unit = unitOf(shot)
    if (unit === undefined) return
    roving.remember(shotUnitId(shot))
    onSelectUnits(extend ? shiftSelect(order, chosenIds, unit.id) : [unit.id])
  }

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, shot: Shot) => {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : undefined
    const unit = unitOf(shot)
    if (direction === undefined || unit === undefined) return
    event.preventDefault()
    const next = stepSelect(order, chosenIds, unit.id, direction, event.shiftKey)
    const target = units.find((item) => item.id === next.focus)
    onSelectUnits(next.selection)
    if (target !== undefined) roving.focus(shotIdAt(shots, target.start))
  }

  const ring =
    selection?.kind === 'edit'
      ? blocks.find((block) => block.id === selection.id)
      : first === undefined || last === undefined
        ? undefined
        : { start: first.start, end: last.end }

  return (
    <TimelineShell
      editRows={rows}
      heads={
        <>
          <span className="video-editor-timeline-head is-film">
            <Icon decorative name="video" size="sm" />
            原片
          </span>
          <span className="video-editor-timeline-head is-edit">
            <Icon decorative name="edit-segment" size="sm" />
            编辑
          </span>
        </>
      }
      onScrub={onScrub}
      onSeek={onSeek}
      position={anchor}
      scale={duration}
    >
      <div aria-label="原片" className="video-editor-timeline-track" role="group">
        {shots.map((shot) => {
          const unit = unitOf(shot)
          const replaced = unit?.kind === 'edit'
          const id = shotUnitId(shot)
          return (
            <button
              aria-label={`镜头 ${shot.no} · ${roundSeconds(shot.start)}–${roundSeconds(shot.end)} 秒${replaced ? ' · 已换成编辑片段' : ''}`}
              aria-pressed={unit !== undefined && chosenIds.includes(unit.id)}
              className={cn('video-editor-timeline-block is-film ui-focus', replaced && 'is-off')}
              key={id}
              onClick={(event) => clickShot(shot, event.shiftKey)}
              onFocus={() => roving.remember(id)}
              onKeyDown={(event) => keyDown(event, shot)}
              ref={roving.register(id)}
              style={span(shot)}
              tabIndex={roving.tabIndexOf(id)}
              type="button"
            >
              <Faces
                end={shot.end}
                mediaUrl={rootUrl}
                peaks={peaksOf(rootUrl)}
                start={shot.start}
              />
              <span className="video-editor-timeline-chip">镜头 {shot.no}</span>
            </button>
          )
        })}
      </div>

      <div aria-label="编辑片段" className="video-editor-timeline-track" role="group">
        {shots.map((shot) => {
          const taken =
            blocks.some(
              (block) => block.row === 0 && spansOverlap(block, { from: shot.no, to: shot.no }),
            ) || unitOf(shot)?.kind === 'edit'
          return taken ? null : (
            <button
              aria-label={`生成镜头 ${shot.no}`}
              className="video-editor-timeline-slot ui-focus"
              key={`slot-${shot.no}`}
              onClick={(event) => clickShot(shot, event.shiftKey)}
              style={span(shot)}
              tabIndex={-1}
              type="button"
            >
              <Icon decorative name="add" size="xs" />
              生成
            </button>
          )
        })}
        {blocks.map((block) => {
          const picked = editIds.has(block.id)
          const status = blockStatus(block, picked)
          const { kind } = block.state
          return (
            <button
              aria-label={status.name}
              aria-pressed={selection?.kind === 'edit' && selection.id === block.id}
              className={cn(
                'video-editor-timeline-block is-edit ui-focus',
                (kind === 'running' || kind === 'measuring') && 'is-running',
                kind === 'unreadable' && 'is-failed',
                kind === 'ready' && !picked && 'is-off',
              )}
              key={block.id}
              onClick={() => onClickBlock(block.id)}
              style={{ ...span(block), '--row': block.row } as CSSProperties}
              type="button"
            >
              {block.state.kind === 'ready' && block.job.outputUrl !== null ? (
                <>
                  <Faces
                    end={block.state.duration}
                    mediaUrl={block.job.outputUrl}
                    peaks={peaksOf(block.job.outputUrl)}
                    start={0}
                  />
                  <span className="video-editor-timeline-chip">{status.chip}</span>
                </>
              ) : (
                <span className="video-editor-timeline-status">
                  <Icon decorative name={kind === 'unreadable' ? 'alert' : 'sparkles'} size="xs" />
                  {status.chip}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {ring === undefined ? null : (
        <span
          aria-hidden="true"
          className={cn(
            'video-editor-timeline-box',
            selection?.kind === 'edit' ? 'is-edit' : 'is-film',
          )}
          ref={selectionBoxRef}
          style={{ ...span(ring), '--row': 'row' in ring ? ring.row : 0 } as CSSProperties}
        />
      )}
    </TimelineShell>
  )
}

/** 某个原片时刻所在镜头的按钮 id。 */
const shotIdAt = (shots: readonly Shot[], time: number) => {
  const shot = shots.find((item) => item.start <= time && time < item.end) ?? shots[0]
  return shot === undefined ? '' : shotUnitId(shot)
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
