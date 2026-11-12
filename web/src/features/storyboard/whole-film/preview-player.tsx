import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { mergeSpans, sameSpans, spansOf, windowSpans, type TimeSpan } from '@/shared/lib/time-spans'
import { MediaFallback } from '@/shared/ui/media-fallback'
import { StageBackdrop } from '../components/stage-backdrop'
import { secondsToFrame, STUDIO_PREVIEW_FPS } from './vendor/hyperframes-studio/player/lib/time'

const RELOAD_DELAY_MS = 250

const SETTLE_FRAMES = 3

const frameSeconds = (ms: number) => (secondsToFrame(ms / 1000) + 0.5) / STUDIO_PREVIEW_FPS

export type PreviewControl = {
  play: () => void
  pause: () => void
  seek: (ms: number) => void
}

/** 编辑时怎么听、怎么放：只管预览，不写进成片文件。 */
export type PlaybackSettings = {
  rate: number
  muted: boolean
  /** 成片播到结尾从头接着播。 */
  loop: boolean
}

type PlayerElement = HTMLElement & {
  readonly iframeElement: HTMLIFrameElement
  play: () => void
  pause: () => void
  seek: (seconds: number) => void
  readonly currentTime: number
  readonly duration: number
  readonly paused: boolean
  readonly painted: boolean
  playbackRate: number
  muted: boolean
  loop: boolean
  readonly _media: { _createEntry: () => null }
}

const applyPlayback = (player: PlayerElement, { rate, muted, loop }: PlaybackSettings) => {
  player.playbackRate = rate
  player.muted = muted
  player.loop = loop
}

type PreviewPlayerProps = {
  srcdoc: string | undefined
  message: string | undefined
  backdrop: string | undefined
  width: number
  height: number
  playback: PlaybackSettings
  onTime: (ms: number) => void
  onPlaying: (playing: boolean) => void
  controlRef: RefObject<PreviewControl | null>
  onFrame?: ((iframe: HTMLIFrameElement | null) => void) | undefined
  onMediaSettled?: (() => void) | undefined
  onBuffering?: ((buffering: boolean) => void) | undefined
  onBuffered?: ((spans: readonly TimeSpan[]) => void) | undefined
  children?: ReactNode
}

const once = (target: EventTarget, type: string) =>
  new Promise<void>((resolve) => target.addEventListener(type, () => resolve(), { once: true }))

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

const RESUME_BUFFER_SECONDS = 3

const BUFFER_START_TOLERANCE_SECONDS = 0.05

const hasResumeBuffer = (video: HTMLVideoElement) => {
  if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return false
  // 下完的文件 buffered 也可能够不到结尾，不再下载就不会有新数据，等下去是永远转圈
  if (video.networkState !== HTMLMediaElement.NETWORK_LOADING) return true
  const { buffered, currentTime } = video
  const clipEnd = Number(video.dataset['mediaStart'] ?? 0) + Number(video.dataset['duration'])
  const needed = Math.max(0, Math.min(RESUME_BUFFER_SECONDS, clipEnd - currentTime))
  return Array.from({ length: buffered.length }).some(
    (_, at) =>
      buffered.start(at) <= currentTime + BUFFER_START_TOLERANCE_SECONDS &&
      buffered.end(at) - currentTime >= needed,
  )
}

// 媒体事件不冒泡，要在 iframe 文档上捕获
const MEDIA_EVENTS = ['suspend', 'error', 'progress', 'canplay', 'seeked']

const FAILURE_EVENTS = ['error', 'emptied']

const playsAt = (video: HTMLVideoElement, seconds: number) => {
  const start = Number(video.dataset['start'])
  return start <= seconds && seconds < start + Number(video.dataset['duration'])
}

const failedClipOf = (player: PlayerElement | null) => {
  const page = player?.iframeElement.contentDocument
  if (player === null || page === null || page === undefined) return null
  const clip = [...page.querySelectorAll<HTMLVideoElement>('video[data-start]')].find((video) =>
    playsAt(video, player.currentTime),
  )
  return clip !== undefined && clip.error !== null ? clip : null
}

export function PreviewPlayer({
  srcdoc,
  message,
  backdrop,
  width,
  height,
  playback,
  onTime,
  onPlaying,
  controlRef,
  onFrame,
  onMediaSettled,
  onBuffering,
  onBuffered,
  children,
}: PreviewPlayerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [active, setActive] = useState<PlayerElement | null>(null)
  const activeRef = useRef<PlayerElement | null>(null)
  const callbacksRef = useRef({
    onTime,
    onPlaying,
    onFrame,
    onMediaSettled,
    onBuffering,
    onBuffered,
  })
  const sizeRef = useRef({ width, height })
  const playbackRef = useRef(playback)
  const wantsPlayRef = useRef(false)
  const swappingRef = useRef(false)
  const startAtRef = useRef(0)
  useLayoutEffect(() => {
    callbacksRef.current = { onTime, onPlaying, onFrame, onMediaSettled, onBuffering, onBuffered }
    sizeRef.current = { width, height }
    playbackRef.current = playback
  })

  const { rate, muted, loop } = playback
  useEffect(() => {
    if (active !== null) applyPlayback(active, { rate, muted, loop })
  }, [active, rate, muted, loop])

  const shown = srcdoc === undefined ? null : active
  useEffect(() => {
    if (shown === null) return
    callbacksRef.current.onFrame?.(shown.iframeElement)
    return () => callbacksRef.current.onFrame?.(null)
  }, [shown])

  useEffect(() => {
    let cancelled = false
    void import('@hyperframes/player').then(() => {
      if (!cancelled) setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const page = active?.iframeElement.contentDocument
    if (active === null || page === null || page === undefined) return
    swappingRef.current = false
    let buffering = false
    let reported: readonly TimeSpan[] | undefined
    const atEnd = () => active.currentTime >= active.duration
    const syncMedia = () => {
      const wantsPlay = wantsPlayRef.current && !swappingRef.current
      const videos = [...page.querySelectorAll<HTMLVideoElement>('video[data-start]')]
      const seconds = active.currentTime
      const clip = videos.find((video) => playsAt(video, seconds))
      const clipReady =
        clip === undefined ||
        clip.error !== null ||
        (buffering ? hasResumeBuffer(clip) : clip.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA)
      if (buffering !== (wantsPlay && !clipReady)) {
        buffering = !buffering
        callbacksRef.current.onBuffering?.(buffering)
      }
      const running = wantsPlay && !buffering
      // 放到结尾时播放器已停、ended 还没来；这时 play() 会跳回开头重放
      if (running && active.paused && !atEnd()) active.play()
      if (!running && !active.paused) active.pause()
      if (
        videos.length > 0 &&
        videos.every((video) => video.networkState !== HTMLMediaElement.NETWORK_LOADING)
      )
        callbacksRef.current.onMediaSettled?.()
      const spans = mergeSpans(
        videos.flatMap((video) => {
          const mediaStart = Number(video.dataset['mediaStart'] ?? 0)
          return windowSpans(
            spansOf(video.buffered),
            mediaStart,
            mediaStart + Number(video.dataset['duration']),
            Number(video.dataset['start']),
          )
        }),
      )
      if (reported === undefined || !sameSpans(reported, spans)) {
        reported = spans
        callbacksRef.current.onBuffered?.(spans)
      }
    }
    const setWantsPlay = (wantsPlay: boolean) => {
      wantsPlayRef.current = wantsPlay
      callbacksRef.current.onPlaying(wantsPlay)
      syncMedia()
    }
    const onTimeUpdate = (event: Event) => {
      const seconds = (event as CustomEvent<{ currentTime: number }>).detail.currentTime
      callbacksRef.current.onTime(Math.round(seconds * 1000))
      syncMedia()
    }
    const onEnded = () => setWantsPlay(false)
    active.addEventListener('timeupdate', onTimeUpdate)
    active.addEventListener('ended', onEnded)
    for (const type of MEDIA_EVENTS) page.addEventListener(type, syncMedia, true)
    controlRef.current = {
      play: () => {
        if (atEnd()) active.seek(0)
        setWantsPlay(true)
      },
      pause: () => setWantsPlay(false),
      seek: (ms) => {
        setWantsPlay(false)
        active.seek(frameSeconds(ms))
      },
    }
    // 换上来之前的媒体事件已经错过，小文件这时不会再有事件
    syncMedia()
    return () => {
      if (buffering) callbacksRef.current.onBuffering?.(false)
      active.removeEventListener('timeupdate', onTimeUpdate)
      active.removeEventListener('ended', onEnded)
      for (const type of MEDIA_EVENTS) page.removeEventListener(type, syncMedia, true)
      active.remove()
      controlRef.current = null
    }
  }, [active, controlRef])

  const watchFailure = useCallback(
    (notify: () => void) => {
      const page = active?.iframeElement.contentDocument
      if (active === null || page === null || page === undefined) return () => {}
      active.addEventListener('timeupdate', notify)
      for (const type of FAILURE_EVENTS) page.addEventListener(type, notify, true)
      return () => {
        active.removeEventListener('timeupdate', notify)
        for (const type of FAILURE_EVENTS) page.removeEventListener(type, notify, true)
      }
    },
    [active],
  )
  const clipFailed = useSyncExternalStore(watchFailure, () => failedClipOf(active) !== null)

  const awaitingFirst = active === null && srcdoc !== undefined
  useEffect(() => {
    if (!awaitingFirst) return
    const setWantsPlay = (wantsPlay: boolean) => {
      wantsPlayRef.current = wantsPlay
      callbacksRef.current.onPlaying(wantsPlay)
      callbacksRef.current.onBuffering?.(wantsPlay)
    }
    controlRef.current = {
      play: () => setWantsPlay(true),
      pause: () => setWantsPlay(false),
      seek: (ms) => {
        setWantsPlay(false)
        startAtRef.current = frameSeconds(ms)
      },
    }
    return () => {
      controlRef.current = null
      if (!wantsPlayRef.current) return
      if (activeRef.current === null) setWantsPlay(false)
      else callbacksRef.current.onBuffering?.(false)
    }
  }, [awaitingFirst, controlRef])

  useEffect(() => {
    if (active === null) return
    active.setAttribute('width', String(width))
    active.setAttribute('height', String(height))
  }, [active, width, height])

  useEffect(() => {
    if (!loaded) return
    if (srcdoc === undefined) {
      controlRef.current?.pause()
      return
    }
    let cancelled = false
    let pending: PlayerElement | null = null
    const timer = setTimeout(() => {
      const host = hostRef.current
      if (host === null) return
      const old = activeRef.current
      swappingRef.current = true
      old?.pause()
      const resumeAt = old?.currentTime ?? startAtRef.current
      const next = document.createElement('hyperframes-player') as PlayerElement
      // 播放器给每段视频在父页面另建不跨域的副本，每个文件下载两遍。没有公开开关，版本锁定，升级要复查
      next._media._createEntry = () => null
      pending = next
      next.setAttribute('disable-click-to-play', '')
      // 加载和缓冲的提示由编辑器自己画，播放器自带的那套不显示
      next.setAttribute('assets-loading-ui', 'none')
      next.setAttribute('width', String(sizeRef.current.width))
      next.setAttribute('height', String(sizeRef.current.height))
      // 加载成片前就带上，换播放器时倍速、静音、循环不会先回到默认再变
      applyPlayback(next, playbackRef.current)
      next.className = 'wf-player is-pending'
      host.append(next)
      void (async () => {
        const ready = once(next, 'ready')
        next.setAttribute('srcdoc', srcdoc)
        await ready
        if (!next.painted) await once(next, 'painted')
        if (cancelled) return
        next.seek(resumeAt)
        for (let frame = 0; frame < SETTLE_FRAMES; frame++) await nextFrame()
        if (cancelled) return
        pending = null
        next.classList.remove('is-pending')
        activeRef.current = next
        setActive(next)
      })()
    }, RELOAD_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
      pending?.remove()
    }
  }, [loaded, srcdoc, controlRef])

  return (
    <div aria-label="预览" className="wf-preview" role="region">
      <StageBackdrop url={srcdoc === undefined ? undefined : backdrop} />
      <div className="editor-hero-wrap">
        <div
          className="wf-player-host editor-preview stage-picture"
          data-failed={clipFailed ? '' : undefined}
          hidden={srcdoc === undefined}
          style={{ '--preview-ratio': width / height } as CSSProperties}
        >
          <div className="wf-player-slot" ref={hostRef} />
          {clipFailed ? (
            <div className="editor-preview-message" role="alert">
              <MediaFallback
                kind="video"
                onRetry={() => {
                  const clip = failedClipOf(activeRef.current)
                  if (clip === null) return
                  clip.preload = 'auto'
                  clip.load()
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
      {children}
      {srcdoc === undefined && message !== undefined ? (
        <p className="wf-preview-note">{message}</p>
      ) : null}
    </div>
  )
}
