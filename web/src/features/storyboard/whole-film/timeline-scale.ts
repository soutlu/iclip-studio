/** 成片区的时间与像素换算、缩放与吸附，都用 Studio 照抄来的算法；进出编辑核心时取整到毫秒。 */

import {
  getTimelineDisplayContentWidth,
  getTimelineFitPps,
} from './vendor/hyperframes-studio/player/components/timelineLayout'
import {
  collectTimelineSnapTargets,
  snapTimelineTime,
  TIMELINE_SNAP_PX,
  type TimelineSnapTarget,
} from './vendor/hyperframes-studio/player/components/timelineSnapping'
import {
  getNextTimelineZoomPercent,
  getTimelinePixelsPerSecond,
} from './vendor/hyperframes-studio/player/components/timelineZoom'
import type { ZoomMode } from './vendor/hyperframes-studio/player/store/playerStore'

export type Zoom = { mode: ZoomMode; percent: number }

export const FIT_ZOOM: Zoom = { mode: 'fit', percent: 100 }

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
  const seconds = totalMs / 1000
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

/** 把一个时刻吸到附近的目标上（屏幕上 8 像素以内）；没开吸附或附近没有目标时原样返回 */
export const snapMs = (
  ms: number,
  targets: readonly TimelineSnapTarget[],
  pps: number,
  enabled: boolean,
): number => {
  if (!enabled) return ms
  const snapped = snapTimelineTime(ms / 1000, targets, TIMELINE_SNAP_PX / Math.max(pps, 1))
  return snapped.target === null ? ms : Math.round(snapped.time * 1000)
}
