import { useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react'
import type { TimeSpan } from '@/shared/lib/time-spans'
import { createPlayheadClock } from './playhead-clock'
import type { PlaybackSettings, PreviewControl } from './preview-player'
import type { useMaterials } from './use-materials'
import type { FilmView } from './use-film-session'

// 播放期间 state 层的播放头节流同步间隔：兼顾依赖播放头的常规功能与性能，避免整个编辑器逐帧重绘
const PLAYING_COMMIT_MS = 100

/**
 * final-cut 预览的播放头与播放：跟随预览页报来的时刻和播放态，跳转、播放暂停、静音、循环与倍速。
 * 素材预览显示着时播放暂停切到素材（`materials`）；工作台折叠（`collapsed`）时停下正在播的预览和素材。
 */
export function usePreviewPlayback({
  film,
  previewRef,
  materials,
  collapsed,
}: {
  film: FilmView | null
  previewRef: RefObject<PreviewControl | null>
  materials: ReturnType<typeof useMaterials>
  collapsed: boolean
}) {
  const { materialView, materialPlaying, materialPreviewRef, leaveMaterial } = materials
  // 播放头单一数据源：`clock` 实时跟随每帧时刻，供时间线播放头竖线、播放条读数与进度条独立订阅；
  // `playheadMs` 供其余依赖播放头的组件使用，播放期间以 `PLAYING_COMMIT_MS` 节流同步以避免整页逐帧重绘，停播时立即对齐时钟末值
  const [clock] = useState(createPlayheadClock)
  const [playheadMs, setPlayheadMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  // 预览事件按到达顺序同步处理，通过 ref 读取最新播放态，不等待 React 重渲染
  const playingRef = useRef(false)
  const committedAtRef = useRef(Number.NEGATIVE_INFINITY)
  const followPreviewTime = (ms: number) => {
    clock.set(ms)
    const now = performance.now()
    if (playingRef.current && now - committedAtRef.current < PLAYING_COMMIT_MS) return
    committedAtRef.current = now
    setPlayheadMs(ms)
  }
  const followPlaying = (next: boolean) => {
    playingRef.current = next
    setPlaying(next)
    if (!next) setPlayheadMs(clock.get())
  }
  const [buffering, setBuffering] = useState(false)
  const [buffered, setBuffered] = useState<readonly TimeSpan[]>([])
  const [playback, setPlayback] = useState<PlaybackSettings>({ rate: 1, muted: false, loop: false })
  const toggleMute = () => setPlayback((current) => ({ ...current, muted: !current.muted }))
  const toggleLoop = () => setPlayback((current) => ({ ...current, loop: !current.loop }))
  // 工作台折叠起来时编辑器还挂着，正在播的 final-cut 和素材不会自己停：停下，免得看不见还听得见
  const stopPlaying = useEffectEvent(() => {
    previewRef.current?.pause()
    if (materialPlaying) materialPreviewRef.current?.toggle()
  })
  useEffect(() => {
    if (collapsed) stopPlaying()
  }, [collapsed])

  const total = film?.durationMs ?? 0
  const playhead = Math.min(playheadMs, total)
  // 取操作瞬间播放头竖线的精确时刻：播放期间 state 层的 `playhead` 最多滞后约 0.1 秒，直接使用会导致落点偏左
  const playheadNow = () => Math.min(clock.get(), total)
  const frameMs = Math.min(playhead, Math.max(0, total - 1))
  const seek = (ms: number) => {
    leaveMaterial()
    clock.set(ms)
    setPlayheadMs(ms)
    previewRef.current?.seek(ms)
  }
  /** 点选时间线片段后将播放头定位至其内部：属于常规跳转，播放期间跳转后继续播放。 */
  const jumpInto = (ms: number) => {
    const resume = playing
    seek(ms)
    if (resume) previewRef.current?.play()
  }
  const togglePlay = () => {
    if (materialView !== null) {
      materialPreviewRef.current?.toggle()
      return
    }
    if (playing) previewRef.current?.pause()
    else previewRef.current?.play()
  }

  return {
    clock,
    playing,
    followPreviewTime,
    followPlaying,
    buffering,
    setBuffering,
    buffered,
    setBuffered,
    playback,
    setPlayback,
    toggleMute,
    toggleLoop,
    total,
    playhead,
    playheadNow,
    frameMs,
    seek,
    jumpInto,
    togglePlay,
  }
}
