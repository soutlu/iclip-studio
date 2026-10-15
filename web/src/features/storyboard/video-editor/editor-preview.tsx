/** 预览台：舞台（模糊海报底、「原片 | 改后」、按比例居中的画面、盖在上面的浮层、版本条）与时间线面板顶上的播放控制条，画面可在应用内放大。
 *
 * 多段预览靠两个 `<video>` 轮换：一个在放、另一个预载下一段，到点切过去不用等加载。
 * 中间版本不落文件，拼好的整条只在这里连着放。 */

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { DialogRoot, DialogSurface, DialogTitle } from '@/shared/ui/dialog'
import { MediaFallback } from '@/shared/ui/media-fallback'
import { StageBackdrop } from '../components/stage-backdrop'
import { locateClock, totalDuration, type LaidOutSegment } from './play-layout'
import type { CaptionPresentation } from './caption-layout'
import { timeLabel } from './time-label'

/** 定位到的是一段的哪一端：结尾那端显示段内最后一刻的画面，不跳进下一段。 */
type Boundary = 'start' | 'end'

export type EditorPreviewHandle = {
  /** 暂停并切回当前编辑版本；右边界显示区间内侧的画面，游标仍标记准确边界。 */
  previewAt: (clock: number, boundary?: Boundary) => void
}

type Slot = 0 | 1
const SLOTS: readonly { id: string; slot: Slot }[] = [
  { id: 'a', slot: 0 },
  { id: 'b', slot: 1 },
]

/** 到段尾前多少秒就切下一段；rAF 一帧约 16ms，留两帧余量。 */
const SWITCH_AHEAD = 0.03
/** 右开区间的定位偏移，仅避免跳进下一段，不代表素材的帧时长。 */
const END_PREVIEW_OFFSET = 0.001

/** 查询刷新可能重建相同分段；媒体内容未变时保留正在播放的槽与时钟。 */
const sameSegments = (
  left: readonly LaidOutSegment[] | undefined,
  right: readonly LaidOutSegment[] | undefined,
) =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((segment, index) => {
      const other = right[index]
      return (
        segment.mediaUrl === other?.mediaUrl &&
        segment.start === other.start &&
        segment.end === other.end &&
        segment.at === other.at &&
        segment.duration === other.duration
      )
    }))

type Props = {
  /** 当前看的这一版或剪辑草稿；`undefined` 是还没读到分段。 */
  current: readonly LaidOutSegment[] | undefined
  /** 所看内容的身份（哪一版、看草稿还是这一版本身）：变了就回到开头；不变只是草稿剪了一刀。 */
  contentKey: string
  /** 草稿基于的那一版，「原片」放它；看的不是有改动的草稿时没有，也就不出「原片 | 改后」。 */
  original: readonly LaidOutSegment[] | undefined
  poster: string | undefined
  /** 舞台底的模糊海报：当前这条与它基于的那一版各一张，跟着「原片 | 改后」换；读不到截帧时没有。 */
  backdrop: { current: string | undefined; original: string | undefined }
  currentTime: number
  onTime: (clock: number) => void
  /** 开始播放（控制条或放大层上的播放钮），在按下的那一下同步调用：要出声的另一路（整片的背景音乐）在这里取得手势。 */
  onPlay: () => void
  /** 选中片段后从整条时间线的 start 播放到 end；同一 id 不会因查询刷新而重播。 */
  playbackRequest?: { id: number; start: number; end: number } | undefined
  /** 在不在放、静没静音变了就告诉一声：跟着画面放的另一路声音（整片的背景音乐）据此起停、静音。 */
  onPlaybackChange?: ((playback: { playing: boolean; muted: boolean }) => void) | undefined
  /** 整片草稿使用独立的完整混音时，视频自身的原声始终关闭；控件仍控制独立混音的静音。 */
  muteMediaAudio?: boolean
  /** 独立混音未准备好或读取失败时，播放暂停，并在播放按钮上说明原因。 */
  playBlocked?: string | undefined
  /** 盖在舞台上的浮层（AI 改段的弹出卡），画面不为它让位。 */
  overlay: ReactNode
  /** 压在画面底部居中的字幕（白字、深色描边），放大时跟着画面走；没有就不显示。 */
  caption?: string | undefined
  /** 自定义字体先在源画布上排好行，再随实际预览画面等比缩放。 */
  captionPresentation?: CaptionPresentation | undefined
  /** 一段都没有时画面里那句话；不给就只留空画面。 */
  emptyMessage?: string | undefined
  /** 贴在舞台右缘的版本条（窄屏排到舞台下方）。 */
  versions: ReactNode
  /** 替换原片 / 改后开关，保留现有位置与布局。 */
  viewControl?: ReactNode
  /** 控制条上时钟后面的剪辑操作：撤销、重做、拆分、删除。 */
  tools: ReactNode
  /** 控制条右侧的总长读数。 */
  readout: ReactNode
  /** 时间线面板里控制条下面的内容：轨道，或读不到分段时的说明。 */
  timeline: ReactNode
  /** 控制条最右的操作，如下载。 */
  barEnd: ReactNode
  /** 时间线面板下面一行脚注。 */
  footnote: ReactNode
  ref: Ref<EditorPreviewHandle>
}

export function EditorPreview({
  current,
  contentKey,
  original,
  poster,
  backdrop,
  currentTime,
  onTime,
  onPlay,
  playbackRequest,
  onPlaybackChange,
  muteMediaAudio = false,
  playBlocked,
  overlay,
  caption,
  captionPresentation,
  emptyMessage,
  versions,
  viewControl,
  tools,
  readout,
  timeline,
  barEnd,
  footnote,
  ref,
}: Props) {
  const elementsRef = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null])
  // 元数据还没到就先记下要跳到哪；同一槽只留最后一次，旧的跳转不会在加载完之后倒回去。
  const pendingSeekRef = useRef<[number | null, number | null]>([null, null])
  // 切源后应用最新定位；段列表身份防止旧请求落到另一个版本。
  const pendingPreviewRef = useRef<{
    segments: readonly LaidOutSegment[]
    clock: number
    boundary: Boundary | undefined
  } | null>(null)
  // 拖动开始时同步撤销播放，不必等下一次 render 的 effect 清理。
  const stopPlaybackRef = useRef<(() => void) | null>(null)
  const playbackRangeRef = useRef<{ showing: string; start: number; end: number } | null>(null)
  const [appliedPlayback, setAppliedPlayback] = useState<{
    id: number
    showing: string
    start: number
    end: number
  } | null>(null)
  const startedPlaybackRef = useRef(appliedPlayback)
  // 效果里报时钟走的是它，拿到的永远是最新的 onTime；事件处理器里直接调 onTime。
  const emitTime = useEffectEvent((clock: number) => onTime(clock))
  const [showOriginal, setShowOriginal] = useState(false)
  const [active, setActive] = useState<Slot>(0)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  // 保留人的播放意图，但画面等数据/等 seek 时外部混音必须停在同一时刻。
  const [buffering, setBuffering] = useState(false)
  const [muted, setMuted] = useState(true)
  const [failed, setFailed] = useState(false)
  // 换过几次所看的内容：画面上那层淡出的遮片按它重挂，第一次打开不遮。
  const [switches, setSwitches] = useState(0)
  // 画面宽高比：舞台按它摆画面，元数据到达前按竖版算。
  const [aspect, setAspect] = useState(9 / 16)
  const [enlarged, setEnlarged] = useState(false)
  const closeEnlargedRef = useRef<HTMLButtonElement>(null)
  const enlargeRef = useRef<HTMLButtonElement>(null)
  // 舞台渲染进这个只建一次的节点，放大与还原只是把节点挪到另一个槽：两个 <video> 不重挂，播放、静音与预载都不断。
  const [stageHost] = useState(() => {
    const host = document.createElement('div')
    host.className = 'video-editor-stage-host'
    return host
  })
  const inlineSlotRef = useRef<HTMLDivElement | null>(null)
  const placeInline = useCallback(
    (slot: HTMLDivElement) => {
      inlineSlotRef.current = slot
      slot.appendChild(stageHost)
      return () => {
        inlineSlotRef.current = null
        stageHost.remove()
      }
    },
    [stageHost],
  )
  // 挪进挪出都在同一次提交里完成，媒体元素不会因短暂离开文档而被暂停。
  const placeEnlarged = useCallback(
    (slot: HTMLDivElement) => {
      slot.appendChild(stageHost)
      return () => {
        inlineSlotRef.current?.appendChild(stageHost)
      }
    },
    [stageHost],
  )
  const onOriginal = showOriginal && original !== undefined
  const nextSegments = onOriginal ? original : current
  // 所看的是哪一条：换版本、在草稿与这一版之间切、在原片与改后之间切，都算换了内容。
  const showing = `${contentKey}:${onOriginal ? 'original' : 'current'}`
  // 段列表变了就停下、重新装段：播放位置是跟着段列表走的派生状态，在渲染里对齐，不等一帧。
  // 换了内容回到开头、遮一下；同一条草稿剪了一刀只是重排，播放头留在原处。
  const [shown, setShown] = useState({ segments: nextSegments, showing })
  const segments = sameSegments(shown.segments, nextSegments) ? shown.segments : nextSegments
  const duration = segments === undefined ? 0 : totalDuration(segments)
  if (shown.segments !== segments || shown.showing !== showing) {
    setShown({ segments, showing })
    setPlaying(false)
    setFailed(false)
    setActive(0)
    setIndex(0)
    // 读到分段之前没有画面可换，那一次不算切换。
    if (shown.showing !== showing && shown.segments !== undefined) setSwitches(switches + 1)
  }
  const lastShowingRef = useRef(showing)
  const resumeClock = useEffectEvent(() => currentTime)

  const emitPlayback = useEffectEvent((playback: { playing: boolean; muted: boolean }) =>
    onPlaybackChange?.(playback),
  )
  useEffect(
    () => emitPlayback({ playing: playing && !buffering, muted }),
    [playing, buffering, muted],
  )
  const blocked = playBlocked !== undefined
  if (blocked && playing) setPlaying(false)
  if (playbackRequest !== undefined && appliedPlayback?.id !== playbackRequest.id) {
    if (onOriginal) setShowOriginal(false)
    // 分段或独立音轨尚未准备好时保留请求；元数据由 pendingSeek 等待。
    else if (segments !== undefined && segments.length > 0 && !blocked) {
      const start = Math.min(duration, Math.max(0, playbackRequest.start))
      const end = Math.min(duration, Math.max(start, playbackRequest.end))
      setAppliedPlayback({ id: playbackRequest.id, showing, start, end })
      setFailed(false)
      setBuffering(end > start)
      setPlaying(end > start)
      setIndex(locateClock(segments, start)?.index ?? 0)
    }
  }

  /** 把一段装进某个槽并跳到段内 `offset`；`reload` 是加载失败后重来。 */
  const load = useCallback(
    (slot: Slot, segment: LaidOutSegment, offset: number, reload = false) => {
      const element = elementsRef.current[slot]
      if (element === null) return
      const target = segment.start + offset
      if (reload || element.dataset['src'] !== segment.mediaUrl) {
        element.dataset['src'] = segment.mediaUrl
        pendingSeekRef.current[slot] = target
        element.src = segment.mediaUrl
      } else if (element.readyState >= HTMLMediaElement.HAVE_METADATA) {
        // 元数据已可用时以这次定位为准，稍后到达的 loadedmetadata 不能再应用旧目标。
        pendingSeekRef.current[slot] = null
        element.currentTime = target
      } else {
        pendingSeekRef.current[slot] = target
      }
    },
    [],
  )

  const seek = (clock: number, boundary?: Boundary) => {
    if (segments === undefined) return
    const boundedClock = Math.min(duration, Math.max(0, clock))
    const mediaClock =
      boundary === 'end' ? Math.max(0, boundedClock - END_PREVIEW_OFFSET) : boundedClock
    const located = locateClock(segments, mediaClock)
    const segment = located === undefined ? undefined : segments[located.index]
    if (located === undefined || segment === undefined) return
    if (located.index !== index) setIndex(located.index)
    load(active, segment, located.offset)
    onTime(boundedClock)
  }
  const seekFromEffect = useEffectEvent(seek)

  const pause = () => {
    // 先撤销这一轮播放，再 pause，避免未完成的 play() 被中断后误报加载失败。
    stopPlaybackRef.current?.()
    for (const element of elementsRef.current) element?.pause()
    setPlaying(false)
  }

  useImperativeHandle(ref, () => ({
    previewAt(clock, boundary) {
      pause()
      playbackRangeRef.current = null
      if (current === undefined) return
      if (onOriginal) {
        pendingPreviewRef.current = { segments: current, clock, boundary }
        setShowOriginal(false)
      } else {
        seek(clock, boundary)
      }
    },
  }))

  const hasPendingPlayback = useEffectEvent(
    () => appliedPlayback !== null && startedPlaybackRef.current !== appliedPlayback,
  )
  // 换了内容回到开头，同一条剪过一刀留在原处；从原片切回编辑版本时，先应用最后一次边界定位。
  useEffect(() => {
    const pending = pendingPreviewRef.current
    pendingPreviewRef.current = null
    playbackRangeRef.current = null
    const switched = lastShowingRef.current !== showing
    lastShowingRef.current = showing
    if (segments === undefined) {
      emitTime(0)
      return
    }
    if (hasPendingPlayback()) return
    if (pending !== null && pending.segments === segments) {
      seekFromEffect(pending.clock, pending.boundary)
    } else {
      seekFromEffect(switched ? 0 : resumeClock())
    }
  }, [segments, showing])

  const requestPlayback = useEffectEvent(() => {
    if (appliedPlayback === null || segments === undefined) return
    const located = locateClock(segments, appliedPlayback.start)
    const segment = located === undefined ? undefined : segments[located.index]
    if (located === undefined || segment === undefined) return
    startedPlaybackRef.current = appliedPlayback
    playbackRangeRef.current = appliedPlayback
    load(active, segment, located.offset)
    emitTime(appliedPlayback.start)
  })
  useEffect(() => requestPlayback(), [appliedPlayback])

  // 主槽换段之后，把再下一段预载进腾出来的那个槽。
  useEffect(() => {
    const next = segments?.[index + 1]
    if (next !== undefined) load(active === 0 ? 1 : 0, next, 0)
  }, [segments, index, active, load])

  useEffect(() => {
    const element = elementsRef.current[active]
    const segment = segments?.[index]
    if (element === null || segments === undefined || segment === undefined || !playing) return

    let cancelled = false
    let frame = 0
    const stop = () => {
      cancelled = true
      cancelAnimationFrame(frame)
      element.pause()
      if (stopPlaybackRef.current === stop) stopPlaybackRef.current = null
    }
    stopPlaybackRef.current = stop
    void element.play().then(
      () => {
        if (!cancelled) setBuffering(false)
      },
      () => {
        if (cancelled) return
        stop()
        setPlaying(false)
        setFailed(true)
      },
    )

    const tick = () => {
      if (cancelled) return
      if (pendingSeekRef.current[active] !== null) {
        frame = requestAnimationFrame(tick)
        return
      }
      const now = element.currentTime
      const clock = segment.at + Math.min(segment.duration, Math.max(0, now - segment.start))
      const segmentEnd = segment.at + segment.duration
      const range = playbackRangeRef.current
      const playbackEnd = range?.showing === showing ? range.end : duration
      if (clock >= playbackEnd || (element.ended && segmentEnd >= playbackEnd)) {
        stop()
        setPlaying(false)
        seekFromEffect(playbackEnd, 'end')
        return
      }
      emitTime(clock)
      if (segmentEnd < playbackEnd && (element.ended || now >= segment.end - SWITCH_AHEAD)) {
        stop()
        emitTime(segmentEnd)
        setBuffering(true)
        setActive(active === 0 ? 1 : 0)
        setIndex(index + 1)
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return stop
  }, [playing, index, active, segments, duration, showing, appliedPlayback])

  const togglePlay = () => {
    if (playing) {
      pause()
      return
    }
    const range = playbackRangeRef.current
    if (range?.showing === showing) {
      if (currentTime < range.start || currentTime >= range.end) seek(range.start)
    } else if (currentTime >= duration) seek(0)
    setBuffering(true)
    setPlaying(true)
    onPlay()
  }
  const compare = (toOriginal: boolean) => {
    pause()
    setShowOriginal(toOriginal)
  }

  // 控制条与放大层各摆一份，状态同一份：放大时控制条被遮罩盖住，放大层得自己能停、能开声音。
  const playButton = (
    <IconButton
      className="video-editor-play"
      disabled={segments === undefined || segments.length === 0 || failed || blocked}
      tooltip={playBlocked}
      label={playing ? '暂停' : '播放'}
      name={playing ? 'pause' : 'play'}
      onClick={togglePlay}
      size="sm"
      variant="selected"
    />
  )
  const clock = (
    <span className="video-editor-clock">
      {timeLabel(currentTime)}
      <span> / {timeLabel(duration)}</span>
    </span>
  )
  const muteButton = (
    <IconButton
      label={muted ? '开启声音' : '静音'}
      name={muted ? 'audio-off' : 'audio'}
      onClick={() => setMuted(!muted)}
      size="sm"
    />
  )

  // cqw 相对实际画面宽度，内嵌、放大与窗口缩放共用一份源像素度量。
  const captionStyle: CSSProperties | undefined =
    captionPresentation === undefined
      ? undefined
      : (() => {
          const font = captionPresentation
          const scaled = (value: number) => `${(value / font.frame.width) * 100}cqw`
          return {
            fontFamily: font.fontFamily,
            fontWeight: font.fontWeight,
            fontStyle: font.fontStyle,
            fontSynthesis: 'none',
            fontKerning: 'normal',
            fontSize: scaled(font.fontSize),
            lineHeight: scaled(font.lineHeight),
            left: scaled(font.marginSide),
            right: scaled(font.marginSide),
            bottom: scaled(font.marginBottom),
            WebkitTextStroke: `${scaled(font.outline * 2)} var(--color-scrim)`,
            paintOrder: 'stroke fill',
            textShadow: 'none',
            whiteSpace: 'pre',
            letterSpacing: 0,
            wordSpacing: 0,
          }
        })()

  const stage = (
    <div
      aria-label="视频预览"
      className={cn(
        'video-editor-preview stage-picture',
        enlarged && 'is-enlarged',
        captionPresentation !== undefined && 'has-custom-caption',
      )}
      style={
        {
          '--preview-ratio':
            captionPresentation === undefined
              ? aspect
              : captionPresentation.frame.width / captionPresentation.frame.height,
        } as CSSProperties
      }
    >
      {SLOTS.map(({ id, slot }) => (
        // eslint-disable-next-line jsx-a11y-x/media-has-caption -- 生成的视频没有字幕轨，不装样子
        <video
          aria-hidden={slot !== active}
          aria-label={slot === active ? '视频播放器' : undefined}
          className={cn('video-editor-video', slot !== active && 'invisible')}
          key={id}
          muted={muted || muteMediaAudio}
          onWaiting={(event) => {
            if (slot !== active) return
            const segment = segments?.[index]
            if (segment !== undefined)
              onTime(
                segment.at +
                  Math.min(
                    segment.duration,
                    Math.max(0, event.currentTarget.currentTime - segment.start),
                  ),
              )
            setBuffering(true)
          }}
          onSeeking={() => {
            if (slot === active) setBuffering(true)
          }}
          onSeeked={(event) => {
            if (
              slot === active &&
              event.currentTarget.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
            )
              setBuffering(false)
          }}
          onPlaying={() => {
            if (slot === active) setBuffering(false)
          }}
          onError={() => {
            if (slot === active) {
              setFailed(true)
              setPlaying(false)
            }
          }}
          onLoadedMetadata={(event) => {
            const media = event.currentTarget
            if (slot === active && media.videoWidth > 0 && media.videoHeight > 0) {
              setAspect(media.videoWidth / media.videoHeight)
            }
            const target = pendingSeekRef.current[slot]
            if (target === null) return
            pendingSeekRef.current[slot] = null
            media.currentTime = target
          }}
          playsInline
          poster={slot === 0 ? poster : undefined}
          preload="auto"
          ref={(element) => {
            elementsRef.current[slot] = element
          }}
        />
      ))}
      {switches === 0 ? null : (
        // 换了所看的内容：一层画面底色淡出，新画面淡入；两个 <video> 不能为此重挂。
        <span
          aria-hidden="true"
          className="video-editor-preview-fade animate-out duration-(--dur-m) ease-(--ease-decel) fill-mode-forwards fade-out motion-reduce:hidden"
          key={switches}
        />
      )}
      {caption === undefined || caption.trim() === '' || failed ? null : (
        <p
          className="video-editor-preview-caption"
          data-testid="preview-caption"
          style={captionStyle}
        >
          {caption}
        </p>
      )}
      {segments === undefined ? (
        <div className="video-editor-preview-message" role="status">
          <Icon decorative name="video" size="lg" />
          <span>正在读取视频信息…</span>
        </div>
      ) : segments.length === 0 && emptyMessage !== undefined ? (
        <div className="video-editor-preview-message" role="status">
          <Icon decorative name="video" size="lg" />
          <span>{emptyMessage}</span>
        </div>
      ) : null}
      {failed ? (
        <div className="video-editor-preview-message" role="alert">
          <MediaFallback
            kind="video"
            onRetry={() => {
              setFailed(false)
              const segment = segments?.[index]
              if (segment !== undefined) load(active, segment, 0, true)
            }}
          />
        </div>
      ) : null}
    </div>
  )

  // 四个子节点的顺序固定：portal 换了位置或容器，舞台就会重挂。
  return (
    <>
      <div className="video-editor-stage-area">
        <section aria-label="预览舞台" className="video-editor-stage">
          <StageBackdrop url={onOriginal ? backdrop.original : backdrop.current} />
          {viewControl !== undefined ? (
            viewControl
          ) : original === undefined ? null : (
            <div aria-label="预览版本" className="video-editor-compare" role="group">
              <button
                aria-pressed={onOriginal}
                className="ui-focus"
                onClick={() => compare(true)}
                type="button"
              >
                原片
              </button>
              <button
                aria-pressed={!onOriginal}
                className="ui-focus"
                onClick={() => compare(false)}
                type="button"
              >
                改后
              </button>
            </div>
          )}
          {/* 内嵌槽占住画面的位置与尺寸，舞台放大离开时布局不塌。 */}
          <div className="video-editor-hero-wrap" ref={placeInline} />
          {overlay}
        </section>
        {versions}
      </div>
      {createPortal(stage, stageHost)}
      <DialogRoot open={enlarged} onOpenChange={setEnlarged}>
        {/* 只在放大时渲染：关掉立即卸载、舞台立即放回，不等退场动画。 */}
        {enlarged ? (
          <DialogSurface
            aria-describedby={undefined}
            bare
            className="video-editor-enlarge"
            onCloseAutoFocus={(event) => {
              // Radix 记下的是打开前的焦点，这里明确还给控制条上的放大按钮。
              event.preventDefault()
              enlargeRef.current?.focus()
            }}
            // 舞台在 React 树里属于编辑器，Radix 会把点舞台当成点了外面；遮罩盖满视口，真正的外面点不到。
            onInteractOutside={(event) => event.preventDefault()}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              closeEnlargedRef.current?.focus()
            }}
            overlayClassName="video-editor-enlarge-scrim"
          >
            <DialogTitle className="sr-only">放大预览</DialogTitle>
            <button
              aria-label="关闭预览"
              className="absolute inset-0 cursor-zoom-out"
              onClick={() => setEnlarged(false)}
              type="button"
            />
            <div className="relative">
              <div ref={placeEnlarged} />
              <div aria-label="播放控件" className="video-editor-enlarge-transport" role="group">
                {playButton}
                {clock}
                {muteButton}
              </div>
            </div>
            <button
              aria-label="关闭"
              className="absolute top-4 right-6 grid size-(--control-height-md) cursor-pointer place-items-center rounded-full text-on-scrim ui-focus ui-motion-s hover:opacity-70"
              onClick={() => setEnlarged(false)}
              ref={closeEnlargedRef}
              type="button"
            >
              <Icon decorative name="close" size="lg" />
            </button>
          </DialogSurface>
        ) : null}
      </DialogRoot>
      <div className="video-editor-timeline-area">
        <div className="video-editor-timeline-panel">
          <div aria-label="播放控件" className="video-editor-bar" role="group">
            <div className="video-editor-bar-group">
              {playButton}
              {clock}
              {tools}
            </div>
            <div className="video-editor-bar-group">
              {readout}
              <span aria-hidden="true" className="video-editor-bar-divider" />
              {muteButton}
              <IconButton
                label="放大"
                name="zoom"
                onClick={() => setEnlarged(true)}
                ref={enlargeRef}
                size="sm"
              />
              {barEnd}
            </div>
          </div>
          {timeline}
        </div>
        {footnote}
      </div>
    </>
  )
}
