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
import { timeLabel } from './time-label'

type Boundary = 'start' | 'end'

export type EditorPreviewHandle = {
  /** 停下并跳到 clock */
  previewAt: (clock: number, boundary?: Boundary) => void
  /** 同播放按钮：从播放头播到结尾，正在播就暂停；按钮置灰时不起播 */
  toggle: () => void
}

export type PreviewPlayback = { playing: boolean; muted: boolean }

type Slot = 0 | 1
const SLOTS: readonly { id: string; slot: Slot }[] = [
  { id: 'a', slot: 0 },
  { id: 'b', slot: 1 },
]

// requestAnimationFrame 约 16ms 一帧，提前两帧切到预载好的下一段。
const SWITCH_AHEAD = 0.03
const END_PREVIEW_OFFSET = 0.001

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

export function PreviewMessage({ children }: { children: ReactNode }) {
  return (
    <div className="editor-preview-message" role="status">
      <Icon decorative name="video" size="lg" />
      <span>{children}</span>
    </div>
  )
}

type Props = {
  current: readonly LaidOutSegment[] | undefined
  contentKey: string
  poster: string | undefined
  backdrop: string | undefined
  currentTime: number
  onTime: (clock: number) => void
  onPlay: () => void
  onPlaybackChange?: ((playback: PreviewPlayback) => void) | undefined
  externalAudio?: { blocked: string | undefined } | undefined
  aspectRatio?: number | undefined
  /** 正在播的那条视频读出像素尺寸时回报，带它的地址。 */
  onVideoSize?: ((mediaUrl: string, size: { width: number; height: number }) => void) | undefined
  picture?: ReactNode
  overlay: ReactNode
  versions: ReactNode
  viewControl: ReactNode
  tools: ReactNode
  readout: ReactNode
  timeline: ReactNode
  barEnd: ReactNode
  footnote: ReactNode
  ref: Ref<EditorPreviewHandle>
}

export function EditorPreview({
  current,
  contentKey,
  poster,
  backdrop,
  currentTime,
  onTime,
  onPlay,
  onPlaybackChange,
  externalAudio,
  aspectRatio,
  onVideoSize,
  picture,
  overlay,
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
  const pendingSeekRef = useRef<[number | null, number | null]>([null, null])
  const stopPlaybackRef = useRef<(() => void) | null>(null)
  const emitTime = useEffectEvent((clock: number) => onTime(clock))
  const [active, setActive] = useState<Slot>(0)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const [muted, setMuted] = useState(true)
  const [failed, setFailed] = useState(false)
  const [switches, setSwitches] = useState(0)
  const [aspect, setAspect] = useState(9 / 16)
  const [enlarged, setEnlarged] = useState(false)
  const closeEnlargedRef = useRef<HTMLButtonElement>(null)
  const enlargeRef = useRef<HTMLButtonElement>(null)
  // 放大与还原只把这个节点挪到另一个槽：两个 <video> 一旦重挂，播放、静音与预载就会中断。
  const [stageHost] = useState(() => {
    const host = document.createElement('div')
    host.className = 'editor-stage-host'
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
  // 媒体元素短暂离开文档会被浏览器暂停，挪进挪出必须在同一次提交里完成。
  const placeEnlarged = useCallback(
    (slot: HTMLDivElement) => {
      slot.appendChild(stageHost)
      return () => {
        inlineSlotRef.current?.appendChild(stageHost)
      }
    },
    [stageHost],
  )
  const showing = contentKey
  const [shown, setShown] = useState({ segments: current, showing })
  const segments = sameSegments(shown.segments, current) ? shown.segments : current
  const duration = segments === undefined ? 0 : totalDuration(segments)
  if (shown.segments !== segments || shown.showing !== showing) {
    setShown({ segments, showing })
    setPlaying(false)
    setFailed(false)
    setActive(0)
    setIndex(0)
    if (shown.showing !== showing && shown.segments !== undefined) setSwitches(switches + 1)
  }
  const lastShowingRef = useRef(showing)
  const resumeClock = useEffectEvent(() => currentTime)

  const emitPlayback = useEffectEvent((playback: PreviewPlayback) => onPlaybackChange?.(playback))
  useEffect(
    () => emitPlayback({ playing: playing && !buffering, muted }),
    [playing, buffering, muted],
  )
  const blockedReason = externalAudio?.blocked
  const blocked = blockedReason !== undefined
  if (blocked && playing) setPlaying(false)
  const playable = segments !== undefined && segments.length > 0 && !failed && !blocked

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
    // 未完成的 play() 被 pause 打断会以失败落定，先撤销这一轮，免得误报加载失败。
    stopPlaybackRef.current?.()
    for (const element of elementsRef.current) element?.pause()
    setPlaying(false)
  }

  const togglePlay = () => {
    if (playing) {
      pause()
      return
    }
    if (!playable) return
    if (currentTime >= duration) seek(0)
    setBuffering(true)
    setPlaying(true)
    onPlay()
  }

  useImperativeHandle(ref, () => ({
    previewAt(clock, boundary) {
      pause()
      if (current === undefined) return
      seek(clock, boundary)
    },
    toggle: togglePlay,
  }))

  useEffect(() => {
    const switched = lastShowingRef.current !== showing
    lastShowingRef.current = showing
    if (segments === undefined) {
      emitTime(0)
      return
    }
    seekFromEffect(switched ? 0 : resumeClock())
  }, [segments, showing])

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
      if (clock >= duration || (element.ended && segmentEnd >= duration)) {
        stop()
        setPlaying(false)
        seekFromEffect(duration, 'end')
        return
      }
      emitTime(clock)
      if (segmentEnd < duration && (element.ended || now >= segment.end - SWITCH_AHEAD)) {
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
  }, [playing, index, active, segments, duration])

  const playButton = (
    <IconButton
      className="editor-play"
      disabled={!playable}
      tooltip={blockedReason}
      label={playing ? '暂停' : '播放'}
      name={playing ? 'pause' : 'play'}
      onClick={togglePlay}
      size="sm"
      variant="selected"
    />
  )
  const clock = (
    <span className="editor-clock">
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

  const stage = (
    <div
      aria-label="视频预览"
      className={cn('editor-preview stage-picture', enlarged && 'is-enlarged')}
      style={{ '--preview-ratio': aspectRatio ?? aspect } as CSSProperties}
    >
      {SLOTS.map(({ id, slot }) => (
        // eslint-disable-next-line jsx-a11y-x/media-has-caption -- 生成的视频没有字幕轨，不装样子
        <video
          aria-hidden={slot !== active}
          aria-label={slot === active ? '视频播放器' : undefined}
          className={cn('editor-video', slot !== active && 'invisible')}
          key={id}
          muted={muted || externalAudio !== undefined}
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
              const mediaUrl = media.dataset['src']
              if (mediaUrl !== undefined)
                onVideoSize?.(mediaUrl, { width: media.videoWidth, height: media.videoHeight })
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
        <span
          aria-hidden="true"
          className="editor-preview-fade animate-out duration-(--dur-m) ease-(--ease-decel) fill-mode-forwards fade-out motion-reduce:hidden"
          key={switches}
        />
      )}
      {failed ? null : picture}
      {segments === undefined ? <PreviewMessage>正在读取视频信息…</PreviewMessage> : null}
      {failed ? (
        <div className="editor-preview-message" role="alert">
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

  // 子节点的顺序固定：portal 换了位置或容器，舞台就会重挂。
  return (
    <>
      <div className="editor-stage-area">
        <section aria-label="预览舞台" className="editor-stage">
          <StageBackdrop url={backdrop} />
          {viewControl}
          <div className="editor-hero-wrap" ref={placeInline} />
          {overlay}
        </section>
        {versions}
      </div>
      {createPortal(stage, stageHost)}
      <DialogRoot open={enlarged} onOpenChange={setEnlarged}>
        {enlarged ? (
          <DialogSurface
            aria-describedby={undefined}
            bare
            className="editor-enlarge"
            onCloseAutoFocus={(event) => {
              // Radix 默认把焦点还给打开前的元素。
              event.preventDefault()
              enlargeRef.current?.focus()
            }}
            // 舞台在 React 树里属于编辑器，Radix 会把点舞台当成点了外面。
            onInteractOutside={(event) => event.preventDefault()}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              closeEnlargedRef.current?.focus()
            }}
            overlayClassName="editor-enlarge-scrim"
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
              <div aria-label="播放控件" className="editor-enlarge-transport" role="group">
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
      <div className="editor-timeline-area">
        <div className="editor-timeline-panel">
          <div aria-label="播放控件" className="editor-bar" role="group">
            <div className="editor-bar-group">
              {playButton}
              {clock}
              {tools}
            </div>
            <div className="editor-bar-group">
              {readout}
              <span aria-hidden="true" className="editor-bar-divider" />
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
