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
import type { Point } from './canvas-geometry'
import type { SnapRects } from './canvas-snap'
import type { Rect } from './preview-canvas'
import {
  previewPageUrl,
  zPreviewEvent,
  type LayerMeasure,
  type LayerEntry,
  type PreviewCommand,
} from './preview-protocol'
import { previewSync, type PreviewFilm } from './preview-sync'

/** 画布上一处从上往下能选中的一层（见预览协议的 `picked`）。 */
export type PickedLayer = { layer: number; field: string | null; measure: LayerMeasure }

export type PreviewControl = {
  play: () => void
  pause: () => void
  seek: (ms: number) => void
  /** 画布上 `point` 处从上往下能选中的层（`layers` 表里的位置）；预览页换了、没答时是空的。 */
  pick: (point: Point) => Promise<readonly PickedLayer[]>
  /**
   * 开始挪 `layers`（`layers` 表里的位置）时吸附用的矩形（见预览协议的 `snap`）；要在这一下的第一个 `draft` 之前
   * 问。都找不到、预览页换了、没答时是 null。
   */
  snapRects: (layers: readonly number[]) => Promise<SnapRects | null>
  /**
   * 拖动中先在预览里摆一层（`layers` 表里的位置，见预览协议的 `draft`）；答复它的位移最后加了多少（父元素里的
   * 像素，`pin` 时含挪回中心的那一下），预览页换了、没答时是 null。
   */
  draft: (
    layer: number,
    move: Point,
    styles: Readonly<Record<string, string | null>>,
    pin: boolean,
  ) => Promise<Point | null>
  /** 拖动结束：`keep` 时留着摆好的样子（接着提交），不然摆回去。 */
  draftEnd: (layer: number, keep: boolean) => void
  /**
   * 在片段 `id` 里找画布上 `point` 处的文字字段（`fields` 里的一个；字幕给它自己的编号和变量），结果报给
   * `onTextTarget`。
   */
  editText: (id: string, point: Point, fields: readonly string[]) => void
  /** 改完字，藏起来的文字显示回来；`text` 不是 null 时先换成它。 */
  endText: (text: string | null) => void
}

/** 原地改字找到的文字：片段 `id` 的文字字段 `field`，在画布上的框和字号（像素）。 */
export type TextTarget = { id: string; field: string; rect: Rect; fontSize: number }

/** 编辑时怎么听、怎么放：只管预览，不写进主文件。 */
export type PlaybackSettings = {
  rate: number
  muted: boolean
  /** final-cut 播到结尾从头接着播。 */
  loop: boolean
}

/** 预览页在哪：令牌还在取时是 `pending`；取不到时是 `failed`，带着给人看的原因。 */
export type PreviewPageAddress =
  | { kind: 'pending' }
  | { kind: 'ready'; origin: string; token: string }
  | { kind: 'failed'; message: string; onRetry: () => void }

type PreviewPlayerProps = {
  page: PreviewPageAddress
  /** final-cut 没有内容时是 undefined。 */
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
  /** 画面上的层（见 canvas-layers.ts）：`watch`、`pick`、`draft` 按它在这张表里的位置说是哪一层。 */
  layers?: readonly LayerEntry[] | undefined
  /** 要量的层（`layers` 里的位置）：预览量出来报给 `onMeasured`（只有量得到的）。 */
  watch?: readonly number[] | undefined
  onMeasured?: ((items: ReadonlyMap<number, LayerMeasure>) => void) | undefined
  /** `editText` 的结果；没找到文字时是 null。 */
  onTextTarget?: ((target: TextTarget | null) => void) | undefined
  /** 盖在画面上、和画面一样大的一层（画面上的编辑）；超出画面的部分不裁掉。 */
  overlay?: ReactNode
  children?: ReactNode
}

/** 预览页报「就绪」时的那个页面：重新报一次就是新的一份，要把状态重发一遍。 */
type Link = { src: string; target: Window; origin: string }

/** 要发的命令；跳转是第几次，发出去的时候才编号。 */
type Outgoing = Exclude<PreviewCommand, { type: 'seek' }> | { type: 'seek'; ms: number }

/**
 * 发给当前预览页的 final-cut：`film` 是最后发出的那一份、`seq` 是它的序号；`loadSeq` 是最后一次整份加载的序号，
 * 预览页报这一份装好（`loaded`）之前 `loaded` 是 false，这期间的改动都整份重新加载。
 */
type Sync = { film: PreviewFilm; seq: number; loadSeq: number; loaded: boolean }

/**
 * final-cut 预览：把预览域名下的预览页嵌进来，按消息协议（preview-protocol.ts）让它加载、播放，
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
  layers,
  watch,
  onMeasured,
  onTextTarget,
  overlay,
  children,
}: PreviewPlayerProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const callbacksRef = useRef({
    onTime,
    onPlaying,
    onMediaSettled,
    onBuffering,
    onBuffered,
    onMeasured,
    onTextTarget,
  })
  useLayoutEffect(() => {
    callbacksRef.current = {
      onTime,
      onPlaying,
      onMediaSettled,
      onBuffering,
      onBuffered,
      onMeasured,
      onTextTarget,
    }
  })
  // 最后一次要量的层和最后一次找文字，预览页报回来时按序号对上
  const watchRef = useRef<{ seq: number; layers: readonly number[] }>({ seq: 0, layers: [] })
  // 等预览页回答的 `pick`、`snap`、`draft`（序号 → 收到回答时做什么）
  const answersRef = useRef({
    seq: 0,
    picks: new Map<number, (stack: readonly PickedLayer[]) => void>(),
    snaps: new Map<number, (rects: SnapRects | null) => void>(),
    drafts: new Map<number, (moved: Point | null) => void>(),
  })
  const textRef = useRef<{ seq: number; id: string; fields: readonly string[] }>({
    seq: 0,
    id: '',
    fields: [],
  })

  const origin = page.kind === 'ready' ? page.origin : undefined
  const src = page.kind === 'ready' ? previewPageUrl(page.origin, page.token) : undefined
  const [readyLink, setReadyLink] = useState<Link | null>(null)
  const link = readyLink !== null && readyLink.src === src ? readyLink : null
  // 预览页换上过 final-cut 的那个地址：换上过以后，final-cut 没了也还能控制它（让它停下）
  const [shownAt, setShownAt] = useState<string | null>(null)
  const [clipFailed, setClipFailed] = useState(false)

  // 预览页就绪之前的命令先排着，就绪后按顺序发出；`seq` 是发给这个预览页的跳转数
  const outboxRef = useRef<{ target: Link | null; queue: Outgoing[]; seq: number }>({
    target: null,
    queue: [],
    seq: 0,
  })
  const bufferingRef = useRef(false)
  // 就绪之前记下了「在放」：按钮先算在放、舞台先转圈，和第一份 final-cut 装好之前一样
  const earlyPlayRef = useRef(false)
  // 发给当前预览页的 final-cut；预览页换了一个、或者 final-cut 没了时是 null
  const syncRef = useRef<Sync | null>(null)

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
  const load = useCallback(
    (film: PreviewFilm) => {
      const seq = (syncRef.current?.seq ?? 0) + 1
      syncRef.current = { film, seq, loadSeq: seq, loaded: false }
      const { html, runtimeSrc, captions } = film
      post(
        captions === null
          ? { type: 'load', html, runtimeSrc, seq }
          : { type: 'load', html, runtimeSrc, captions: captions.scene, seq },
      )
    },
    [post],
  )
  /** 把 `film` 交给预览页：能直接打进去的打补丁，别的整份重新加载（见 `previewSync`）。 */
  const show = useCallback(
    (film: PreviewFilm) => {
      const sync = syncRef.current
      const how = previewSync(sync?.loaded === true ? sync.film : null, film)
      if (sync === null || how.kind === 'reload') {
        load(film)
        return
      }
      const seq = sync.seq + 1
      syncRef.current = { ...sync, film, seq }
      post({
        type: 'patch',
        seq,
        patches: [...how.patches],
        ...(how.captions.length === 0 ? {} : { captions: [...how.captions] }),
        ...(how.fonts === undefined ? {} : { fonts: how.fonts }),
      })
    },
    [load, post],
  )
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
    const { picks, snaps, drafts } = answersRef.current
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
          // 报一次就绪就是新加载的一份预览页，跳转从头数，final-cut 要整份重发
          outboxRef.current = { target: next, queue: [], seq: 0 }
          syncRef.current = null
          earlyPlayRef.current = false
          for (const command of queue) post(command)
          setReadyLink(next)
          return
        }
        case 'loaded': {
          const sync = syncRef.current
          if (sync !== null && received.seq === sync.loadSeq) sync.loaded = true
          setShownAt(src)
          return
        }
        case 'patched':
          return
        case 'needsLoad': {
          // 在那以后已经整份重发过的不用再发
          const sync = syncRef.current
          if (sync !== null && received.seq > sync.loadSeq) load(sync.film)
          return
        }
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
        case 'measured': {
          const { seq, layers: watched } = watchRef.current
          if (received.seq !== seq) return
          const items = new Map<number, LayerMeasure>()
          received.items.forEach((item, at) => {
            const layer = watched[at]
            if (item !== null && layer !== undefined) items.set(layer, item)
          })
          on.onMeasured?.(items)
          return
        }
        case 'picked': {
          const answers = answersRef.current.picks
          answers.get(received.seq)?.(received.stack)
          answers.delete(received.seq)
          return
        }
        case 'snapRects': {
          const answers = answersRef.current.snaps
          const { moving, targets } = received
          answers.get(received.seq)?.(moving === null ? null : { moving, targets })
          answers.delete(received.seq)
          return
        }
        case 'drafted': {
          const answers = answersRef.current.drafts
          answers.get(received.seq)?.({ x: received.x, y: received.y })
          answers.delete(received.seq)
          return
        }
        case 'textTarget': {
          const { seq, id, fields } = textRef.current
          if (received.seq !== seq) return
          const field = fields[received.field]
          const { x, y, width, height, fontSize } = received
          on.onTextTarget?.(
            field === undefined ? null : { id, field, rect: { x, y, width, height }, fontSize },
          )
          return
        }
      }
    }
    window.addEventListener('message', receive)
    return () => {
      window.removeEventListener('message', receive)
      outboxRef.current = { target: null, queue: [], seq: 0 }
      syncRef.current = null
      if (bufferingRef.current) reportBuffering(false)
      // 换了预览页：还在等的回答不会来了
      for (const answer of picks.values()) answer([])
      for (const answer of snaps.values()) answer(null)
      for (const answer of drafts.values()) answer(null)
      picks.clear()
      snaps.clear()
      drafts.clear()
    }
  }, [src, origin, post, load, reportBuffering])

  const { rate, muted, loop } = playback
  useEffect(() => {
    if (link !== null) post({ type: 'playback', rate, muted, loop })
  }, [link, rate, muted, loop, post])

  useEffect(() => {
    if (link !== null) post({ type: 'size', width, height })
  }, [link, width, height, post])

  // 层表变了才重发；要量的层跟在它后面发（按表里的位置说）
  const tableKey = layers === undefined ? undefined : JSON.stringify(layers)
  useEffect(() => {
    if (link === null || tableKey === undefined) return
    const entries = JSON.parse(tableKey) as LayerEntry[]
    post({ type: 'layers', entries })
  }, [link, tableKey, post])
  const watchKey = watch?.join(',')
  useEffect(() => {
    if (link === null || watchKey === undefined) return
    const watched = watchKey === '' ? [] : watchKey.split(',').map(Number)
    const seq = watchRef.current.seq + 1
    watchRef.current = { seq, layers: watched }
    post({ type: 'watch', seq, layers: watched })
  }, [link, watchKey, tableKey, post])

  useEffect(() => {
    if (film !== undefined) {
      if (link !== null) show(film)
      return
    }
    if (link !== null) {
      syncRef.current = null
      post({ type: 'unload' })
      return
    }
    // 预览页还没就绪：排着的命令作废，记下的「在放」收回
    outboxRef.current.queue = []
    if (earlyPlayRef.current) playEarly(false)
  }, [link, film, post, show, playEarly])

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
      pick: ({ x, y }) =>
        new Promise((resolve) => {
          const answers = answersRef.current
          const seq = (answers.seq += 1)
          answers.picks.set(seq, resolve)
          post({ type: 'pick', seq, x, y })
        }),
      snapRects: (layers) =>
        new Promise((resolve) => {
          const answers = answersRef.current
          const seq = (answers.seq += 1)
          answers.snaps.set(seq, resolve)
          post({ type: 'snap', seq, layers: [...layers] })
        }),
      draft: (layer, move, styles, pin) =>
        new Promise((resolve) => {
          const answers = answersRef.current
          const seq = (answers.seq += 1)
          answers.drafts.set(seq, resolve)
          post({ type: 'draft', seq, layer, move, styles: { ...styles }, pin })
        }),
      draftEnd: (layer, keep) => post({ type: 'draftEnd', layer, keep }),
      editText: (id, { x, y }, fields) => {
        const seq = textRef.current.seq + 1
        textRef.current = { seq, id, fields }
        post({ type: 'editText', seq, id, x, y, fields: [...fields] })
      },
      endText: (text) => post({ type: 'endText', text }),
    }
    return () => {
      controlRef.current = null
    }
  }, [controllable, controlRef, post, playEarly])

  // 盖在画面上的那一层跟着画面的位置和大小：画面框裁掉超出的部分，这一层放在它外面
  const hostRef = useRef<HTMLDivElement>(null)
  const [hostBox, setHostBox] = useState<Rect | null>(null)
  const overlaid = overlay !== undefined && overlay !== null && film !== undefined
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!overlaid || host === null) return
    // 开始观察时就报一次现在的大小
    const observer = new ResizeObserver(() =>
      setHostBox({
        x: host.offsetLeft,
        y: host.offsetTop,
        width: host.offsetWidth,
        height: host.offsetHeight,
      }),
    )
    observer.observe(host)
    if (host.parentElement !== null) observer.observe(host.parentElement)
    return () => observer.disconnect()
  }, [overlaid])

  const failed = link !== null && clipFailed
  return (
    <div aria-label="预览" className="wf-preview" role="region">
      <StageBackdrop url={film === undefined ? undefined : backdrop} />
      <div className="editor-hero-wrap">
        <div
          className="wf-player-host editor-preview stage-picture"
          data-failed={failed ? '' : undefined}
          hidden={film === undefined}
          ref={hostRef}
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
                title="final-cut 预览"
              />
            )}
          </div>
          {failed ? (
            <div className="editor-preview-message" role="alert">
              <MediaFallback kind="video" onRetry={() => post({ type: 'retry' })} />
            </div>
          ) : null}
        </div>
        {overlaid && hostBox !== null ? (
          <div
            className="wf-canvas-slot"
            style={{
              left: hostBox.x,
              top: hostBox.y,
              width: hostBox.width,
              height: hostBox.height,
            }}
          >
            {overlay}
          </div>
        ) : null}
      </div>
      {children}
      {page.kind === 'failed' ? (
        <div className="wf-preview-alert">
          <InlineAlert action={{ label: '重试', onClick: page.onRetry }} message={page.message} />
        </div>
      ) : film === undefined && message !== undefined ? (
        <p className="wf-preview-note">{message}</p>
      ) : null}
    </div>
  )
}
