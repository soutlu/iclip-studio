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
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'

export const VIDEO_PLAYER_SELECTOR = '[data-video-player]'

const SEEK_STEP_S = 5
const IDLE_MS = 2000
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_SLOP_PX = 24

const BAR_BUTTON = 'size-(--control-height-md) rounded-full text-on-scrim [&_svg]:size-(--icon-lg)'

type VideoPlayerProps = Pick<
  VideoHTMLAttributes<HTMLVideoElement>,
  'onError' | 'onLoadedMetadata' | 'onTimeUpdate'
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
  hidden?: boolean | undefined
  ref?: Ref<HTMLVideoElement> | undefined
}

type Playback = { paused: boolean; muted: boolean; time: number; duration: number }

const formatClock = (seconds: number) => {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const playbackOf = (video: HTMLVideoElement): Playback => ({
  paused: video.paused,
  muted: video.muted,
  time: video.currentTime,
  duration: Number.isFinite(video.duration) ? video.duration : 0,
})

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
  hidden,
  ref,
  onError,
  onLoadedMetadata,
  onTimeUpdate,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const idleTimerRef = useRef<number | undefined>(undefined)
  const pointerTypeRef = useRef('')
  const lastTapRef = useRef<{ at: number; x: number; y: number } | null>(null)
  const [playback, setPlayback] = useState<Playback>({
    paused: true,
    muted: false,
    time: 0,
    duration: 0,
  })
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

  const sync = (video: HTMLVideoElement) => setPlayback(playbackOf(video))

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
    if (video === null) return
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

  const { paused, muted, time, duration } = playback
  return (
    <div
      aria-label={`播放器：${label}`}
      className={cn(
        'relative touch-manipulation overflow-hidden rounded-md bg-scrim select-none',
        className,
      )}
      data-idle={idle ? '' : undefined}
      data-video-player=""
      hidden={hidden}
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
        onClick={onPictureClick}
        onDurationChange={(event) => sync(event.currentTarget)}
        onEmptied={(event) => sync(event.currentTarget)}
        onError={onError}
        onLoadedMetadata={(event) => {
          if (startAt !== undefined && startAt > 0) event.currentTarget.currentTime = startAt
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
        onPointerDown={(event) => {
          pointerTypeRef.current = event.pointerType
        }}
        onTimeUpdate={(event) => {
          sync(event.currentTarget)
          onTimeUpdate?.(event)
        }}
        onVolumeChange={(event) => sync(event.currentTarget)}
        playsInline
        poster={poster}
        preload="metadata"
        ref={attachVideo}
        src={src}
      />
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
          <IconButton className={BAR_BUTTON} label="放大" name="zoom" onClick={expand} size="sm" />
        )}
      </div>
    </div>
  )
}
