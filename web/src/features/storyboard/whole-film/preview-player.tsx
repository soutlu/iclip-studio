import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
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

type PlayerElement = HTMLElement & {
  readonly iframeElement: HTMLIFrameElement
  play: () => void
  pause: () => void
  seek: (seconds: number) => void
  readonly currentTime: number
  readonly paused: boolean
  readonly painted: boolean
}

type PreviewPlayerProps = {
  srcdoc: string | undefined
  message: string | undefined
  backdrop: string | undefined
  width: number
  height: number
  onTime: (ms: number) => void
  onPlaying: (playing: boolean) => void
  controlRef: RefObject<PreviewControl | null>
  onFrame: (iframe: HTMLIFrameElement | null) => void
  children?: ReactNode
}

const once = (target: EventTarget, type: string) =>
  new Promise<void>((resolve) => target.addEventListener(type, () => resolve(), { once: true }))

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

export function PreviewPlayer({
  srcdoc,
  message,
  backdrop,
  width,
  height,
  onTime,
  onPlaying,
  controlRef,
  onFrame,
  children,
}: PreviewPlayerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [active, setActive] = useState<PlayerElement | null>(null)
  const activeRef = useRef<PlayerElement | null>(null)
  const callbacksRef = useRef({ onTime, onPlaying, onFrame })
  const sizeRef = useRef({ width, height })
  useLayoutEffect(() => {
    callbacksRef.current = { onTime, onPlaying, onFrame }
    sizeRef.current = { width, height }
  })

  const shown = srcdoc === undefined ? null : active
  useEffect(() => {
    if (shown === null) return
    callbacksRef.current.onFrame(shown.iframeElement)
    return () => callbacksRef.current.onFrame(null)
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
    if (active === null) return
    const onTimeUpdate = (event: Event) => {
      const seconds = (event as CustomEvent<{ currentTime: number }>).detail.currentTime
      callbacksRef.current.onTime(Math.round(seconds * 1000))
    }
    const onPlay = () => callbacksRef.current.onPlaying(true)
    const onPause = () => callbacksRef.current.onPlaying(false)
    active.addEventListener('timeupdate', onTimeUpdate)
    active.addEventListener('play', onPlay)
    active.addEventListener('pause', onPause)
    active.addEventListener('ended', onPause)
    controlRef.current = {
      play: () => active.play(),
      pause: () => active.pause(),
      seek: (ms) => {
        active.pause()
        active.seek(frameSeconds(ms))
      },
    }
    return () => {
      active.removeEventListener('timeupdate', onTimeUpdate)
      active.removeEventListener('play', onPlay)
      active.removeEventListener('pause', onPause)
      active.removeEventListener('ended', onPause)
      active.remove()
      controlRef.current = null
    }
  }, [active, controlRef])

  useEffect(() => {
    if (active === null) return
    active.setAttribute('width', String(width))
    active.setAttribute('height', String(height))
  }, [active, width, height])

  useEffect(() => {
    if (!loaded) return
    if (srcdoc === undefined) {
      activeRef.current?.pause()
      return
    }
    let cancelled = false
    let pending: PlayerElement | null = null
    const timer = setTimeout(() => {
      const host = hostRef.current
      if (host === null) return
      const old = activeRef.current
      const resumePlaying = old !== null && !old.paused
      old?.pause()
      const resumeAt = old?.currentTime ?? 0
      const next = document.createElement('hyperframes-player') as PlayerElement
      pending = next
      next.setAttribute('disable-click-to-play', '')
      next.setAttribute('width', String(sizeRef.current.width))
      next.setAttribute('height', String(sizeRef.current.height))
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
        if (resumePlaying) next.play()
      })()
    }, RELOAD_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
      pending?.remove()
    }
  }, [loaded, srcdoc])

  return (
    <div aria-label="预览" className="wf-preview" role="region">
      <StageBackdrop url={srcdoc === undefined ? undefined : backdrop} />
      <div className="editor-hero-wrap">
        <div
          className="wf-player-host editor-preview stage-picture"
          hidden={srcdoc === undefined}
          style={{ '--preview-ratio': width / height } as CSSProperties}
        >
          <div className="wf-player-slot" ref={hostRef} />
        </div>
      </div>
      {children}
      {srcdoc === undefined && message !== undefined ? (
        <p className="wf-preview-note">{message}</p>
      ) : null}
    </div>
  )
}
