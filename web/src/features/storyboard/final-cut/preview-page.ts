import '@hyperframes/player'
import {
  createIframePreviewAdapter,
  openComposition,
  type Composition,
  type JsonPatchOp,
} from '@hyperframes/sdk'
import { apiFetch } from '@/shared/api/client'
import { zFinalCutPreviewHostOut } from '@/shared/api/generated/zod.gen'
import { mergeSpans, sameSpans, spansOf, windowSpans, type TimeSpan } from '@/shared/lib/time-spans'
import { FONT_BLOCK_START } from './composition/film'
import { withPreviewMediaPatches } from './preview-media'
import { zPreviewCommand, type PreviewCommand, type PreviewEvent } from './preview-protocol'
import { secondsToFrame, STUDIO_PREVIEW_FPS } from './vendor/hyperframes-studio/player/lib/time'

// 预览页：预览域名下的一个独立页面，播放器和 final-cut 都在这里运行。编辑器只经消息控制它（见 preview-protocol.ts）。

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

/**
 * 播放器里那一份 final-cut 的副本会话：`comp` 打开的就是播放器加载的那份文档，`captions` 打开的是放进文档里的
 * 字幕场景文件（没有时是 null），元素的 `data-hf-id` 都和播放器里的一一对上；给它们打补丁时 SDK 的预览适配器
 * 把同样的补丁打进播放器里正在播的文档。`seq` 是它现在是第几份。
 */
type Replica = {
  comp: Composition
  captions: Composition | null
  seq: number
  dispose: () => void
}

/** 用 `html` 开一个副本会话，补丁经 SDK 的预览适配器同步进 `player`；答复会话和停止同步的函数。 */
const openSynced = async (player: PlayerElement, html: string) => {
  const adapter = createIframePreviewAdapter(player.iframeElement)
  const comp = await openComposition(html, { preview: adapter, history: false })
  const detach = adapter.attachSync(comp)
  return {
    comp,
    dispose: () => {
      detach()
      comp.dispose()
    },
  }
}

const openReplica = async (
  player: PlayerElement,
  html: string,
  captions: string | undefined,
  seq: number,
): Promise<Replica> => {
  const main = await openSynced(player, html)
  let scene: Awaited<ReturnType<typeof openSynced>> | null = null
  try {
    scene = captions === undefined ? null : await openSynced(player, captions)
  } catch (error) {
    main.dispose()
    throw error
  }
  return {
    comp: main.comp,
    captions: scene?.comp ?? null,
    seq,
    dispose: () => {
      scene?.dispose()
      main.dispose()
    },
  }
}

const ELEMENT_PATH = /^\/elements\/([^/]+)(\/.*)?$/

// JSON Pointer 里的 `~1`、`~0` 是 `/`、`~`
const unescapePointer = (segment: string) => segment.replaceAll('~1', '/').replaceAll('~0', '~')

const hfIdsOf = (page: Document) =>
  new Set(
    [...page.querySelectorAll('[data-hf-id]')].map((element) => element.getAttribute('data-hf-id')),
  )

const parentIdOf = (value: unknown) =>
  typeof value === 'object' &&
  value !== null &&
  'parentId' in value &&
  typeof value.parentId === 'string'
    ? value.parentId
    : undefined

/**
 * 补丁要改的元素在 `page` 里是不是都在（按补丁的先后算上前面加、删的）。SDK 遇到找不到的元素不报错、直接跳过，
 * 比如加载时去掉了的隐藏片段，所以打之前先查。
 */
const targetsPresent = (page: Document, patches: readonly JsonPatchOp[]) => {
  const present = hfIdsOf(page)
  return patches.every((patch) => {
    const matched = ELEMENT_PATH.exec(patch.path)
    if (matched === null) return true
    const id = unescapePointer(matched[1] ?? '')
    if (matched[2] !== undefined) return present.has(id)
    if (patch.op === 'remove') return present.delete(id)
    const parent = parentIdOf(patch.value)
    if (
      (patch.op === 'replace' && !present.has(id)) ||
      (parent !== undefined && !present.has(parent))
    )
      return false
    present.add(id)
    return true
  })
}

/**
 * 补丁要把总长改长时，先告诉播放器里的运行库：它的时间线只在加载时按根上的 `data-duration` 定长，根上的属性后来变了
 * 它不跟着，跳不到、也放不到原来的结尾以后。它的 set-root-duration 控制消息只认比根上写的更长的值，所以要在补丁
 * 改根之前、同步派发（`postMessage` 要等下一轮，那时根已经改了）。
 */
const extendRuntime = (player: PlayerElement, patches: readonly JsonPatchOp[]) => {
  const duration = patches.findLast(
    (patch) => patch.path === '/metadata/duration' && patch.op !== 'remove',
  )?.value
  const page = player.iframeElement.contentWindow as (Window & typeof globalThis) | null
  if (typeof duration !== 'number' || page === null) return
  page.dispatchEvent(
    new page.MessageEvent('message', {
      data: {
        source: 'hf-parent',
        type: 'control',
        action: 'set-root-duration',
        durationSeconds: duration,
      },
      source: window,
    }),
  )
}

const FONT_MARKER = FONT_BLOCK_START.replace(/^<!--|-->$/g, '').trim()

const isStyle = (node: Node): node is HTMLStyleElement => node.nodeName === 'STYLE'

/** `page` 的 `<head>` 里字体块的中文字体规则（开始标记之后、结束标记之前的那个 `<style>`）；没有时是 null。 */
const fontStyleIn = (page: Document): HTMLStyleElement | null => {
  const walker = page.createTreeWalker(page.head, NodeFilter.SHOW_COMMENT)
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue?.trim() !== FONT_MARKER) continue
    for (let node = walker.currentNode.nextSibling; node !== null; node = node.nextSibling) {
      if (node.nodeType === Node.COMMENT_NODE) return null
      if (isStyle(node)) return node
    }
  }
  return null
}

const isMedia = (element: Element | undefined): element is HTMLMediaElement =>
  element?.tagName === 'VIDEO' || element?.tagName === 'AUDIO'

/**
 * 补丁加进来的、改了 `muted` 属性的视频和音频照运行库的规则重算 `.muted`（预览静音或者元素自己写着静音）：
 * 运行库只在加载和切换静音时算，属性变了不跟着变。
 */
const syncMuted = (page: Document, patches: readonly JsonPatchOp[], muted: boolean) => {
  for (const patch of patches) {
    const matched = ELEMENT_PATH.exec(patch.path)
    const added = matched?.[2] === undefined && patch.op !== 'remove'
    if (matched === null || !(added || matched[2] === '/attributes/muted')) continue
    const id = unescapePointer(matched[1] ?? '')
    const media = [...page.querySelectorAll('[data-hf-id]')].find(
      (element) => element.getAttribute('data-hf-id') === id,
    )
    if (isMedia(media)) media.muted = muted || media.hasAttribute('muted')
  }
}

export type PreviewPage = {
  handle: (command: PreviewCommand) => void
  /** 拆掉播放器和所有监听，之后不再发消息。 */
  dispose: () => void
}

/**
 * 在 `mount` 里放播放器、按命令换 final-cut 和播放，状态经 `send` 报出去。
 *
 * 换 final-cut 时新播放器先在底下加载，画好、停稳以后才换上来；第一份装好之前的播放、跳转先记下，
 * 装好后照着办。一步编辑的补丁（`patch`）经副本会话直接打进正在播的那一份，不换播放器。
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
  // 第一份 final-cut 装好之前记下的位置（秒）
  let startAt = 0
  // final-cut 连着改时只加载停下来的那一份
  let scheduled: ReturnType<typeof setTimeout> | undefined
  let pending: { next: PlayerElement; cancelled: boolean } | null = null
  // 换上来的播放器按当前状态放或停；没有播放器时是 null
  let syncActive: (() => void) | null = null
  let detachActive: (() => void) | null = null
  let failed = false
  // 处理到的最后一次跳转，报时刻时带上
  let seekSeq = 0
  // 跳转以后到再次播放（或换上新的播放器）之前不报时刻，播放头由编辑器定（它跳转时自己放过去了）。
  // 运行库报回时刻是异步的：连着跳转时，上一次跳转的时刻可能在处理完这一次以后才到，带着这一次的序号
  // 报出去会把播放头拉回去
  let seekHeld = false
  // 换上来的播放器的副本会话；打补丁出过错、收到新的一份时作废，到下一份换上来之前都是 null
  let replica: Replica | null = null
  let disposed = false

  const dropReplica = () => {
    replica?.dispose()
    replica = null
  }

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
    if (page === null) throw new Error('预览播放器里没有 final-cut 页面')
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
      if (!seekHeld) send({ type: 'time', ms: Math.round(seconds * 1000), seq: seekSeq })
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

  const activate = (next: PlayerElement, nextReplica: Replica | null, seq: number) => {
    const first = active === null
    detachActive?.()
    // 第一份装好之前记下的「在放」一直报着在等；交给新播放器重新判断
    if (first && wantsPlay) send({ type: 'buffering', buffering: false })
    active = next
    dropReplica()
    replica = nextReplica
    applyPlayback(next, playback)
    applySize(next)
    // 旧播放器拆掉了，它还在路上的跳转时刻不会再来；新播放器停在哪（总长变短时收在结尾）照常报给编辑器
    seekHeld = false
    attach(next)
    reportFailure()
    send({ type: 'loaded', duration: next.duration, seq })
  }

  const cancelPending = () => {
    clearTimeout(scheduled)
    if (pending === null) return
    pending.cancelled = true
    pending.next.remove()
    pending = null
  }

  const load = (html: string, runtimeSrc: string, captions: string | undefined, seq: number) => {
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
    // 收到 srcdoc 时按它把运行库写进 final-cut 页面，不给就去外网 CDN 取
    next.setAttribute('runtime-src', runtimeSrc)
    applySize(next)
    // 加载 final-cut 前就带上，换播放器时倍速、静音、循环不会先回到默认再变
    applyPlayback(next, playback)
    next.classList.add('is-pending')
    // 换上来之前看不见，读屏也不该读到它
    next.setAttribute('aria-hidden', 'true')
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
      let nextReplica: Replica | null = null
      try {
        nextReplica = await openReplica(next, html, captions, seq)
      } catch (error) {
        // 没有副本会话时每次改动都报 needsLoad、整份重新加载
        console.error('预览页打不开 final-cut 的副本会话', error)
      }
      if (job.cancelled) {
        nextReplica?.dispose()
        return
      }
      if (resumeAt() !== settledAt) next.seek(resumeAt())
      pending = null
      next.classList.remove('is-pending')
      next.removeAttribute('aria-hidden')
      activate(next, nextReplica, seq)
    })()
  }

  /**
   * 把第 `seq` 份的补丁（主文件的 `patches`、字幕场景的 `captions`）打进正在播的那一份，`fonts` 是新的中文字体
   * 规则时先换上（浏览器按新规则取字形）；打不了时报 `needsLoad`，副本会话作废，等整份重新加载。
   */
  const patch = (
    seq: number,
    patches: readonly JsonPatchOp[],
    captions: readonly JsonPatchOp[],
    fonts: string | undefined,
  ) => {
    const player = active
    const page = player?.iframeElement.contentDocument ?? null
    const current = replica
    const fontStyle = page === null || fonts === undefined ? null : fontStyleIn(page)
    if (
      player === null ||
      page === null ||
      current === null ||
      seq !== current.seq + 1 ||
      (captions.length > 0 && current.captions === null) ||
      (fonts !== undefined && fontStyle === null) ||
      !targetsPresent(page, [...patches, ...captions])
    ) {
      dropReplica()
      send({ type: 'needsLoad', seq })
      return
    }
    try {
      if (fontStyle !== null && fonts !== undefined) fontStyle.textContent = fonts
      extendRuntime(player, patches)
      current.comp.applyPatches(withPreviewMediaPatches(patches))
      if (captions.length > 0) current.captions?.applyPatches(captions)
    } catch (error) {
      console.error('预览页打补丁失败，整份重新加载', error)
      dropReplica()
      send({ type: 'needsLoad', seq })
      return
    }
    current.seq = seq
    syncMuted(page, patches, playback.muted)
    // 停着时运行库不重画，原地跳一下
    if (player.paused) player.seek(player.currentTime)
    syncActive?.()
    reportFailure()
    send({ type: 'patched', duration: player.duration, seq })
  }

  const handle = (command: PreviewCommand) => {
    if (disposed) return
    switch (command.type) {
      case 'load': {
        cancelPending()
        // 正在播的那一份要被换掉，补丁不再往里打
        dropReplica()
        const { html, runtimeSrc, captions, seq } = command
        scheduled = setTimeout(() => load(html, runtimeSrc, captions, seq), RELOAD_DELAY_MS)
        return
      }
      case 'patch':
        patch(command.seq, command.patches, command.captions ?? [], command.fonts)
        return
      case 'unload':
        cancelPending()
        if (active !== null || wantsPlay) setWantsPlay(false)
        return
      case 'play':
        seekHeld = false
        if (active !== null && active.currentTime >= active.duration) active.seek(0)
        setWantsPlay(true)
        return
      case 'pause':
        setWantsPlay(false)
        return
      case 'seek':
        seekSeq = command.seq
        seekHeld = true
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
      dropReplica()
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
    `/final-cut/preview/${encodeURIComponent(token)}/host`,
    zFinalCutPreviewHostOut,
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
