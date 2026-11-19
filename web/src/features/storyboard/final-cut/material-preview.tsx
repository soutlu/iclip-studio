import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { MediaBuffering } from '@/shared/ui/media-buffering'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { StageBackdrop } from '../components/stage-backdrop'
import { framePosition } from '../editing/frame-seek'
import type { Edge } from '../editing/timeline-drag'
import type { MediaSpan } from './materials'

/** 素材预览放的是哪一版素材里的哪一段，先停在哪一端。 */
export type MaterialView = {
  jobId: string
  span: MediaSpan
  show: Edge
}

export type MaterialPreviewControl = {
  toggle: () => void
  /** 跳到素材里的这个时间（毫秒），夹在选中的范围里；在播还是停着不变。 */
  seek: (ms: number) => void
}

type MaterialPreviewProps = {
  controlRef: RefObject<MaterialPreviewControl | null>
  url: string
  view: MaterialView
  /** 放的是哪条素材的哪几个镜头：写在左上角的提示块里，也是这块区域的无障碍名称。 */
  label: string
  rate: number
  muted: boolean
  /** 点提示块上的「回到 final-cut」。 */
  onLeave: () => void
  /** 提示挂到哪个元素里；全屏时是全屏的元素，不然是 `null`（挂到 body）。 */
  layer: HTMLElement | null
  onTime: (ms: number) => void
  onPlaying: (playing: boolean) => void
  onNotice: (message: string) => void
}

export function MaterialPreview({
  controlRef,
  url,
  view,
  label,
  rate,
  muted,
  onLeave,
  layer,
  onTime,
  onPlaying,
  onNotice,
}: MaterialPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (video === null) return
    // 换地址重新加载时 playbackRate 会回到 defaultPlaybackRate，两个一起设
    video.defaultPlaybackRate = rate
    video.playbackRate = rate
  }, [rate, url])
  const [size, setSize] = useState<{ url: string; ratio: number }>()
  const [waiting, setWaiting] = useState(false)
  const report = useEffectEvent(onTime)
  const playing = useEffectEvent(onPlaying)
  const failed = useEffectEvent(() => onNotice('素材播放失败，请稍后重试'))

  useEffect(() => {
    const video = videoRef.current
    if (video === null) return
    const { span, show } = view
    const start = span.startMs / 1000
    const end = span.endMs / 1000
    let cancelled = false
    let frame = 0
    let atEnd = false
    const seekTo = (edge: Edge) => {
      atEnd = edge === 'end'
      video.currentTime = framePosition(edge === 'end' ? end : start, edge, start, end)
    }
    const pause = () => {
      cancelAnimationFrame(frame)
      video.pause()
    }
    const tick = () => {
      if (video.paused) return
      const now = Math.round(video.currentTime * 1000)
      if (now >= span.endMs) {
        pause()
        seekTo('end')
        report(span.endMs)
        return
      }
      report(Math.max(span.startMs, now))
      frame = requestAnimationFrame(tick)
    }
    const play = () => {
      if (
        atEnd ||
        video.ended ||
        video.currentTime * 1000 >= span.endMs ||
        video.currentTime * 1000 < span.startMs
      ) {
        seekTo('start')
      }
      video.play().then(
        () => {
          cancelAnimationFrame(frame)
          if (!cancelled && !video.paused) frame = requestAnimationFrame(tick)
        },
        (error: unknown) => {
          if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return
          playing(false)
          failed()
        },
      )
    }
    const seek = (ms: number) => {
      const at = Math.min(span.endMs, Math.max(span.startMs, ms))
      atEnd = at === span.endMs
      video.currentTime = framePosition(at / 1000, atEnd ? 'end' : 'start', start, end)
      report(at)
    }
    controlRef.current = { toggle: () => (video.paused ? play() : pause()), seek }
    seekTo(show)
    report(show === 'end' ? span.endMs : span.startMs)
    pause()
    return () => {
      cancelled = true
      pause()
      controlRef.current = null
    }
  }, [view, url, controlRef])

  return (
    <div aria-label={label} className="wf-material-preview" role="region">
      <StageBackdrop url={videoSnapshotUrl(url, 320)} />
      <div className="editor-hero-wrap">
        {/* eslint-disable-next-line jsx-a11y-x/media-has-caption -- 生成视频无字幕轨 */}
        <video
          className="wf-material-video editor-preview stage-picture"
          muted={muted}
          onLoadedMetadata={({ currentTarget: video }) =>
            setSize({ url, ratio: video.videoWidth / video.videoHeight })
          }
          onCanPlay={() => setWaiting(false)}
          onPause={() => {
            setWaiting(false)
            onPlaying(false)
          }}
          onPlay={() => onPlaying(true)}
          onPlaying={() => setWaiting(false)}
          onWaiting={() => setWaiting(true)}
          playsInline
          preload="auto"
          ref={videoRef}
          src={url}
          style={
            {
              '--preview-ratio': size?.url === url ? size.ratio : 1,
              visibility: size?.url === url ? undefined : 'hidden',
            } as CSSProperties
          }
        />
      </div>
      <div className="wf-source-pill">
        <i aria-hidden="true" className="wf-source-pill-dot" />
        <span className="wf-source-pill-text">{label}</span>
        <TooltipRoot>
          <TooltipTrigger asChild>
            <button
              aria-label="回到 final-cut"
              className="ui-focus"
              onClick={onLeave}
              type="button"
            >
              <Icon decorative name="final-cut-close" size="sm" />
            </button>
          </TooltipTrigger>
          <TooltipContent container={layer} side="bottom">
            回到 final-cut
          </TooltipContent>
        </TooltipRoot>
      </div>
      {waiting ? <MediaBuffering /> : null}
    </div>
  )
}
