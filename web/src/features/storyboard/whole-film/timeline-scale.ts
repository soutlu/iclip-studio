import {
  FIT_ZOOM_HEADROOM,
  getTimelineDisplayContentWidth,
  getTimelineFitPps,
} from './vendor/hyperframes-studio/player/components/timelineLayout'
import {
  getNextTimelineZoomPercent,
  getTimelinePixelsPerSecond,
} from './vendor/hyperframes-studio/player/components/timelineZoom'
import type { ZoomMode } from './vendor/hyperframes-studio/player/store/playerStore'

export type Zoom = { mode: ZoomMode; percent: number }

export const FIT_ZOOM: Zoom = { mode: 'fit', percent: 100 }

// 成片再短，时间线也按这么多秒排，块不会被拉得很宽
const MIN_SPAN_S = 20

export type TimelineScale = {
  /** 一秒画多少像素。 */
  pps: number
  /** 「适应宽度」时一秒画多少像素。 */
  fitPps: number
  contentWidth: number
}

export const timelineScale = (
  viewportWidth: number,
  totalMs: number,
  zoom: Zoom,
): TimelineScale => {
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

export const pxToMs = (px: number, pps: number) => Math.round((px / Math.max(pps, 1)) * 1000)
