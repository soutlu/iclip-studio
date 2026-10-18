/** 成片区的时间与像素换算、缩放与吸附，都用 Studio 照抄来的算法；进出编辑核心时取整到毫秒。 */

import {
  FIT_ZOOM_HEADROOM,
  getTimelineDisplayContentWidth,
  getTimelineFitPps,
} from './vendor/hyperframes-studio/player/components/timelineLayout'
import {
  collectTimelineSnapTargets,
  snapMoveToTargets,
  snapTimelineTime,
  TIMELINE_SNAP_PX,
  type TimelineSnapTarget,
} from './vendor/hyperframes-studio/player/components/timelineSnapping'
import {
  getNextTimelineZoomPercent,
  getTimelinePixelsPerSecond,
} from './vendor/hyperframes-studio/player/components/timelineZoom'
import type { ZoomMode } from './vendor/hyperframes-studio/player/store/playerStore'
import { MAX_FILM_MS } from './editing/draft'

export type Zoom = { mode: ZoomMode; percent: number }

export const FIT_ZOOM: Zoom = { mode: 'fit', percent: 100 }

/** 适应宽度时刻度至少铺这么多秒：1 秒的成片只占时间区的 1/20 */
export const MIN_SPAN_S = 20

export type TimelineScale = {
  /** 每秒多少像素 */
  pps: number
  fitPps: number
  /** 时间区画多宽（像素），含片尾之后留出的余量 */
  contentWidth: number
}

export const timelineScale = (
  viewportWidth: number,
  totalMs: number,
  zoom: Zoom,
): TimelineScale => {
  // Studio 适应宽度时铺开「时长 × 余量」；短片按 20 秒铺
  const seconds = Math.max(totalMs / 1000, MIN_SPAN_S / FIT_ZOOM_HEADROOM)
  const fitPps = getTimelineFitPps(viewportWidth, seconds, 0)
  const pps = getTimelinePixelsPerSecond(fitPps, zoom.mode, zoom.percent)
  return {
    pps,
    fitPps,
    contentWidth: getTimelineDisplayContentWidth({
      effectiveDuration: seconds,
      viewportWidth,
      contentOrigin: 0,
      pps,
    }),
  }
}

export const nextZoom = (direction: 'in' | 'out', zoom: Zoom, fitPps: number): Zoom => ({
  mode: 'manual',
  percent: getNextTimelineZoomPercent(direction, zoom.mode, zoom.percent, fitPps),
})

export const msToPx = (ms: number, pps: number) => (ms / 1000) * pps

/** 指针移动的像素换成整数毫秒；编辑核心只收整数毫秒 */
export const pxToMs = (px: number, pps: number) => Math.round((px / Math.max(pps, 1)) * 1000)

// 刻度间隔（秒）的取法同 editing/timeline.tsx 的 TimelineRuler：吸附到刻度时要和画出来的刻度一致
const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60]

/** 时间区铺 scaleSeconds 秒时刻度尺上标签的间隔（秒） */
export const rulerTickStep = (scaleSeconds: number): number =>
  TICK_STEPS.find((step) => step >= scaleSeconds / 8) ?? Math.ceil(scaleSeconds / 8 / 60) * 60

type Span = { id: string; start: number; duration: number }

/** 吸附目标：片段边界、播放头、拍点（毫秒进，Studio 的秒出） */
export const snapTargets = ({
  spans,
  playheadMs,
  beatsMs,
}: {
  spans: readonly Span[]
  playheadMs: number | null
  beatsMs: readonly number[]
}): TimelineSnapTarget[] =>
  collectTimelineSnapTargets({
    elements: spans.map((span) => ({
      id: span.id,
      start: span.start / 1000,
      duration: span.duration / 1000,
    })),
    playheadTime: playheadMs === null ? null : playheadMs / 1000,
    beatTimes: beatsMs.map((ms) => ms / 1000),
  })

/** 吸附结果：吸到的时刻，与画吸附线的位置（没吸上时为 null） */
export type Snapped = { ms: number; guideMs: number | null }

/** 把一个时刻吸到附近的目标上（屏幕上 8 像素以内）；没开吸附或附近没有目标时原样返回 */
export const snapMs = (
  ms: number,
  targets: readonly TimelineSnapTarget[],
  pps: number,
  enabled: boolean,
  gridStepS = 0,
): Snapped => {
  if (!enabled) return { ms, guideMs: null }
  const snapped = snapTimelineTime(
    ms / 1000,
    targets,
    TIMELINE_SNAP_PX / Math.max(pps, 1),
    gridStepS,
  )
  if (snapped.target === null) return { ms, guideMs: null }
  const at = Math.round(snapped.time * 1000)
  return { ms: at, guideMs: at }
}

/**
 * 挪动一段时长不变的块：开头、结尾里离目标近的那一端吸上（同 Studio 的 snapMoveToTargets）；
 * 两端都没有目标时才吸刻度。返回的是块的开始时间。
 */
export const snapSpanStartMs = (
  startMs: number,
  durationMs: number,
  targets: readonly TimelineSnapTarget[],
  pps: number,
  enabled: boolean,
  gridStepS: number,
): Snapped => {
  if (!enabled) return { ms: startMs, guideMs: null }
  const snapped = snapMoveToTargets(
    startMs / 1000,
    durationMs / 1000,
    targets,
    pps,
    MAX_FILM_MS / 1000,
    gridStepS,
  )
  return {
    ms: Math.round(snapped.start * 1000),
    guideMs: snapped.snapTime === null ? null : Math.round(snapped.snapTime * 1000),
  }
}
