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

export type MaterialView = {
  range: MaterialRange
  show: Edge
}

export type MaterialPreviewControl = { toggle: () => void }

type MaterialPreviewProps = {
  controlRef: RefObject<MaterialPreviewControl | null>
  url: string
  view: MaterialView
  label: string
  timeMs: number
  onTime: (ms: number) => void
  onPlaying: (playing: boolean) => void
  onNotice: (message: string) => void
}

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
        {/* eslint-disable-next-line jsx-a11y-x/media-has-caption -- 生成视频无字幕轨 */}
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
