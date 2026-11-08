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

export type Zoom = { mode: ZoomMode; percent: number }

export const FIT_ZOOM: Zoom = { mode: 'fit', percent: 100 }

export const MIN_SPAN_S = 20

export type TimelineScale = {
  pps: number
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

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60]

export const rulerTickStep = (scaleSeconds: number): number =>
  TICK_STEPS.find((step) => step >= scaleSeconds / 8) ?? Math.ceil(scaleSeconds / 8 / 60) * 60

type Span = { id: string; start: number; duration: number }

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

export type Snapped = { ms: number; guideMs: number | null }

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
    Number.POSITIVE_INFINITY,
    gridStepS,
  )
  return {
    ms: Math.round(snapped.start * 1000),
    guideMs: snapped.snapTime === null ? null : Math.round(snapped.snapTime * 1000),
  }
}
