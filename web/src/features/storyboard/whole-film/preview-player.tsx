import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import type { TimeSpan } from '@/shared/lib/time-spans'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { MediaFallback } from '@/shared/ui/media-fallback'
import { StageBackdrop } from '../components/stage-backdrop'
import { previewPageUrl, zPreviewEvent, type PreviewCommand } from './preview-protocol'

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

/** 预览页在哪：令牌还在取时是 `pending`；取不到时是 `failed`，带着给人看的原因。 */
export type PreviewPageAddress =
  | { kind: 'pending' }
  | { kind: 'ready'; origin: string; token: string }
  | { kind: 'failed'; message: string; onRetry: () => void }

/** 交给预览页的一份成片：整份预览文档，和预览域名下的运行库地址（见 `previewRuntimeSrc`）。 */
export type PreviewFilm = { html: string; runtimeSrc: string }

type PreviewPlayerProps = {
  page: PreviewPageAddress
  /** 成片没有内容时是 undefined。 */
  film: PreviewFilm | undefined
  message: string | undefined
  backdrop: string | undefined
  width: number
  height: number
  playback: PlaybackSettings
  onTime: (ms: number) => void
  onPlaying: (playing: boolean) => void
  controlRef: RefObject<PreviewControl | null>
  onMediaSettled?: (() => void) | undefined
  onBuffering?: ((buffering: boolean) => void) | undefined
  onBuffered?: ((spans: readonly TimeSpan[]) => void) | undefined
  children?: ReactNode
}

/** 预览页报「就绪」时的那个页面：重新报一次就是新的一份，要把状态重发一遍。 */
type Link = { src: string; target: Window; origin: string }

/** 要发的命令；跳转是第几次，发出去的时候才编号。 */
type Outgoing = Exclude<PreviewCommand, { type: 'seek' }> | { type: 'seek'; ms: number }

/**
 * 成片预览：把预览域名下的预览页嵌进来，按消息协议（preview-protocol.ts）让它加载、播放，
 * 再把它报回来的时间、播放状态、缓冲和失败交给编辑器。
 */
export function PreviewPlayer({
  page,
  film,
  message,
  backdrop,
  width,
  height,
  playback,
  onTime,
  onPlaying,
  controlRef,
  onMediaSettled,
  onBuffering,
  onBuffered,
  children,
}: PreviewPlayerProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const callbacksRef = useRef({ onTime, onPlaying, onMediaSettled, onBuffering, onBuffered })
  useLayoutEffect(() => {
    callbacksRef.current = { onTime, onPlaying, onMediaSettled, onBuffering, onBuffered }
  })

  const origin = page.kind === 'ready' ? page.origin : undefined
  const src = page.kind === 'ready' ? previewPageUrl(page.origin, page.token) : undefined
  const [readyLink, setReadyLink] = useState<Link | null>(null)
  const link = readyLink !== null && readyLink.src === src ? readyLink : null
  // 预览页换上过成片的那个地址：换上过以后，成片没了也还能控制它（让它停下）
  const [shownAt, setShownAt] = useState<string | null>(null)
  const [clipFailed, setClipFailed] = useState(false)

  // 预览页就绪之前的命令先排着，就绪后按顺序发出；`seq` 是发给这个预览页的跳转数
  const outboxRef = useRef<{ target: Link | null; queue: Outgoing[]; seq: number }>({
    target: null,
    queue: [],
    seq: 0,
  })
  const bufferingRef = useRef(false)
  // 就绪之前记下了「在放」：按钮先算在放、舞台先转圈，和第一份成片装好之前一样
  const earlyPlayRef = useRef(false)

  const post = useCallback((command: Outgoing) => {
    const outbox = outboxRef.current
    if (outbox.target === null) {
      outbox.queue.push(command)
      return
    }
    const sent: PreviewCommand =
      command.type === 'seek' ? { ...command, seq: (outbox.seq += 1) } : command
    outbox.target.target.postMessage(sent, outbox.target.origin)
  }, [])
  const reportBuffering = useCallback((buffering: boolean) => {
    bufferingRef.current = buffering
    callbacksRef.current.onBuffering?.(buffering)
  }, [])
  const playEarly = useCallback(
    (wantsPlay: boolean) => {
      earlyPlayRef.current = wantsPlay
      callbacksRef.current.onPlaying(wantsPlay)
      reportBuffering(wantsPlay)
    },
    [reportBuffering],
  )

  useEffect(() => {
    if (src === undefined || origin === undefined) return
    outboxRef.current = { target: null, queue: [], seq: 0 }
    const receive = (event: MessageEvent) => {
      const target = frameRef.current?.contentWindow
      if (event.origin !== origin || target === null || target === undefined) return
      if (event.source !== target) return
      const parsed = zPreviewEvent.safeParse(event.data)
      if (!parsed.success) return
      const on = callbacksRef.current
      const received = parsed.data
      switch (received.type) {
        case 'ready': {
          const next = { src, target, origin }
          const { queue } = outboxRef.current
          // 报一次就绪就是新加载的一份预览页，跳转从头数
          outboxRef.current = { target: next, queue: [], seq: 0 }
          earlyPlayRef.current = false
          for (const command of queue) post(command)
          setReadyLink(next)
          return
        }
        case 'loaded':
          setShownAt(src)
          return
        case 'time':
          if (received.seq === outboxRef.current.seq) on.onTime(received.ms)
          return
        case 'playing':
          on.onPlaying(received.playing)
          return
        case 'buffering':
          reportBuffering(received.buffering)
          return
        case 'buffered':
          on.onBuffered?.(received.spans)
          return
        case 'mediaSettled':
          on.onMediaSettled?.()
          return
        case 'clipFailed':
          setClipFailed(received.failed)
          return
      }
    }
    window.addEventListener('message', receive)
    return () => {
      window.removeEventListener('message', receive)
      outboxRef.current = { target: null, queue: [], seq: 0 }
      if (bufferingRef.current) reportBuffering(false)
    }
  }, [src, origin, post, reportBuffering])

  const { rate, muted, loop } = playback
  useEffect(() => {
    if (link !== null) post({ type: 'playback', rate, muted, loop })
  }, [link, rate, muted, loop, post])

  useEffect(() => {
    if (link !== null) post({ type: 'size', width, height })
  }, [link, width, height, post])

  useEffect(() => {
    if (film !== undefined) {
      if (link !== null) post({ type: 'load', html: film.html, runtimeSrc: film.runtimeSrc })
      return
    }
    if (link !== null) {
      post({ type: 'unload' })
      return
    }
    // 预览页还没就绪：排着的命令作废，记下的「在放」收回
    outboxRef.current.queue = []
    if (earlyPlayRef.current) playEarly(false)
  }, [link, film, post, playEarly])

  const shown = src !== undefined && shownAt === src
  const controllable = src !== undefined && (film !== undefined || shown)
  useEffect(() => {
    if (!controllable) return
    const early = (wantsPlay: boolean) => {
      if (outboxRef.current.target === null) playEarly(wantsPlay)
    }
    controlRef.current = {
      play: () => {
        early(true)
        post({ type: 'play' })
      },
      pause: () => {
        early(false)
        post({ type: 'pause' })
      },
      seek: (ms) => {
        early(false)
        post({ type: 'seek', ms })
      },
    }
    return () => {
      controlRef.current = null
    }
  }, [controllable, controlRef, post, playEarly])

  const failed = link !== null && clipFailed
  return (
    <div aria-label="预览" className="wf-preview" role="region">
      <StageBackdrop url={film === undefined ? undefined : backdrop} />
      <div className="editor-hero-wrap">
        <div
          className="wf-player-host editor-preview stage-picture"
          data-failed={failed ? '' : undefined}
          hidden={film === undefined}
          style={{ '--preview-ratio': width / height } as CSSProperties}
        >
          <div className="wf-player-slot">
            {src === undefined ? null : (
              <iframe
                allow="autoplay"
                className="wf-preview-frame"
                ref={frameRef}
                sandbox="allow-scripts allow-same-origin"
                src={src}
                title="成片预览"
              />
            )}
          </div>
          {failed ? (
            <div className="editor-preview-message" role="alert">
              <MediaFallback kind="video" onRetry={() => post({ type: 'retry' })} />
            </div>
          ) : null}
        </div>
      </div>
      {children}
      {page.kind === 'failed' ? (
        <div className="wf-preview-note">
          <InlineAlert action={{ label: '重试', onClick: page.onRetry }} message={page.message} />
        </div>
      ) : film === undefined && message !== undefined ? (
        <p className="wf-preview-note">{message}</p>
      ) : null}
    </div>
  )
}
