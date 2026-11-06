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

/** 编辑后等这么久再重载预览 */
const RELOAD_DELAY_MS = 250

/** 新播放器跳到要接着的时刻后，等这么多帧再换上（运行时在 iframe 里按帧画出那一刻） */
const SETTLE_FRAMES = 3

/**
 * 跳到离 ms 最近的那一帧。合成页不写帧率，运行时按 30 帧走，跳转时刻向下取整到帧；报回来的帧时刻
 * 取整到毫秒后会略小于那一帧，直接加步长再跳会少走一帧。传帧中间的时刻，取整后正好落在这一帧。
 */
const frameSeconds = (ms: number) => (secondsToFrame(ms / 1000) + 0.5) / STUDIO_PREVIEW_FPS

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
  readonly duration: number
  readonly paused: boolean
  /** 素材就绪、加载面板淡出，页面已经画在屏幕上；每次换页重置 */
  readonly painted: boolean
  readonly _media: { _createEntry: () => null }
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
  /** 显示中的合成页里所有视频都不再下载时调用；页里没有视频时不调用。可能调用多次。 */
  onMediaSettled?: (() => void) | undefined
  /** 当前片段数据不够、时间线停下等待时给 true，等完给 false；等待中 `onPlaying` 保持 true */
  onBuffering?: ((buffering: boolean) => void) | undefined
  /** 铺满预览卡片的一层（画面点选）：选中框、把手能画到画面外 */
  children?: ReactNode
}

const once = (target: EventTarget, type: string) =>
  new Promise<void>((resolve) => target.addEventListener(type, () => resolve(), { once: true }))

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

/** 缓冲恢复时，当前位置往后至少要有这么多秒；片段剩得更少时缓冲到片段结束就够 */
const RESUME_BUFFER_SECONDS = 3

/** 缓冲段的起点比当前位置晚不超过这么多秒，也算覆盖当前位置 */
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

/** iframe 里这些媒体事件会改变 `syncMedia` 的判断；不冒泡，要在文档上捕获 */
const MEDIA_EVENTS = ['suspend', 'error', 'progress', 'canplay', 'seeked']

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
  onMediaSettled,
  onBuffering,
  children,
}: PreviewPlayerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState(false)
  // 正在显示的播放器；只有它的事件驱动编辑器
  const [active, setActive] = useState<PlayerElement | null>(null)
  const activeRef = useRef<PlayerElement | null>(null)
  const callbacksRef = useRef({ onTime, onPlaying, onFrame, onMediaSettled, onBuffering })
  const sizeRef = useRef({ width, height })
  // 用户想不想播放：缓冲造成的暂停不改它，换页后也按它接着放
  const wantsPlayRef = useRef(false)
  // 新页加载中：旧播放器要停着，它的媒体事件不能把它放起来
  const swappingRef = useRef(false)
  useLayoutEffect(() => {
    callbacksRef.current = { onTime, onPlaying, onFrame, onMediaSettled, onBuffering }
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
    const page = active?.iframeElement.contentDocument
    if (active === null || page === null || page === undefined) return
    swappingRef.current = false
    let buffering = false
    const atEnd = () => active.currentTime >= active.duration
    /** 时间线与下载状态的唯一决策点：运行时的时间线不等视频，要由这里停下、接着放 */
    const syncMedia = () => {
      const wantsPlay = wantsPlayRef.current && !swappingRef.current
      const videos = [...page.querySelectorAll<HTMLVideoElement>('video[data-start]')]
      const seconds = active.currentTime
      const clip = videos.find((video) => {
        const start = Number(video.dataset['start'])
        return start <= seconds && seconds < start + Number(video.dataset['duration'])
      })
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
      // 停下，跳过去停在那里；之后从那里接着放
      seek: (ms) => {
        setWantsPlay(false)
        active.seek(frameSeconds(ms))
      },
    }
    // 播放器画好才换上来，小文件这时已经下完，不会再有事件；换页要接着放也靠这一次
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

  useEffect(() => {
    if (active === null) return
    active.setAttribute('width', String(width))
    active.setAttribute('height', String(height))
  }, [active, width, height])

  useEffect(() => {
    if (!loaded) return
    if (srcdoc === undefined) {
      // 合成不了时只显示原因；藏起来的旧页面不能接着出声
      controlRef.current?.pause()
      return
    }
    let cancelled = false
    let pending: PlayerElement | null = null
    // 连着改几下只重载最后一版
    const timer = setTimeout(() => {
      const host = hostRef.current
      if (host === null) return
      const old = activeRef.current
      swappingRef.current = true
      old?.pause()
      const resumeAt = old?.currentTime ?? 0
      const next = document.createElement('hyperframes-player') as PlayerElement
      // 不让播放器给每段视频在父页面另建不跨域的副本（每个文件下载两遍）。没有公开开关，版本锁定，升级要复查
      next._media._createEntry = () => null
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
          hidden={srcdoc === undefined}
          style={{ '--preview-ratio': width / height } as CSSProperties}
        >
          {/* 播放器由下面的 effect 直接放进这一层，不归 React 管 */}
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
