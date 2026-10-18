import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { PopupAnchor, PopupRoot, PopupSurface } from '@/shared/ui/popup'
import type { PeaksState } from '../editing/media-analysis'
import { Frames, TimelinePlayhead, TimelineRuler, TrimHandle, Wave } from '../editing/timeline'
import { arrowStep } from '../editing/timeline-drag'
import type { TrackLane } from './component-placement'
import type { PlacedCaption } from './composition/captions'
import type { EditContext, MusicBeat } from './editing/context'
import type { Layer0Clip, VideoClip, WholeFilmDraft } from './editing/draft'
import { moveClip, trimClip } from './editing/layer0'
import { musicShortfallMs, setMusicOffset } from './editing/music'
import { moveOverlay, trimOverlay } from './editing/overlays'
import type { EditResult } from './editing/result'
import { filmDuration } from './editing/timeline'
import { msToPx, pxToMs, snapMs, snapTargets, type TimelineScale } from './timeline-scale'
import { usePreviewGesture } from './use-preview-gesture'

export type Selection =
  | { kind: 'clip'; id: string }
  | { kind: 'overlay'; id: string }
  | { kind: 'transition'; id: string }
  | { kind: 'music' }
  | null

export type MusicView = { url: string; title: string; peaks: PeaksState }

/**
 * 素材区、组件栏把东西拖上来时问成片区：指针落在哪条轨的哪个时刻（毫秒）；不在轨上是 undefined
 */
export type DropTarget = (
  clientX: number,
  clientY: number,
) => { timeMs: number; lane: TrackLane } | undefined

/** 成片轨上组件（片头片尾、包装、转场）的浮层：开着的是哪一个、怎么画它的内容 */
export type ComponentPopovers = {
  openId: string | null
  onOpen: (id: string | null) => void
  render: (id: string) => ReactNode
}

type FilmTracksProps = {
  draft: WholeFilmDraft
  context: EditContext
  scale: TimelineScale
  playheadMs: number
  onSeek: (ms: number) => void
  selection: Selection
  onSelect: (selection: Selection) => void
  snap: boolean
  /** 拍点（整片时间） */
  beats: readonly MusicBeat[]
  clipLabel: (clip: VideoClip) => string
  /** 组件名 → 组件目录里的中文名 */
  componentTitle: (name: string) => string
  urlOf: (sourceJobId: string) => string | undefined
  peaks: ReadonlyMap<string, PeaksState>
  music: MusicView | undefined
  apply: (result: EditResult) => boolean
  onViewportWidth: (width: number) => void
  dropTargetRef: RefObject<DropTarget | null>
  popovers: ComponentPopovers
  /** 放进整片的字幕（每段画面里的一份句子） */
  captions: readonly PlacedCaption[]
  /** 改字时输入框里的整句：改过的字或识别结果 */
  sentenceText: (caption: PlacedCaption) => string
  onCaptionText: (caption: PlacedCaption, text: string) => void
  /** 字幕样式的中文名；点它到组件栏换样式 */
  captionStyle: string
  onCaptionStyle: () => void
  /** 点画面轨两端的「+ 片头」「+ 片尾」：到组件栏挑那一端的组件 */
  onAddEndCard: (placement: 'intro' | 'outro') => void
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

/** 时间区左边的留白：画面轨开头的「+ 片头」放在这里（与 whole-film.css 的 .wf-track-content 一致） */
const START_GUTTER_PX = 72

const endCardName = (clip: Layer0Clip) =>
  clip.type === 'component' ? (clip.role === 'intro' ? '片头' : '片尾') : ''

type Edge = 'start' | 'end'

type BlockProps = {
  className: string
  name: string
  selected: boolean
  style: { left: string; width: string }
  onSelect: () => void
  /** 按住拖动；不给就只能点选 */
  onDrag: ((event: PointerEvent<HTMLElement>) => void) | undefined
  gesture: ReturnType<typeof usePreviewGesture>
  handles: ReactNode
  /** 点开的浮层（组件块才有） */
  popover?: ReactNode
  children: ReactNode
}

/** 轨道上的一块：整块是一个选中按钮（按住可拖），选中后两端出现修剪手柄 */
function Block({
  className,
  name,
  selected,
  style,
  onSelect,
  onDrag,
  gesture,
  handles,
  popover,
  children,
}: BlockProps) {
  return (
    <div
      aria-label={name}
      className={cn(className, selected && 'is-selected')}
      role="group"
      style={style}
    >
      {popover}
      <button
        aria-haspopup={popover === undefined ? undefined : 'dialog'}
        aria-label={`选中：${name}`}
        aria-pressed={selected}
        className="wf-block-body ui-focus"
        onClick={onSelect}
        onPointerCancel={gesture.cancel}
        onPointerDown={onDrag}
        onPointerMove={gesture.move}
        onPointerUp={(event) => {
          gesture.end(event)
        }}
        type="button"
      >
        {children}
      </button>
      {selected ? handles : null}
    </div>
  )
}

export function FilmTracks({
  draft,
  context,
  scale,
  playheadMs,
  onSeek,
  selection,
  onSelect,
  snap,
  beats,
  clipLabel,
  componentTitle,
  urlOf,
  peaks,
  music,
  apply,
  onViewportWidth,
  dropTargetRef,
  popovers,
  captions,
  sentenceText,
  onCaptionText,
  captionStyle,
  onCaptionStyle,
  onAddEndCard,
}: FilmTracksProps) {
  const gesture = usePreviewGesture(apply)
  const shown = gesture.preview ?? draft
  const total = filmDuration(shown)
  const { pps, contentWidth } = scale
  const beatsMs = beats.map((beat) => beat.timeMs)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const lanesRef = useRef<HTMLDivElement>(null)
  const filmLaneRef = useRef<HTMLDivElement>(null)
  const overlayLaneRef = useRef<HTMLDivElement>(null)
  const captionLaneRef = useRef<HTMLDivElement>(null)
  const musicLaneRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    // 时间区左边留出放「+ 片头」的空，时间区宽度要扣掉它
    const report = () => onViewportWidth(Math.max(0, element.clientWidth - START_GUTTER_PX))
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  }, [onViewportWidth])

  const timeAt = (clientX: number) =>
    Math.max(0, pxToMs(clientX - (contentRef.current?.getBoundingClientRect().left ?? 0), pps))

  const draftTotal = filmDuration(draft)
  useEffect(() => {
    dropTargetRef.current = (clientX, clientY) => {
      const lanes = lanesRef.current?.getBoundingClientRect()
      const content = contentRef.current?.getBoundingClientRect()
      if (lanes === undefined || content === undefined) return undefined
      const inside =
        clientX >= lanes.left &&
        clientX <= lanes.right &&
        clientY >= lanes.top &&
        clientY <= lanes.bottom
      if (!inside) return undefined
      const timeMs = Math.min(Math.max(0, pxToMs(clientX - content.left, pps)), draftTotal)
      // 从上往下第一条下沿在指针下方的轨；落在两条轨之间的空隙里时算下面那条
      const tracks: [TrackLane, HTMLDivElement | null][] = [
        ['film', filmLaneRef.current],
        ['overlay', overlayLaneRef.current],
        ['caption', captionLaneRef.current],
        ['music', musicLaneRef.current],
      ]
      const hit = tracks.find(([, element]) => {
        const rect = element?.getBoundingClientRect()
        return rect !== undefined && clientY <= rect.bottom
      })
      return { timeMs, lane: hit?.[0] ?? 'music' }
    }
    return () => {
      dropTargetRef.current = null
    }
  }, [dropTargetRef, pps, draftTotal])

  const selectedId = selection !== null && 'id' in selection ? selection.id : undefined
  const place = (start: number, duration: number) => ({
    left: `${msToPx(start, pps)}px`,
    width: `${msToPx(duration, pps)}px`,
  })

  /** 视频段要知道素材多长才能修剪；片头片尾随时可以 */
  const editable = (clip: Layer0Clip) =>
    clip.type === 'component' || context.sources[clip.sourceJobId] !== undefined

  const startTrim = (event: PointerEvent<HTMLElement>, clip: Layer0Clip, edge: Edge) => {
    event.stopPropagation()
    const edgeMs = clip.start + clip.duration
    // 吸附目标只取被拖段之前的边界（之后的边界随波纹一起动）、播放头与拍点
    const targets = snapTargets({
      spans: draft.layer0.slice(0, draft.layer0.indexOf(clip)),
      playheadMs,
      beatsMs,
    })
    gesture.start(event, (deltaPx) => {
      const raw = pxToMs(deltaPx, pps)
      const deltaMs = edge === 'end' ? snapMs(edgeMs + raw, targets, pps, snap) - edgeMs : raw
      return trimClip(draft, { clipId: clip.id, edge, deltaMs }, context)
    })
  }

  const keyTrim = (
    event: KeyboardEvent<HTMLButtonElement>,
    trim: (deltaMs: number) => EditResult,
  ) => {
    const step = arrowStep(event)
    if (step === undefined) return
    event.preventDefault()
    apply(trim(Math.round(step * 1000)))
  }

  const trimHandles = (
    edges: readonly Edge[],
    durationMs: number,
    what: string,
    onPress: (event: PointerEvent<HTMLElement>, edge: Edge) => void,
    trim: (edge: Edge, deltaMs: number) => EditResult,
  ) =>
    edges.map((edge) => (
      <TrimHandle
        bounds={{ min: 0.1, max: 120 }}
        edge={edge}
        key={edge}
        onKeyDown={(event) => keyTrim(event, (deltaMs) => trim(edge, deltaMs))}
        onPointerCancel={gesture.cancel}
        onPointerDown={(event) => onPress(event, edge)}
        onPointerMove={gesture.move}
        onPointerUp={(event) => {
          gesture.end(event)
        }}
        pressed={false}
        style={edge === 'start' ? { left: 0 } : { left: '100%' }}
        value={durationMs / 1000}
        valueText={`${what} ${seconds(durationMs)} 秒`}
      />
    ))

  const clipEdges = (clip: Layer0Clip): Edge[] =>
    !editable(clip)
      ? []
      : clip.type === 'video'
        ? ['start', 'end']
        : clip.role === 'intro'
          ? ['end']
          : ['start']

  const musicMedia = draft.music === null ? undefined : context.music[draft.music.jobId]
  const shortfall = musicMedia === undefined ? 0 : musicShortfallMs(shown, context)
  const videoBefore = (index: number) =>
    shown.layer0.slice(0, index + 1).filter((clip) => clip.type === 'video').length

  /** 组件块的浮层：锚在块上，向上弹 */
  const popoverOf = (id: string, label: string) => (
    <PopupRoot
      onOpenChange={(open) => popovers.onOpen(open ? id : null)}
      open={popovers.openId === id}
    >
      <PopupAnchor className="wf-pop-anchor" />
      <PopupSurface
        align="start"
        aria-label={label}
        className="wf-pop-surface"
        collisionPadding={16}
        side="top"
        sideOffset={8}
      >
        {popovers.openId === id ? popovers.render(id) : null}
      </PopupSurface>
    </PopupRoot>
  )

  return (
    <div className="wf-tracks">
      <div className="wf-track-heads">
        <span aria-hidden="true" className="wf-track-head is-ruler" />
        <span aria-hidden="true" className="wf-track-head">
          <Icon decorative name="video" size="sm" />
          成片
        </span>
        <span aria-hidden="true" className="wf-track-head">
          <Icon decorative name="grid" size="sm" />
          包装
        </span>
        <span className="wf-track-head">
          <Icon decorative name="captions" size="sm" />
          <span aria-hidden="true">字幕</span>
          <button
            aria-label={`字幕样式：${captionStyle}，点此到组件栏换样式`}
            className="wf-head-pill ui-state ui-focus"
            onClick={onCaptionStyle}
            title={`字幕样式：${captionStyle}`}
            type="button"
          >
            {captionStyle}
          </button>
        </span>
        <span aria-hidden="true" className="wf-track-head">
          <Icon decorative name="music" size="sm" />
          音乐
        </span>
      </div>
      <div className="wf-track-scroll" ref={scrollRef}>
        <div className="wf-track-content" ref={contentRef} style={{ width: `${contentWidth}px` }}>
          <TimelineRuler
            clockAt={(clientX) => timeAt(clientX) / 1000}
            currentTime={playheadMs / 1000}
            onScrub={() => {}}
            onSeek={(clock) => onSeek(Math.round(clock * 1000))}
            scale={contentWidth / pps}
            total={total / 1000}
            viewportRef={scrollRef}
          />
          {beats.map((beat) => (
            <span
              aria-hidden="true"
              className={cn('wf-beat', beat.strong && 'is-strong')}
              key={beat.timeMs}
              style={{ left: `${msToPx(beat.timeMs, pps)}px` }}
            />
          ))}
          {/* 点轨道空处：取消选中、播放头跳过去（轨道本身不接指针，空处的点按落在这一层） */}
          <div
            className="wf-lanes"
            onPointerDown={(event) => {
              if (event.target !== event.currentTarget) return
              onSelect(null)
              onSeek(Math.min(timeAt(event.clientX), total))
            }}
            ref={lanesRef}
          >
            <div aria-label="成片画面轨" className="wf-lane" ref={filmLaneRef} role="group">
              {shown.layer0.map((clip, index) => {
                const url = clip.type === 'video' ? urlOf(clip.sourceJobId) : undefined
                const part =
                  url === undefined || clip.type !== 'video'
                    ? undefined
                    : {
                        mediaUrl: url,
                        start: clip.playbackStart / 1000,
                        end: (clip.playbackStart + clip.duration) / 1000,
                      }
                const cardTitle =
                  clip.type === 'component'
                    ? `${endCardName(clip)} · ${componentTitle(clip.component)}`
                    : ''
                const name =
                  clip.type === 'video'
                    ? `第 ${videoBefore(index)} 段 · ${clipLabel(clip)}，${seconds(clip.duration)} 秒`
                    : `${cardTitle}，${seconds(clip.duration)} 秒`
                return (
                  <Block
                    className={cn('wf-clip', clip.type === 'component' && 'is-card')}
                    gesture={gesture}
                    popover={clip.type === 'component' ? popoverOf(clip.id, cardTitle) : undefined}
                    handles={trimHandles(
                      clipEdges(clip),
                      clip.duration,
                      '该段',
                      (event, edge) => startTrim(event, clip, edge),
                      (edge, deltaMs) =>
                        trimClip(draft, { clipId: clip.id, edge, deltaMs }, context),
                    )}
                    key={clip.id}
                    name={name}
                    onDrag={
                      clip.type === 'video'
                        ? (event) =>
                            gesture.start(event, (deltaPx) =>
                              moveClip(
                                draft,
                                { clipId: clip.id, deltaMs: pxToMs(deltaPx, pps) },
                                context,
                              ),
                            )
                        : undefined
                    }
                    onSelect={() => {
                      onSelect({ kind: 'clip', id: clip.id })
                      if (clip.type === 'component') popovers.onOpen(clip.id)
                    }}
                    selected={selectedId === clip.id}
                    style={place(clip.start, clip.duration)}
                  >
                    <span className="wf-clip-label">
                      {clip.type === 'video' ? clipLabel(clip) : endCardName(clip)}
                    </span>
                    {part === undefined ? (
                      <span className="wf-clip-card">
                        <span>
                          {clip.type === 'component'
                            ? componentTitle(clip.component)
                            : '素材读取中'}
                        </span>
                        <span>{seconds(clip.duration)} 秒</span>
                      </span>
                    ) : (
                      <span className="wf-clip-media">
                        <span className="wf-clip-frames">
                          <Frames part={part} />
                        </span>
                        <span className="wf-clip-wave">
                          <Wave
                            part={part}
                            state={peaks.get(part.mediaUrl) ?? { kind: 'loading' }}
                          />
                        </span>
                      </span>
                    )}
                  </Block>
                )
              })}
              {shown.transitions.map((transition) => {
                const after = shown.layer0.find((clip) => clip.id === transition.afterClipId)
                if (after === undefined) return null
                const title = `转场 · ${componentTitle(transition.component)}`
                return (
                  <span
                    className="wf-transition-slot"
                    key={transition.id}
                    style={{ left: `${msToPx(after.start + after.duration, pps)}px` }}
                  >
                    {popoverOf(transition.id, title)}
                    <button
                      aria-haspopup="dialog"
                      aria-label={`选中：${title}`}
                      aria-pressed={selectedId === transition.id}
                      className="wf-transition ui-focus"
                      onClick={() => {
                        onSelect({ kind: 'transition', id: transition.id })
                        popovers.onOpen(transition.id)
                      }}
                      title={title}
                      type="button"
                    >
                      <Icon decorative name="swap-panes" size="xs" />
                    </button>
                  </span>
                )
              })}
              {shown.layer0.length === 0 ? (
                <span className="wf-lane-hint">
                  在下方视频素材区选好范围，点「加入成片」或拖到这里
                </span>
              ) : (
                (['intro', 'outro'] as const).map((role) =>
                  shown.layer0.some(
                    (clip) => clip.type === 'component' && clip.role === role,
                  ) ? null : (
                    <button
                      className={cn('wf-end-add ui-state ui-focus', role === 'intro' && 'is-start')}
                      key={role}
                      onClick={() => onAddEndCard(role)}
                      style={role === 'outro' ? { left: `${msToPx(total, pps)}px` } : undefined}
                      type="button"
                    >
                      {role === 'intro' ? '+ 片头' : '+ 片尾'}
                    </button>
                  ),
                )
              )}
            </div>
            <div aria-label="包装轨" className="wf-lane" ref={overlayLaneRef} role="group">
              {shown.overlays.length === 0 ? (
                <span className="wf-lane-hint">把左侧组件拖到这里，或点组件从播放头处加入</span>
              ) : null}
              {shown.overlays.map((overlay) => (
                <Block
                  className="wf-overlay"
                  gesture={gesture}
                  popover={popoverOf(overlay.id, `包装 · ${componentTitle(overlay.component)}`)}
                  handles={trimHandles(
                    ['start', 'end'],
                    overlay.duration,
                    '该段包装',
                    (event, edge) => {
                      event.stopPropagation()
                      gesture.start(event, (deltaPx) =>
                        trimOverlay(draft, {
                          overlayId: overlay.id,
                          edge,
                          deltaMs: pxToMs(deltaPx, pps),
                        }),
                      )
                    },
                    (edge, deltaMs) => trimOverlay(draft, { overlayId: overlay.id, edge, deltaMs }),
                  )}
                  key={overlay.id}
                  name={`包装 · ${componentTitle(overlay.component)}，${seconds(overlay.start)}–${seconds(overlay.start + overlay.duration)} 秒`}
                  onDrag={(event) =>
                    gesture.start(event, (deltaPx) =>
                      moveOverlay(draft, { overlayId: overlay.id, deltaMs: pxToMs(deltaPx, pps) }),
                    )
                  }
                  onSelect={() => {
                    onSelect({ kind: 'overlay', id: overlay.id })
                    popovers.onOpen(overlay.id)
                  }}
                  selected={selectedId === overlay.id}
                  style={place(overlay.start, overlay.duration)}
                >
                  <span className="wf-clip-label">{componentTitle(overlay.component)}</span>
                </Block>
              ))}
            </div>
            <div aria-label="字幕轨" className="wf-lane" ref={captionLaneRef} role="group">
              <CaptionChips
                captions={captions}
                onCommit={onCaptionText}
                place={place}
                sentenceText={sentenceText}
              />
            </div>
            <div aria-label="音乐轨" className="wf-lane" ref={musicLaneRef} role="group">
              {shown.music !== null && music !== undefined ? (
                <Block
                  className="wf-music"
                  gesture={gesture}
                  handles={null}
                  name={`音乐 · ${music.title}，从歌里 ${seconds(shown.music.offset)} 秒起`}
                  onDrag={(event) => {
                    const current = draft.music
                    if (current === null || musicMedia === undefined) return
                    // 往左拖是用歌里更靠后的一段：整片 0 秒对齐的位置后移
                    gesture.start(event, (deltaPx) =>
                      setMusicOffset(
                        draft,
                        { offsetMs: current.offset - pxToMs(deltaPx, pps) },
                        context,
                      ),
                    )
                  }}
                  onSelect={() => onSelect({ kind: 'music' })}
                  selected={selection?.kind === 'music'}
                  style={place(0, Math.max(0, total - shortfall))}
                >
                  <span className="wf-clip-label">{music.title}</span>
                  <Wave
                    part={{
                      mediaUrl: music.url,
                      start: shown.music.offset / 1000,
                      end: (shown.music.offset + total - shortfall) / 1000,
                    }}
                    state={music.peaks}
                  />
                </Block>
              ) : null}
              {shortfall > 0 ? (
                <span
                  className="wf-lane-hint is-end"
                  style={{ left: `${msToPx(total - shortfall, pps)}px` }}
                >
                  音乐比整片短 {seconds(shortfall)} 秒，不循环补齐
                </span>
              ) : null}
            </div>
          </div>
          <TimelinePlayhead style={{ left: `${msToPx(Math.min(playheadMs, total), pps)}px` }} />
        </div>
      </div>
    </div>
  )
}

const captionKey = (caption: PlacedCaption) =>
  `${caption.clipId}:${caption.subtitleJobId}:${caption.sentenceIndex}`

type CaptionChipsProps = {
  captions: readonly PlacedCaption[]
  place: (start: number, duration: number) => { left: string; width: string }
  sentenceText: (caption: PlacedCaption) => string
  onCommit: (caption: PlacedCaption, text: string) => void
}

/**
 * 字幕轨：每段画面里的一份句子一块。点一块改这一整句的字（跨段的句子两块改的是同一句），
 * 回车或离开输入框记一步编辑，Esc 放弃；清空后回到识别结果。
 */
function CaptionChips({ captions, place, sentenceText, onCommit }: CaptionChipsProps) {
  const [editing, setEditing] = useState<string | null>(null)
  if (captions.length === 0)
    return <span className="wf-lane-hint">成片里的视频识别出字幕后显示在这里</span>
  return captions.map((caption) => {
    const key = captionKey(caption)
    const style = place(caption.start, caption.end - caption.start)
    if (editing === key)
      return (
        <span className="wf-caption is-editing" key={key} style={style}>
          <CaptionInput
            initial={sentenceText(caption)}
            onDone={(text) => {
              setEditing(null)
              if (text !== undefined) onCommit(caption, text)
            }}
          />
        </span>
      )
    return (
      <button
        aria-label={`字幕：${caption.text}，点此改字`}
        className="wf-caption ui-state ui-focus"
        key={key}
        onClick={() => setEditing(key)}
        style={style}
        title={caption.text}
        type="button"
      >
        {caption.text}
      </button>
    )
  })
}

/** 改字的输入框：打开即聚焦全选；`onDone` 只调一次，放弃时传 undefined */
function CaptionInput({
  initial,
  onDone,
}: {
  initial: string
  onDone: (text: string | undefined) => void
}) {
  const [text, setText] = useState(initial)
  const doneRef = useRef(false)
  const finish = (value: string | undefined) => {
    if (doneRef.current) return
    doneRef.current = true
    onDone(value)
  }
  return (
    <input
      aria-label="改这句字幕；清空回到识别结果"
      className="ui-focus"
      onBlur={() => finish(text)}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(text)
        if (event.key === 'Escape') {
          // 只关输入框，不关整个编辑器
          event.stopPropagation()
          finish(undefined)
        }
      }}
      ref={(element) => {
        if (element !== null && document.activeElement !== element) {
          element.focus()
          element.select()
        }
      }}
      value={text}
    />
  )
}
