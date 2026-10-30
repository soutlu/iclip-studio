import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { StageBackdrop } from '../components/stage-backdrop'
import { framePosition } from '../editing/frame-seek'
import { StageLabel } from '../editing/stage-label'
import type { Edge } from '../editing/timeline-drag'
import type { MaterialRange } from './materials'

/**
 * 预览切到素材：选中镜头时停在选区开头，拖选区一端时停在那一端的画面，都不播放；按播放或空格才从
 * 选区里放到出点停下。每次选中都换一个新对象，同一个镜头再点也回到开头。
 */
export type MaterialView = {
  range: MaterialRange
  show: Edge
}

export type MaterialPreviewControl = { toggle: () => void }

type MaterialPreviewProps = {
  controlRef: RefObject<MaterialPreviewControl | null>
  url: string
  view: MaterialView
  /** 「素材 · 镜头组 1 · 生成 B · 镜头 2」 */
  label: string
  /** 素材里正放到的时刻（毫秒） */
  timeMs: number
  onTime: (ms: number) => void
  onPlaying: (playing: boolean) => void
  onNotice: (message: string) => void
}

/** 盖在成片预览上的素材画面；回到成片时由编辑器卸掉。 */
export function MaterialPreview({
  controlRef,
  url,
  view,
  label,
  timeMs,
  onTime,
  onPlaying,
  onNotice,
}: MaterialPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [size, setSize] = useState<{ url: string; ratio: number }>()
  const report = useEffectEvent(onTime)
  const playing = useEffectEvent(onPlaying)
  const failed = useEffectEvent(() => onNotice('这段素材播放失败，请稍后重试'))

  useEffect(() => {
    const video = videoRef.current
    if (video === null) return
    const { range, show } = view
    const start = range.startMs / 1000
    const end = range.endMs / 1000
    let cancelled = false
    let frame = 0
    // 停在出点时媒体在出点之前一点，按媒体时刻判断不出已到出点，单独记着。
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
      if (now >= range.endMs) {
        pause()
        seekTo('end')
        report(range.endMs)
        return
      }
      report(Math.max(range.startMs, now))
      frame = requestAnimationFrame(tick)
    }
    const play = () => {
      // 暂停后续播；已到出点（包括修剪停在末端）则重播选区。
      if (
        atEnd ||
        video.ended ||
        video.currentTime * 1000 >= range.endMs ||
        video.currentTime * 1000 < range.startMs
      ) {
        seekTo('start')
      }
      video.play().then(
        () => {
          cancelAnimationFrame(frame)
          if (!cancelled && !video.paused) frame = requestAnimationFrame(tick)
        },
        (error: unknown) => {
          // 加载中暂停或切换素材会中止 play 请求，这是正常操作。
          if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return
          playing(false)
          failed()
        },
      )
    }
    controlRef.current = { toggle: () => (video.paused ? play() : pause()) }
    seekTo(show)
    report(show === 'end' ? range.endMs : range.startMs)
    pause()
    return () => {
      cancelled = true
      pause()
      controlRef.current = null
    }
  }, [view, url, controlRef])

  return (
    <div className="wf-material-preview">
      <StageBackdrop url={videoSnapshotUrl(url, 320)} />
      <div className="editor-hero-wrap">
        {/* eslint-disable-next-line jsx-a11y-x/media-has-caption -- 生成的视频没有字幕轨，不装样子 */}
        <video
          className="wf-material-video editor-preview stage-picture"
          onLoadedMetadata={({ currentTarget: video }) =>
            setSize({ url, ratio: video.videoWidth / video.videoHeight })
          }
          onPause={() => onPlaying(false)}
          onPlay={() => onPlaying(true)}
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
      <StageLabel
        label={label}
        range={{ start: view.range.startMs / 1000, end: view.range.endMs / 1000 }}
        time={timeMs / 1000}
      />
    </div>
  )
}
