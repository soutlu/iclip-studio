import { Slider } from 'radix-ui'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
  type VideoHTMLAttributes,
} from 'react'
import { sameSpans, spansOf, type TimeSpan } from '@/shared/lib/time-spans'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MediaBuffering } from '@/shared/ui/media-buffering'
import { MediaFallback } from '@/shared/ui/media-fallback'

export const VIDEO_PLAYER_SELECTOR = '[data-video-player]'

const SEEK_STEP_S = 5
const IDLE_MS = 2000
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_SLOP_PX = 24

const BAR_BUTTON = 'size-(--control-height-md) rounded-full text-on-scrim [&_svg]:size-(--icon-lg)'

type VideoPlayerProps = Pick<
  VideoHTMLAttributes<HTMLVideoElement>,
  'onLoadedMetadata' | 'onTimeUpdate'
> & {
  src: string
  label: string
  poster?: string | undefined
  autoPlay?: boolean | undefined
  loop?: boolean | undefined
  startAt?: number | undefined
  onExpand?: ((currentTime: number) => void) | undefined
  className?: string | undefined
  style?: CSSProperties | undefined
  videoClassName?: string | undefined
  ref?: Ref<HTMLVideoElement> | undefined
}

type Playback = {
  paused: boolean
  muted: boolean
  time: number
  duration: number
  waiting: boolean
  failed: boolean
  buffered: readonly TimeSpan[]
}

const INITIAL: Playback = {
  paused: true,
  muted: false,
  time: 0,
  duration: 0,
  waiting: false,
  failed: false,
  buffered: [],
}

const formatClock = (seconds: number) => {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const startsOnLoad = (video: HTMLVideoElement) => video.autoplay && video.played.length === 0

const waitingOf = (video: HTMLVideoElement) => {
  if (video.error !== null || video.ended) return false
  if (!video.paused) return video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
  return startsOnLoad(video) && video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA
}

const playbackOf = (video: HTMLVideoElement): Playback => ({
  paused: video.paused,
  muted: video.muted,
  time: video.currentTime,
  duration: Number.isFinite(video.duration) ? video.duration : 0,
  waiting: waitingOf(video),
  failed: video.error !== null,
  buffered: spansOf(video.buffered),
})

const samePlayback = (left: Playback, right: Playback) =>
  left.paused === right.paused &&
  left.muted === right.muted &&
  left.time === right.time &&
  left.duration === right.duration &&
  left.waiting === right.waiting &&
  left.failed === right.failed &&
  sameSpans(left.buffered, right.buffered)

export function VideoPlayer({
  src,
  label,
  poster,
  autoPlay,
  loop,
  startAt,
  onExpand,
  className,
  style,
  videoClassName,
  ref,
  onLoadedMetadata,
  onTimeUpdate,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const idleTimerRef = useRef<number | undefined>(undefined)
  const pointerTypeRef = useRef('')
  const lastTapRef = useRef<{ at: number; x: number; y: number } | null>(null)
  const resumeRef = useRef<{ src: string; at: number } | null>(null)
  const [playback, setPlayback] = useState(INITIAL)
  const [idle, setIdle] = useState(false)

  const attachVideo = useCallback(
    (node: HTMLVideoElement | null) => {
      videoRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    },
    [ref],
  )

  useEffect(() => {
    const timer = idleTimerRef
    return () => window.clearTimeout(timer.current)
  }, [])

  const wake = () => {
    setIdle(false)
    window.clearTimeout(idleTimerRef.current)
    const video = videoRef.current
    if (video === null || video.paused) return
    idleTimerRef.current = window.setTimeout(() => {
      if (!video.paused && !barRef.current?.contains(document.activeElement)) setIdle(true)
    }, IDLE_MS)
  }

  const sync = (video: HTMLVideoElement) =>
    setPlayback((previous) => {
      const next = playbackOf(video)
      return samePlayback(previous, next) ? previous : next
    })

  const toggle = () => {
    const video = videoRef.current
    if (video === null) return
    if (!video.paused) {
      video.pause()
      return
    }
    void video.play().catch(() => undefined)
  }

  const seekTo = (at: number) => {
    const video = videoRef.current
    if (video === null || !(video.duration > 0)) return
    video.currentTime = Math.min(Math.max(at, 0), video.duration)
    sync(video)
  }

  const toggleMute = () => {
    const video = videoRef.current
    if (video !== null) video.muted = !video.muted
  }

  const retry = () => {
    const video = videoRef.current
    if (video === null) return
    const at = video.currentTime
    resumeRef.current = at > 0 ? { src: video.currentSrc, at } : null
    video.load()
  }

  const expand = () => {
    const video = videoRef.current
    if (video === null || onExpand === undefined) return
    video.pause()
    onExpand(video.currentTime)
  }

  // iOS Safari 触控点击的 event.detail 恒为 1，触屏设备需按时间间隔与位移自行判定双击。
  const clickCount = (event: MouseEvent<HTMLVideoElement>) => {
    if (pointerTypeRef.current !== 'touch') return event.detail
    const last = lastTapRef.current
    const second =
      last !== null &&
      event.timeStamp - last.at <= DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - last.x, event.clientY - last.y) <= DOUBLE_TAP_SLOP_PX
    lastTapRef.current = second ? null : { at: event.timeStamp, x: event.clientX, y: event.clientY }
    return second ? 2 : 1
  }

  const onPictureClick = (event: MouseEvent<HTMLVideoElement>) => {
    const count = clickCount(event)
    if (count === 1) toggle()
    else if (count === 2) {
      toggle()
      expand()
    }
  }

  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    wake()
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const video = videoRef.current
    if (video === null || video.error !== null) return
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
    if (key === ' ' && event.target instanceof HTMLButtonElement) return
    if (key === ' ' || key === 'k') toggle()
    else if (key === 'ArrowLeft') seekTo(video.currentTime - SEEK_STEP_S)
    else if (key === 'ArrowRight') seekTo(video.currentTime + SEEK_STEP_S)
    else if (key === 'Home') seekTo(0)
    else if (key === 'End') seekTo(video.duration)
    else if (key === 'm') toggleMute()
    else return
    event.preventDefault()
  }

  const { paused, muted, time, duration, waiting, failed, buffered } = playback
  const percent = (seconds: number) => `${duration > 0 ? (seconds / duration) * 100 : 0}%`
  return (
    <div
      aria-label={`播放器：${label}`}
      className={cn(
        'relative isolate touch-manipulation overflow-hidden rounded-md bg-scrim select-none',
        className,
      )}
      data-idle={idle && !failed ? '' : undefined}
      data-video-player=""
      onFocus={wake}
      onKeyDownCapture={onKeyDownCapture}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'mouse' || videoRef.current?.paused !== false) return
        window.clearTimeout(idleTimerRef.current)
        setIdle(true)
      }}
      onPointerMove={wake}
      role="group"
      style={style}
      tabIndex={-1}
    >
      {/* eslint-disable-next-line jsx-a11y-x/media-has-caption -- 生成与上传的素材都没有字幕轨可挂 */}
      <video
        aria-label={label}
        autoPlay={autoPlay}
        className={cn('block size-full object-contain', videoClassName)}
        disablePictureInPicture
        loop={loop}
        onCanPlay={(event) => sync(event.currentTarget)}
        onCanPlayThrough={(event) => sync(event.currentTarget)}
        onClick={onPictureClick}
        onDurationChange={(event) => sync(event.currentTarget)}
        onEmptied={(event) => sync(event.currentTarget)}
        onError={(event) => sync(event.currentTarget)}
        onLoadStart={(event) => sync(event.currentTarget)}
        onLoadedMetadata={(event) => {
          const resume = resumeRef.current
          resumeRef.current = null
          const at = resume?.src === event.currentTarget.currentSrc ? resume.at : startAt
          if (at !== undefined && at > 0) event.currentTarget.currentTime = at
          sync(event.currentTarget)
          onLoadedMetadata?.(event)
        }}
        onPause={(event) => {
          sync(event.currentTarget)
          window.clearTimeout(idleTimerRef.current)
          setIdle(false)
        }}
        onPlay={(event) => {
          sync(event.currentTarget)
          wake()
        }}
        onPlaying={(event) => sync(event.currentTarget)}
        onPointerDown={(event) => {
          pointerTypeRef.current = event.pointerType
        }}
        onProgress={(event) => sync(event.currentTarget)}
        onSeeked={(event) => sync(event.currentTarget)}
        onSuspend={(event) => sync(event.currentTarget)}
        onTimeUpdate={(event) => {
          sync(event.currentTarget)
          onTimeUpdate?.(event)
        }}
        onVolumeChange={(event) => sync(event.currentTarget)}
        onWaiting={(event) => sync(event.currentTarget)}
        playsInline
        poster={poster}
        preload="metadata"
        ref={attachVideo}
        src={src}
      />
      {waiting ? <MediaBuffering /> : null}
      {failed ? (
        <div
          className="absolute inset-0 grid place-items-center bg-surface-container p-4"
          role="alert"
        >
          <MediaFallback kind="video" onRetry={retry} />
        </div>
      ) : (
        <>
          <div aria-hidden className="video-player-shade" />
          <div className="video-player-bar" ref={barRef}>
            <IconButton
              className={BAR_BUTTON}
              label={paused ? '播放' : '暂停'}
              name={paused ? 'play' : 'pause'}
              onClick={toggle}
              size="sm"
            />
            <IconButton
              className={BAR_BUTTON}
              label={muted ? '开启声音' : '静音'}
              name={muted ? 'audio-off' : 'audio'}
              onClick={toggleMute}
              size="sm"
            />
            <span className="video-player-time">{formatClock(time)}</span>
            <Slider.Root
              className="video-player-slider"
              disabled={duration <= 0}
              max={duration > 0 ? duration : 1}
              onValueChange={([at]) => {
                if (at !== undefined) seekTo(at)
              }}
              step={0.1}
              value={[Math.min(time, duration)]}
            >
              <Slider.Track className="video-player-track">
                {buffered.map(({ start, end }) => (
                  <span
                    aria-hidden
                    className="video-player-buffered"
                    data-testid="video-buffered"
                    key={start}
                    style={{ left: percent(start), width: percent(end - start) }}
                  />
                ))}
                <Slider.Range className="video-player-range" />
              </Slider.Track>
              <Slider.Thumb
                aria-label="播放进度"
                aria-valuetext={`${formatClock(time)} / ${formatClock(duration)}`}
                className="video-player-thumb"
              />
            </Slider.Root>
            <span className="video-player-time video-player-total">{formatClock(duration)}</span>
            {onExpand === undefined ? null : (
              <IconButton
                className={BAR_BUTTON}
                label="放大"
                name="zoom"
                onClick={expand}
                size="sm"
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
