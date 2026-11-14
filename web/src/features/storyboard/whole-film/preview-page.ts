import '@hyperframes/player'
import { apiFetch } from '@/shared/api/client'
import { zWholeFilmPreviewHostOut } from '@/shared/api/generated/zod.gen'
import { mergeSpans, sameSpans, spansOf, windowSpans, type TimeSpan } from '@/shared/lib/time-spans'
import { zPreviewCommand, type PreviewCommand, type PreviewEvent } from './preview-protocol'
import { secondsToFrame, STUDIO_PREVIEW_FPS } from './vendor/hyperframes-studio/player/lib/time'

// 预览页：预览域名下的一个独立页面，播放器和成片都在这里运行。编辑器只经消息控制它（见 preview-protocol.ts）。

const RELOAD_DELAY_MS = 250

const SETTLE_FRAMES = 3

const frameSeconds = (ms: number) => (secondsToFrame(ms / 1000) + 0.5) / STUDIO_PREVIEW_FPS

type PlaybackSettings = { rate: number; muted: boolean; loop: boolean }

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

export type PreviewPage = {
  handle: (command: PreviewCommand) => void
  /** 拆掉播放器和所有监听，之后不再发消息。 */
  dispose: () => void
}

/**
 * 在 `mount` 里放播放器、按命令换成片和播放，状态经 `send` 报出去。
 *
 * 换成片时新播放器先在底下加载，画好、停稳以后才换上来；第一份装好之前的播放、跳转先记下，
 * 装好后照着办。
 */
export const createPreviewPage = (
  mount: HTMLElement,
  send: (event: PreviewEvent) => void,
): PreviewPage => {
  let playback: PlaybackSettings = { rate: 1, muted: false, loop: false }
  let size: { width: number; height: number } | null = null
  let active: PlayerElement | null = null
  let wantsPlay = false
  let swapping = false
  // 第一份成片装好之前记下的位置（秒）
  let startAt = 0
  // 成片连着改时只加载停下来的那一份
  let scheduled: ReturnType<typeof setTimeout> | undefined
  let pending: { next: PlayerElement; cancelled: boolean } | null = null
  // 换上来的播放器按当前状态放或停；没有播放器时是 null
  let syncActive: (() => void) | null = null
  let detachActive: (() => void) | null = null
  let failed = false
  // 处理到的最后一次跳转，报时刻时带上
  let seekSeq = 0
  let disposed = false

  const reportFailure = () => {
    const now = failedClipOf(active) !== null
    if (now === failed) return
    failed = now
    send({ type: 'clipFailed', failed })
  }

  const setWantsPlay = (next: boolean) => {
    wantsPlay = next
    send({ type: 'playing', playing: next })
    // 还没有播放器时，想放就是在等
    if (syncActive === null) send({ type: 'buffering', buffering: next })
    else syncActive()
  }

  const applySize = (player: PlayerElement) => {
    if (size === null) return
    player.setAttribute('width', String(size.width))
    player.setAttribute('height', String(size.height))
  }

  const attach = (player: PlayerElement) => {
    const page = player.iframeElement.contentDocument
    if (page === null) throw new Error('预览播放器里没有成片页面')
    swapping = false
    let buffering = false
    let settled = false
    let reported: readonly TimeSpan[] | undefined
    const syncMedia = () => {
      const running = wantsPlay && !swapping
      const videos = [...page.querySelectorAll<HTMLVideoElement>('video[data-start]')]
      const seconds = player.currentTime
      const clip = videos.find((video) => playsAt(video, seconds))
      const clipReady =
        clip === undefined ||
        clip.error !== null ||
        (buffering ? hasResumeBuffer(clip) : clip.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA)
      if (buffering !== (running && !clipReady)) {
        buffering = !buffering
        send({ type: 'buffering', buffering })
      }
      const plays = running && !buffering
      // 放到结尾时播放器已停、ended 还没来；这时 play() 会跳回开头重放
      if (plays && player.paused && player.currentTime < player.duration) player.play()
      if (!plays && !player.paused) player.pause()
      const nowSettled =
        videos.length > 0 &&
        videos.every((video) => video.networkState !== HTMLMediaElement.NETWORK_LOADING)
      if (nowSettled && !settled) send({ type: 'mediaSettled' })
      settled = nowSettled
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
        send({ type: 'buffered', spans })
      }
    }
    const onTimeUpdate = (event: Event) => {
      const seconds = (event as CustomEvent<{ currentTime: number }>).detail.currentTime
      send({ type: 'time', ms: Math.round(seconds * 1000), seq: seekSeq })
      syncMedia()
      reportFailure()
    }
    const onEnded = () => setWantsPlay(false)
    player.addEventListener('timeupdate', onTimeUpdate)
    player.addEventListener('ended', onEnded)
    for (const type of MEDIA_EVENTS) page.addEventListener(type, syncMedia, true)
    for (const type of FAILURE_EVENTS) page.addEventListener(type, reportFailure, true)
    syncActive = syncMedia
    detachActive = () => {
      if (buffering) send({ type: 'buffering', buffering: false })
      player.removeEventListener('timeupdate', onTimeUpdate)
      player.removeEventListener('ended', onEnded)
      for (const type of MEDIA_EVENTS) page.removeEventListener(type, syncMedia, true)
      for (const type of FAILURE_EVENTS) page.removeEventListener(type, reportFailure, true)
      player.remove()
      syncActive = null
      detachActive = null
    }
    // 换上来之前的媒体事件已经错过，小文件这时不会再有事件
    syncMedia()
  }

  const activate = (next: PlayerElement) => {
    const first = active === null
    detachActive?.()
    // 第一份装好之前记下的「在放」一直报着在等；交给新播放器重新判断
    if (first && wantsPlay) send({ type: 'buffering', buffering: false })
    active = next
    applyPlayback(next, playback)
    applySize(next)
    attach(next)
    reportFailure()
    send({ type: 'loaded', duration: next.duration })
  }

  const cancelPending = () => {
    clearTimeout(scheduled)
    if (pending === null) return
    pending.cancelled = true
    pending.next.remove()
    pending = null
  }

  const load = (html: string, runtimeSrc: string) => {
    swapping = true
    active?.pause()
    // 每次用到时再读：新页加载、等它稳定的这段时间里还可能挪过位置（挪的是旧播放器或记下的起点）
    const resumeAt = () => active?.currentTime ?? startAt
    const next = document.createElement('hyperframes-player') as PlayerElement
    // 播放器给每段视频在父页面另建不跨域的副本，每个文件下载两遍。没有公开开关，版本锁定，升级要复查
    next._media._createEntry = () => null
    const job = { next, cancelled: false }
    pending = job
    next.setAttribute('disable-click-to-play', '')
    // 加载和缓冲的提示由编辑器自己画，播放器自带的那套不显示
    next.setAttribute('assets-loading-ui', 'none')
    // 收到 srcdoc 时按它把运行库写进成片页面，不给就去外网 CDN 取
    next.setAttribute('runtime-src', runtimeSrc)
    applySize(next)
    // 加载成片前就带上，换播放器时倍速、静音、循环不会先回到默认再变
    applyPlayback(next, playback)
    next.classList.add('is-pending')
    mount.append(next)
    void (async () => {
      const ready = once(next, 'ready')
      next.setAttribute('srcdoc', html)
      await ready
      if (!next.painted) await once(next, 'painted')
      if (job.cancelled) return
      const settledAt = resumeAt()
      next.seek(settledAt)
      for (let frame = 0; frame < SETTLE_FRAMES; frame++) await nextFrame()
      if (job.cancelled) return
      if (resumeAt() !== settledAt) next.seek(resumeAt())
      pending = null
      next.classList.remove('is-pending')
      activate(next)
    })()
  }

  const handle = (command: PreviewCommand) => {
    if (disposed) return
    switch (command.type) {
      case 'load': {
        cancelPending()
        const { html, runtimeSrc } = command
        scheduled = setTimeout(() => load(html, runtimeSrc), RELOAD_DELAY_MS)
        return
      }
      case 'unload':
        cancelPending()
        if (active !== null || wantsPlay) setWantsPlay(false)
        return
      case 'play':
        if (active !== null && active.currentTime >= active.duration) active.seek(0)
        setWantsPlay(true)
        return
      case 'pause':
        setWantsPlay(false)
        return
      case 'seek':
        seekSeq = command.seq
        setWantsPlay(false)
        if (active === null) startAt = frameSeconds(command.ms)
        else active.seek(frameSeconds(command.ms))
        return
      case 'playback':
        playback = { rate: command.rate, muted: command.muted, loop: command.loop }
        if (active !== null) applyPlayback(active, playback)
        return
      case 'size':
        size = { width: command.width, height: command.height }
        if (active !== null) applySize(active)
        return
      case 'retry': {
        const clip = failedClipOf(active)
        if (clip === null) return
        clip.preload = 'auto'
        clip.load()
        return
      }
    }
  }

  return {
    handle,
    dispose: () => {
      disposed = true
      cancelPending()
      detachActive?.()
      active = null
    },
  }
}

/**
 * 启动预览页：凭令牌问出发令牌的应用来源，之后只处理这个来源的父页面发来的命令，消息也只发给它。
 * 问不出来（令牌无效或过期，或者是在应用域名下打开的、那里这个地址是 404）时抛错，不建播放器、不监听消息。
 *
 * @returns 停止预览页的函数。
 */
export const bootPreviewPage = async (token: string, mount: HTMLElement): Promise<() => void> => {
  if (token === '') throw new Error('预览页地址里没有令牌')
  const { appOrigin } = await apiFetch(
    `/whole-film/preview/${encodeURIComponent(token)}/host`,
    zWholeFilmPreviewHostOut,
    { fallbackErrorMessage: '预览页确认应用来源失败' },
  )
  const parent = window.parent
  const page = createPreviewPage(mount, (event) => parent.postMessage(event, appOrigin))
  const receive = (event: MessageEvent) => {
    if (event.origin !== appOrigin || event.source !== parent) return
    const parsed = zPreviewCommand.safeParse(event.data)
    if (parsed.success) page.handle(parsed.data)
  }
  window.addEventListener('message', receive)
  parent.postMessage({ type: 'ready' } satisfies PreviewEvent, appOrigin)
  return () => {
    window.removeEventListener('message', receive)
    page.dispose()
  }
}
