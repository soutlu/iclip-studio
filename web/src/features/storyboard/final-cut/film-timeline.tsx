import { Fragment, useRef, useState, type RefObject } from 'react'
import type { TimeSpan } from '@/shared/lib/time-spans'
import { cn } from '@/shared/lib/utils'
import { useAudioPeaks } from '../editing/media-analysis'
import { TimelineRuler } from '../editing/timeline'
import type { Edge } from '../editing/timeline-drag'
import { useStableValue } from '../editing/use-stable-value'
import { ContextMenuRoot, ContextMenuSurface, ContextMenuTrigger } from '@/shared/ui/menu'
import {
  editGroup,
  groupTrimmed,
  groupTrimRange,
  playheadSplit,
  timingOf,
  type Cut,
  type Links,
  type SourceLength,
  type Timing,
} from './clip-edit'
import { carveBadgeOf, mutedBadgeOf } from './clip-badges'
import { ClipMenuItems } from './clip-menu'
import { GapMenuItems } from './gap-menu'
import { thumbnailUrl, type ComponentCatalog } from './component-catalog'
import { isMediaClip, type FilmClip } from './composition/film'
import type { DubLook } from './dub-look'
import type { EditTool } from './editor-toolbar'
import type { AttributeChanges } from './original-sound'
import {
  namedRows,
  rowsOf,
  sameRow,
  targetIn,
  type Row,
  type RowKey,
  type RowTarget,
  type Zone,
} from './placement'
import type { PlayheadClock } from './playhead-clock'
import { playheadInto } from './selection'
import { soundActionFor, soundBadgeOf, soundPairOf, type SoundControls } from './sound-pair'
import {
  beatsToSnap,
  isBeatSource,
  snapEdgeToBeats,
  timelineBeats,
  type BeatGrid,
} from './music-beats'
import { TimelineClip } from './timeline-clip'
import { FilmPlayhead, Skimmer } from './timeline-cursors'
import { TrackHeads } from './timeline-heads'
import { aimAt, keyOf } from './timeline-lanes'
import { msToPx, pxToMs, snapTargets, type TimelineScale } from './timeline-scale'
import { edgeAt, type Following } from './use-clip-gesture'
import { usePlayheadGrab } from './use-playhead-grab'
import { useRazorLanes } from './use-razor-lanes'
import { useTimelineMarquee } from './use-timeline-marquee'
import { useGapMenu } from './use-gap-menu'
import { INSET, useTimelineViewport } from './use-timeline-viewport'
import type { EnvelopePoint } from './volume-envelope'

/** 素材拖进来时落在哪：哪一行（或新开的一行）、final-cut 的第几毫秒。 */
export type TimelinePoint = { row: RowTarget; timeMs: number }

export type TimelineHandle = {
  /**
   * 屏幕上的这个点给 `zone` 区的素材落在哪一行、对应 final-cut 的第几毫秒；不在任何一行上时是 null。
   * 画面区的素材对着两行之间的缝时归离得近的那一行，声音区的素材和拖片段一样在缝里新开一行。
   */
  locate: (clientX: number, clientY: number, zone: Zone) => TimelinePoint | null
  /** 时间线现在横向滚到的位置（像素）。 */
  scrollLeft: () => number
  /** 把这个片段滚到看得见的地方。 */
  reveal: (id: string) => void
}

/** 拖着的素材会落在哪里：`duration` 是它的总长（毫秒），`guideMs` 是它吸上的时间点。 */
export type DropGhost = { row: RowTarget; start: number; duration: number; guideMs: number | null }

type FilmTimelineProps = {
  /** final-cut 里所有的片段。 */
  clips: readonly FilmClip[]
  /** 显示着的语言下没字的字幕（没翻的、空着的）：片段上写「待输入字幕」。 */
  blankCaptions: ReadonlySet<string>
  /** 各配音片段顶行的样子（见 `dubLooksOf`），按片段编号。 */
  dubLooks: ReadonlyMap<string, DubLook>
  /**
   * 还没有配音行时，在声音区最上面（配音行生成后在的地方）占一行写的引导；不用引导时是 null。
   * 它下面的位置拖得进片段时，拖到它上面就在那里新开一行。
   */
  dubHint: string | null
  /** 显示着的语言在配音：视频片段的原声不出声。 */
  dubbing: boolean
  /** 元素或模板片段在当前展示语言下的正文内容，用于悬停提示拼接为「名称 · 正文」；无文本时省略。 */
  hostTexts: ReadonlyMap<string, string>
  /** 片段的链接名：链接的片段一起切。 */
  links: Links
  /**
   * 点下去做什么。切开（剃刀）时点片段在点的地方切开它、按着 Shift 点切开那个时间上所有的片段，
   * 不选中、不拖动、不框选、不裁剪。
   */
  tool: EditTool
  /** 切开几个片段（剃刀，或右键菜单里的「在播放头处切开」）。 */
  onSplit: (cuts: readonly Cut[]) => void
  /** 组件库目录：供元素与模板片段读取平铺封面图。 */
  catalog: ComponentCatalog
  totalMs: number
  /** 播放头节流时刻（播放期间约每 0.1 秒同步一次），供吸附、切开提示与时间尺计算。 */
  playheadMs: number
  /** 播放头实时时钟源：播放头竖线直接订阅，实现播放期间逐帧移动而不触发整条时间线重绘。 */
  clock: PlayheadClock
  buffered: readonly TimeSpan[]
  scale: TimelineScale
  ghost: DropGhost | null
  /** 选中的片段。 */
  selected: ReadonlySet<string>
  /** 拖动和裁剪时要不要吸到别的片段的两端和播放头上，都没吸上时再吸配乐的节拍。 */
  snap: boolean
  /** 配乐算出来的节拍，按音频地址；还没算出来、算不出来的不在里面。 */
  beats: ReadonlyMap<string, BeatGrid>
  /** 视频片段、音频片段素材的总长（毫秒），还没读到时是 undefined；裁结尾时不超出它。 */
  sourceMs: SourceLength
  /** 换成这些选中的片段（空的就是全部取消）。 */
  onSelect: (ids: ReadonlySet<string>) => void
  /** 双击了一个片段：只选中它，侧栏切到「属性」。 */
  onInspect: (id: string) => void
  /** 开始或结束框选、拖片段；中途按 Esc 由时间线自己取消。 */
  onGesture: (active: boolean) => void
  /** 正在拖片段、框选或拖「原片截取」：这时点右键不出菜单，不打断它。 */
  gesturing: boolean
  /** 给了就把时间线横向滚到 `left`（像素）；每次给新的对象才滚。 */
  scrollRequest: { left: number } | null
  /** 改几个片段各自的起止和入点（在行里挪、裁剪），一起算一步。 */
  onRetime: (timings: ReadonlyMap<string, Timing>) => void
  /**
   * 把片段换到另一行（或新开的一行）的 `start` 处；`starts` 是和它一起挪的片段各自的新起点，
   * 它们留在原来的行。
   */
  onMove: (id: string, row: RowTarget, start: number, starts: ReadonlyMap<string, number>) => void
  /** 把几个片段各自挪到新的起点（合拢空档用）。 */
  onRestart: (starts: ReadonlyMap<string, number>) => void
  /** 选中的片段波形上改了音量曲线：换成这些点，一步撤销。 */
  onEnvelope: (id: string, points: readonly EnvelopePoint[]) => void
  /** 把 `row` 这一行的片段一起隐藏（`hidden` 为真，声音区的行就是静音）或显示回来。 */
  onHide: (row: RowKey, hidden: boolean) => void
  /** 片段右键菜单：隐藏或显示一个片段（音频片段就是静音）。 */
  onHideClip: (id: string, hidden: boolean) => void
  /** 片段右键菜单：改片段上的几个属性（视频片段的静音）。 */
  onAttributes: (id: string, changes: AttributeChanges) => void
  /** 片段右键菜单：删掉选中的片段，和按 Delete 一样。 */
  onRemove: () => void
  /** 这个地址的视频素材确认没有声音。 */
  silentSource: (src: string) => boolean
  /** 片段右键菜单：分离音频、合并回视频、联动、对齐口型、选中另一段。 */
  soundControls: SoundControls
  onSeek: (ms: number) => void
  /** 点选片段后把播放头挪进它里面：一次普通的定位，正在播放时接着播。 */
  onJump: (ms: number) => void
  onViewportWidth: (width: number) => void
  handleRef: RefObject<TimelineHandle | null>
}

const NOTHING: ReadonlySet<string> = new Set()

/**
 * 时间线：final-cut 里的片段按行排开，画面区的行在上、有字幕时中间一行「字幕」、声音区的行在下，最下面是一条
 * 可以新开一行的空行。
 * 片段可以选中一个或几个（在空白处拖出框来框选）、在自己的区里挪动、裁两端；上面是时间尺和播放头。
 */
export function FilmTimeline({
  clips,
  blankCaptions,
  dubLooks,
  dubHint,
  dubbing,
  hostTexts,
  links,
  tool,
  onSplit,
  catalog,
  totalMs,
  playheadMs,
  clock,
  buffered,
  scale,
  ghost,
  selected,
  snap,
  beats,
  sourceMs,
  onSelect,
  onInspect,
  onGesture,
  gesturing,
  scrollRequest,
  onRetime,
  onMove,
  onRestart,
  onEnvelope,
  onHide,
  onHideClip,
  onAttributes,
  onRemove,
  silentSource,
  soundControls,
  onSeek,
  onJump,
  onViewportWidth,
  handleRef,
}: FilmTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const headsRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const rulerBarRef = useRef<HTMLDivElement>(null)
  // 拖动片段时吸上的时间点；拖素材进来时吸上的点由 `ghost` 带着
  const [clipGuideMs, setClipGuideMs] = useState<number | null>(null)
  const guideMs = clipGuideMs ?? ghost?.guideMs ?? null
  // 拖着片段要在第几行的位置新开一行；拖素材进来时同样由 `ghost` 带着
  const [clipOpening, setClipOpening] = useState<number | null>(null)
  const opening =
    clipOpening ?? (ghost === null || 'track' in ghost.row ? null : ghost.row.insertAt)
  // 成组拖动中跟着动的片段；每个片段只知道自己素材的总长，一起裁到哪里在这一层算
  const [following, setFollowing] = useState<Following | null>(null)
  const peaks = useAudioPeaks(
    useStableValue([...new Set(clips.filter(isMediaClip).map((clip) => clip.src))]),
  )
  const membersOf = (group: ReadonlySet<string>) => clips.filter((clip) => group.has(clip.id))
  const trimRange = (clip: FilmClip, group: ReadonlySet<string>, edge: Edge) => {
    const range = groupTrimRange(membersOf(group), edge, clips, sourceMs)
    const edgeMs = edgeAt(timingOf(clip), edge)
    return { min: edgeMs + range.min, max: edgeMs + range.max }
  }
  const trimTo = (clip: FilmClip, group: ReadonlySet<string>, edge: Edge, edgeMs: number) =>
    groupTrimmed(membersOf(group), edge, edgeMs - edgeAt(timingOf(clip), edge), clips, sourceMs)
  const { pps, contentWidth } = scale
  const snapBeats = timelineBeats(clips, beats, pps)
  const rows = rowsOf(clips)
  // 还没有片段时也留一行（画面区的第 0 行），镜头拖得进来
  const shown = namedRows<Row>(rows.length === 0 ? [{ zone: 'visual', track: 0, clips: [] }] : rows)
  // 要在别的位置新开一行时，最下面那条空行挪到那里去：总高度不变，上面的行不动、下面的行往下让
  const openedAt = opening !== null && opening < rows.length ? opening : null
  // 配音行的引导占在声音区最上面（生成的配音行就在那里），还没有声音区的行时在最后一行下面
  const firstAudio = rows.findIndex((row) => row.zone === 'audio')
  const hintAt =
    dubHint === null || rows.length === 0 ? null : firstAudio === -1 ? rows.length : firstAudio
  // 引导在两行之间时，在它那个位置新开的行由它自己顶上（见 `hintLane`）；在最后一行下面时只是写着字
  const hintTakesOpening = hintAt !== null && hintAt < rows.length
  /** 第 `at` 行的位置要不要另画一条让出来的新行（引导顶上的那一处不另画）。 */
  const openingAt = (at: number) => openedAt === at && !(hintTakesOpening && at === hintAt)

  const timeAt = (clientX: number) =>
    pxToMs(clientX - (contentRef.current?.getBoundingClientRect().left ?? 0), pps)

  /** `zone` 区的片段对着这个高度时落在哪一行：片段只待在自己的区里。 */
  const rowAt = (clientY: number, between: boolean, zone: Zone): RowTarget | undefined => {
    const aim = aimAt({ scrollRef, rulerBarRef, contentRef }, rows, clientY, between)
    if (aim === undefined) return undefined
    // 还没有片段时只有画面区那一条空行
    if (rows.length === 0) return { zone: 'visual', track: 0 }
    return targetIn(rows, aim, zone)
  }

  useTimelineViewport({
    scrollRef,
    headsRef,
    contentRef,
    onViewportWidth,
    scrollRequest,
    handleRef,
    rowAt,
    timeAt,
  })

  /** 拖着的素材会落在 `row` 这一行时，画出它会占的位置；不落在这一行是 null。 */
  const dropGhost = (row: RowTarget) =>
    ghost !== null && sameRow(ghost.row, row) ? (
      <span
        aria-hidden="true"
        className="wf-drop-ghost"
        data-testid="drop-ghost"
        style={{
          left: msToPx(ghost.start, pps),
          width: Math.max(2, msToPx(ghost.duration, pps) - 2),
        }}
      />
    ) : null

  /** 拖着的素材会落进在第 `insertAt` 行的位置新开的那一行时，画出它会占的位置。 */
  const newRowGhost = (insertAt: number) =>
    ghost !== null && 'insertAt' in ghost.row && ghost.row.insertAt === insertAt
      ? dropGhost(ghost.row)
      : null

  const { closing, openGapMenu } = useGapMenu({ clips, gesturing, timeAt })

  // 修饰键（Shift / ⌘ / Ctrl）点击切换多选，普通点击单选；
  // 普通单选且播放头位于片段外时自动将播放头移入片段（拖拽落位、右键选中及多选切换不移动播放头）
  const pick = (id: string, toggle: boolean, clicked: boolean) => {
    if (!toggle) {
      onSelect(new Set([id]))
      const clip = clips.find((each) => each.id === id)
      // 按点击瞬间播放头竖线的精确时刻判定（播放期间 state 层的 playheadMs 最多滞后约 0.1 秒）
      const into = clicked && clip !== undefined ? playheadInto(clock.get(), clip) : null
      if (into !== null) onJump(into)
      return
    }
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelect(next)
  }

  const { marquee, dropFraming, pressLanes, dragLanes, releaseLanes } = useTimelineMarquee({
    contentRef,
    selected,
    onSelect,
    onGesture,
  })
  const shownSelection = marquee?.ids ?? selected

  const razor = tool === 'razor'
  const razorLanes = useRazorLanes({ razor, clips, links, timeAt, onSplit })

  /**
   * 指针拖着播放头或时间尺落在 `ms` 时定位到哪：夹在 final-cut 的长度里，开启吸附时优先吸附至片段端点，其次吸附配乐
   * 节拍（排除播放头自身）。悬停游标的读数也按它，和按下去会定到的地方一样。
   */
  const pointerSeekAt = (ms: number) => {
    const at = Math.max(0, Math.min(totalMs, ms))
    return snap
      ? snapEdgeToBeats(at, snapTargets(clips, null), beatsToSnap(snapBeats, NOTHING), pps)
      : { ms: at, guideMs: null }
  }
  /** 拖拽播放头或时间尺定位至 `ms`（吸附规则见 `pointerSeekAt`，吸上时画吸附线）；键盘定位不经由此处且不触发吸附。 */
  const scrubTo = (ms: number) => {
    const snapped = pointerSeekAt(ms)
    setClipGuideMs(snapped.guideMs)
    onSeek(snapped.ms)
  }
  const endScrub = () => setClipGuideMs(null)

  const {
    scrubbing,
    overPlayhead,
    setOverPlayhead,
    pressPlayhead,
    dragPlayhead,
    releasePlayhead,
    cancelPlayhead,
    hoverPlayhead,
  } = usePlayheadGrab({
    razor,
    totalMs,
    selected,
    rulerBarRef,
    gesturing,
    timeAt,
    scrubTo,
    endScrub,
    onSelect,
    pick,
  })

  /** 配音行的引导那一行；有片段拖到它上面要在那里新开一行时，它自己换成新开的那一行（不另让出一行）。 */
  const hintLane = (at: number) => {
    const opened = openedAt === at
    return (
      <div
        className={cn('wf-lane is-hint', opened && 'is-new is-opening')}
        data-hint=""
        data-insert-at={hintTakesOpening ? at : undefined}
      >
        {opened ? (
          (newRowGhost(at) ?? <span className="wf-lane-hint">新开一行</span>)
        ) : (
          <span className="wf-lane-hint">{dubHint}</span>
        )}
      </div>
    )
  }

  return (
    <div className="wf-tracks" ref={scrollRef}>
      <div className="wf-track-inner">
        <TrackHeads
          clips={clips}
          headsRef={headsRef}
          hintAt={hintAt}
          onHide={onHide}
          openingAt={openingAt}
          shown={shown}
        />
        <div
          className="wf-track-content"
          ref={contentRef}
          style={{ width: contentWidth, marginLeft: INSET.left, marginRight: INSET.right }}
        >
          <div className="wf-track-top" ref={rulerBarRef}>
            <TimelineRuler
              buffered={buffered}
              clockAt={(clientX) => timeAt(clientX) / 1000}
              currentTime={playheadMs / 1000}
              disabled={totalMs <= 0}
              onPointerSeek={(clock) => scrubTo(Math.round(clock * 1000))}
              onScrub={() => {}}
              onSeek={(clock) => onSeek(Math.round(clock * 1000))}
              onSeekEnd={endScrub}
              scale={contentWidth / pps}
              tickScale={scale.viewSeconds}
              clockTicks
              hoverGuide={false}
              total={totalMs / 1000}
              viewportRef={scrollRef}
            />
            <FilmPlayhead clock={clock} dragging={scrubbing} pps={pps} totalMs={totalMs} />
            <Skimmer
              contentRef={contentRef}
              place={(ms) =>
                totalMs <= 0
                  ? null
                  : razor
                    ? Math.max(0, Math.min(totalMs, ms))
                    : pointerSeekAt(ms).ms
              }
              pps={pps}
              quiet={gesturing || scrubbing}
              razor={razor}
            />
          </div>
          <div
            className={cn('wf-lanes', razor && 'is-razor')}
            data-on-playhead={overPlayhead || scrubbing ? '' : undefined}
            onPointerCancel={(event) => {
              if (!cancelPlayhead(event)) dropFraming()
            }}
            onPointerDown={pressLanes}
            onPointerDownCapture={pressPlayhead}
            onPointerLeave={() => setOverPlayhead(false)}
            onPointerMove={(event) => {
              hoverPlayhead(event)
              if (!dragPlayhead(event)) dragLanes(event)
            }}
            onPointerUp={(event) => {
              if (!releasePlayhead(event)) releaseLanes(event)
            }}
            {...(razor ? razorLanes : {})}
          >
            {shown.map((row, at) => (
              <Fragment key={keyOf(row)}>
                {at === hintAt ? hintLane(at) : null}
                {openingAt(at) ? (
                  <div aria-hidden="true" className="wf-lane is-new is-opening" data-insert-at={at}>
                    {newRowGhost(at) ?? <span className="wf-lane-hint">新开一行</span>}
                  </div>
                ) : null}
                <ContextMenuRoot>
                  <ContextMenuTrigger asChild>
                    <div
                      aria-label={row.name}
                      className="wf-lane"
                      data-track={row.track}
                      data-zone={row.zone}
                      onContextMenu={(event) => openGapMenu(event, row)}
                      role="group"
                    >
                      {row.clips.map((clip) => (
                        <TimelineClip
                          clip={clip}
                          clips={clips}
                          contentRef={contentRef}
                          cover={clip.kind === 'host' ? thumbnailUrl(catalog, clip.item) : null}
                          text={hostTexts.get(clip.id)}
                          withSound={
                            clip.kind === 'video' && soundPairOf(clip, clips) === undefined
                          }
                          following={following}
                          groupFor={(kind) => editGroup(clip, selected, clips, kind)}
                          badge={
                            soundBadgeOf(clip, clips) ?? mutedBadgeOf(clip) ?? carveBadgeOf(clip)
                          }
                          blank={blankCaptions.has(clip.id)}
                          dub={dubLooks.get(clip.id)}
                          dubbing={dubbing}
                          key={clip.id}
                          onFollow={setFollowing}
                          gesturing={gesturing}
                          menu={
                            <ClipMenuItems
                              clip={clip}
                              clips={clips}
                              controls={soundControls}
                              onAttributes={onAttributes}
                              onHide={onHideClip}
                              onRemove={onRemove}
                              onSplit={onSplit}
                              silent={clip.kind === 'video' && silentSource(clip.src)}
                              sound={soundActionFor([clip], clips, silentSource)}
                              split={playheadSplit([clip], playheadMs, clips, links)}
                            />
                          }
                          onGesture={onGesture}
                          onGuide={setClipGuideMs}
                          onEnvelope={onEnvelope}
                          onMove={onMove}
                          onOpening={setClipOpening}
                          onRetime={onRetime}
                          onSelect={pick}
                          onInspect={onInspect}
                          peaks={
                            isMediaClip(clip)
                              ? (peaks.get(clip.src) ?? { kind: 'loading' })
                              : { kind: 'silent' }
                          }
                          playheadMs={playheadMs}
                          pps={pps}
                          rowAt={rowAt}
                          selected={shownSelection.has(clip.id)}
                          snap={snap}
                          beatGrid={isBeatSource(clip) ? beats.get(clip.src) : undefined}
                          snapBeats={snapBeats}
                          trimmable={!razor}
                          trimRange={trimRange}
                          trimTo={trimTo}
                        />
                      ))}
                      {dropGhost(row)}
                      {clips.length === 0 && ghost === null ? (
                        <span className="wf-lane-hint">
                          将「镜头」页签中的镜头拖到此处可加入轨道
                        </span>
                      ) : null}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuSurface aria-label="空档" className="wf-menu">
                    <GapMenuItems closing={closing} onRestart={onRestart} />
                  </ContextMenuSurface>
                </ContextMenuRoot>
              </Fragment>
            ))}
            {hintAt === shown.length ? hintLane(hintAt) : null}
            {clips.length === 0 || (openedAt !== null && openingAt(openedAt)) ? null : (
              <div
                aria-label="新的一行"
                className="wf-lane is-new"
                data-insert-at={rows.length}
                role="group"
              >
                {newRowGhost(rows.length) ?? (
                  <span className="wf-lane-hint">拖到此处可新开一行</span>
                )}
              </div>
            )}
          </div>
          {guideMs === null ? null : (
            <span
              aria-hidden="true"
              className="wf-snap-guide"
              data-testid="snap-guide"
              style={{ left: msToPx(guideMs, pps) }}
            />
          )}
          {marquee === null ? null : (
            <span
              aria-hidden="true"
              className="wf-marquee"
              data-testid="marquee"
              style={marquee.box}
            />
          )}
        </div>
      </div>
    </div>
  )
}
