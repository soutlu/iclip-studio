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

/** 编辑后等这么久再重载预览 */
const RELOAD_DELAY_MS = 250

/** 新播放器跳到要接着的时刻后，等这么多帧再换上（运行时在 iframe 里按帧画出那一刻） */
const SETTLE_FRAMES = 3

/** 编辑器控制预览播放器：工具条的播放暂停、时间线上点哪跳到哪 */
export type PreviewControl = {
  play: () => void
  pause: () => void
  seek: (ms: number) => void
}

/** `@hyperframes/player` 注册的 `<hyperframes-player>` 元素上我们用到的那几样 */
type PlayerElement = HTMLElement & {
  /** 渲染合成页的同源 iframe（在播放器的 shadow DOM 里） */
  readonly iframeElement: HTMLIFrameElement
  play: () => void
  pause: () => void
  seek: (seconds: number) => void
  readonly currentTime: number
  readonly paused: boolean
  /** 素材就绪、加载面板淡出，页面已经画在屏幕上；每次换页重置 */
  readonly painted: boolean
}

type PreviewPlayerProps = {
  /** 合成页；undefined 时不放，显示 message */
  srcdoc: string | undefined
  message: string | undefined
  backdrop: string | undefined
  width: number
  height: number
  onTime: (ms: number) => void
  onPlaying: (playing: boolean) => void
  controlRef: RefObject<PreviewControl | null>
  /** 正在显示的合成页 iframe：每次换上新播放器、画好之后给一次；拆掉、合成不了时给 null */
  onFrame: (iframe: HTMLIFrameElement | null) => void
  /** 盖在画面上的一层（画面点选） */
  children?: ReactNode
}

const once = (target: EventTarget, type: string) =>
  new Promise<void>((resolve) => target.addEventListener(type, () => resolve(), { once: true }))

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

/**
 * HyperFrames 播放器。合成页换了（每次编辑后）就在底下另起一个播放器加载新页：就绪、跳到原来的时刻、
 * 画出第一帧之后才换上来，旧的随即拆掉，所以换页时看不到加载中途的画面（例如还没藏起来的视频第一帧）。
 * 原来在放的，换页时先停住，换上来后接着放。播放器自己的控件不显示，播放暂停与时间都由编辑器控制。
 */
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
  // 正在显示的播放器；只有它的事件驱动编辑器
  const [active, setActive] = useState<PlayerElement | null>(null)
  const activeRef = useRef<PlayerElement | null>(null)
  const callbacksRef = useRef({ onTime, onPlaying, onFrame })
  const sizeRef = useRef({ width, height })
  useLayoutEffect(() => {
    callbacksRef.current = { onTime, onPlaying, onFrame }
    sizeRef.current = { width, height }
  })

  // 画面上显示的合成页：换上来的播放器画好之后才交出去；合成不了时页面藏起来，不再交
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

  // 正在显示的播放器：接上事件；换下或卸载时拆掉
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
      // 播放器跳转后停在那里（不发 pause 事件）；原来在放就接着放
      seek: (ms) => {
        const wasPlaying = !active.paused
        active.seek(ms / 1000)
        if (wasPlaying) active.play()
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
      // 合成不了时只显示原因；藏起来的旧页面不能接着出声
      activeRef.current?.pause()
      return
    }
    let cancelled = false
    let pending: PlayerElement | null = null
    // 连着改几下只重载最后一版
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
        // 就绪后运行时还没按时间线藏起不在当前时刻的层（视频第一帧会露出来）：
        // 跳一次到要接着的时刻（0 秒也跳），等那一帧画出来再换上
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
          {/* 播放器由下面的 effect 直接放进这一层，不归 React 管 */}
          <div className="wf-player-slot" ref={hostRef} />
          {children}
        </div>
      </div>
      {srcdoc === undefined && message !== undefined ? (
        <p className="wf-preview-note">{message}</p>
      ) : null}
    </div>
  )
}
