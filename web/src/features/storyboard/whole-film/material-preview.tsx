import { useEffect, useEffectEvent, useRef, type RefObject } from 'react'
import { Icon } from '@/shared/icons'
import type { Edge } from '../editing/timeline-drag'
import type { MaterialRange } from './materials'

/**
 * 预览在放素材：点镜头时从选区开头放到出点停下（play），拖选区一端时停在那一端的画面。
 * 每次点镜头都换一个新对象，同一个镜头再点也从头放。
 */
export type MaterialView = {
  range: MaterialRange
  show: 'play' | Edge
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

const seconds = (ms: number) => (ms / 1000).toFixed(1)

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
  const report = useEffectEvent(onTime)
  const playing = useEffectEvent(onPlaying)
  const failed = useEffectEvent(() => onNotice('这段素材播放失败，请稍后重试'))

  useEffect(() => {
    const video = videoRef.current
    if (video === null) return
    const { range, show } = view
    let cancelled = false
    let frame = 0
    const pause = () => {
      cancelAnimationFrame(frame)
      video.pause()
    }
    const tick = () => {
      if (video.paused) return
      const now = Math.round(video.currentTime * 1000)
      if (now >= range.endMs) {
        pause()
        video.currentTime = range.endMs / 1000
        report(range.endMs)
        return
      }
      report(Math.max(range.startMs, now))
      frame = requestAnimationFrame(tick)
    }
    const play = () => {
      // 暂停后续播；已到出点（包括修剪停在末端）则重播选区。
      if (
        video.ended ||
        video.currentTime * 1000 >= range.endMs ||
        video.currentTime * 1000 < range.startMs
      ) {
        video.currentTime = range.startMs / 1000
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
    const at = show === 'end' ? range.endMs : range.startMs
    video.currentTime = at / 1000
    report(at)
    if (show === 'play') play()
    else pause()
    return () => {
      cancelled = true
      pause()
      controlRef.current = null
    }
  }, [view, url, controlRef])

  return (
    <div className="wf-material-preview">
      {/* eslint-disable-next-line jsx-a11y-x/media-has-caption -- 生成的视频没有字幕轨，不装样子 */}
      <video
        className="wf-material-video"
        onPause={() => onPlaying(false)}
        onPlay={() => onPlaying(true)}
        playsInline
        preload="auto"
        ref={videoRef}
        src={url}
      />
      <p className="wf-stage-label">
        <Icon decorative name="video" size="xs" />
        {label}
        <span>
          {seconds(timeMs)} 秒 · 选区 {seconds(view.range.startMs)}–{seconds(view.range.endMs)}
        </span>
      </p>
    </div>
  )
}
