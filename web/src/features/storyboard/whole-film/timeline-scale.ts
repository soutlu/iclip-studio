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
  getTimelineZoomPercent,
  TIMELINE_RANGE_MARGIN_PX,
  timelineSliderToZoomPercent,
  timelineZoomPercentToSlider,
  zoomToSelectedClips,
} from './vendor/hyperframes-studio/player/components/timelineZoom'
import type { ZoomMode } from './vendor/hyperframes-studio/player/store/playerStore'

export type Zoom = { mode: ZoomMode; percent: number }

export const FIT_ZOOM: Zoom = { mode: 'fit', percent: 100 }

// 成片再短，时间线也按这么多秒排，片段不会被拉得很宽
const MIN_SPAN_S = 20

export type TimelineScale = {
  /** 一秒画多少像素。 */
  pps: number
  /** 「适应宽度」时一秒画多少像素。 */
  fitPps: number
  contentWidth: number
  /** 时间区里一屏看得见多长的时间（秒）；时间尺按它定隔多久画一个刻度，放大以后刻度跟着变密。 */
  viewSeconds: number
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
    // 还没量到宽度时先按整条算
    viewSeconds: viewportWidth > 0 && pps > 0 ? viewportWidth / pps : seconds,
  }
}

export const nextZoom = (direction: 'in' | 'out', zoom: Zoom, fitPps: number): Zoom => ({
  mode: 'manual',
  percent: getNextTimelineZoomPercent(direction, zoom.mode, zoom.percent, fitPps),
})

/** 现在的缩放在滑杆上的位置（0–100）。滑杆按对数走，小的那一头不会挤成一小截。 */
export const zoomToSlider = (zoom: Zoom, fitPps: number): number =>
  timelineZoomPercentToSlider(getTimelineZoomPercent(zoom.mode, zoom.percent, fitPps), fitPps)

export const sliderToZoom = (slider: number, fitPps: number): Zoom => ({
  mode: 'manual',
  percent: timelineSliderToZoomPercent(slider, fitPps),
})

/**
 * 缩放到这几个片段：它们合起来的那一段两边各留 24 像素，正好铺满能排时间的宽度（`viewportWidth`）。
 * `scrollLeft` 是时间线要横向滚到的位置，让这一段的起点离时间区左边 24 像素。
 * 没有长度大于 0 的片段、或者还没量出宽度时是 null。
 */
export const zoomToBlocks = (
  blocks: readonly Pick<Span, 'start' | 'duration'>[],
  viewportWidth: number,
  fitPps: number,
): { zoom: Zoom; scrollLeft: number } | null => {
  const fitted = zoomToSelectedClips({
    clips: blocks.map((block) => ({
      start: block.start / 1000,
      end: (block.start + block.duration) / 1000,
    })),
    viewportWidth,
    contentOrigin: 0,
    fitPixelsPerSecond: fitPps,
  })
  if (fitted === null) return null
  const pps = getTimelinePixelsPerSecond(fitPps, 'manual', fitted.zoomPercent)
  return {
    zoom: { mode: 'manual', percent: fitted.zoomPercent },
    scrollLeft: Math.max(0, fitted.start * pps - TIMELINE_RANGE_MARGIN_PX),
  }
}

/**
 * 缩放以后时间线要横向滚到的位置：播放头原来看得见，就让它留在屏幕上原来的地方；
 * 看不见，就把它放到时间区中间。`viewportWidth` 是能排时间的宽度，`scrollLeft` 是缩放前滚到的位置。
 */
export const zoomScrollLeft = (
  playheadMs: number,
  scrollLeft: number,
  fromPps: number,
  toPps: number,
  viewportWidth: number,
): number => {
  const shownAt = msToPx(playheadMs, fromPps) - scrollLeft
  const keptAt = shownAt >= 0 && shownAt <= viewportWidth ? shownAt : viewportWidth / 2
  return Math.max(0, msToPx(playheadMs, toPps) - keptAt)
}

/** 工具条上写的缩放：适应宽度时写「适应」，否则是相对适应宽度的百分比。 */
export const zoomLabel = (zoom: Zoom, fitPps: number): string =>
  zoom.mode === 'fit' ? '适应' : `${getTimelineZoomPercent(zoom.mode, zoom.percent, fitPps)}%`

export const msToPx = (ms: number, pps: number) => (ms / 1000) * pps

export const pxToMs = (px: number, pps: number) => Math.round((px / Math.max(pps, 1)) * 1000)

type Span = { id: string; start: number; duration: number }

export type SnapTargets = readonly TimelineSnapTarget[]

/** 能吸上去的时间点：别的片段的两端和播放头。`spans` 里不要带正在拖的那个片段。 */
export const snapTargets = (spans: readonly Span[], playheadMs: number): SnapTargets =>
  collectTimelineSnapTargets({
    elements: spans.map((span) => ({
      id: span.id,
      start: span.start / 1000,
      duration: span.duration / 1000,
    })),
    playheadTime: playheadMs / 1000,
    beatTimes: [],
  })

/** 吸附之后的时间；`guideMs` 是吸上去的那个点，没吸上是 null。 */
export type Snapped = { ms: number; guideMs: number | null }

/** 一个时间点（比如裁剪时的一端）离某个点够近就吸上去。 */
export const snapMs = (ms: number, targets: SnapTargets, pps: number): Snapped => {
  const snapped = snapTimelineTime(ms / 1000, targets, TIMELINE_SNAP_PX / Math.max(pps, 1))
  if (snapped.target === null) return { ms, guideMs: null }
  const at = Math.round(snapped.time * 1000)
  return { ms: at, guideMs: at }
}

/** 挪一个片段时，它的开头或结尾哪一端离某个点近就让那一端吸上去；返回的是片段的开头。 */
export const snapSpanStartMs = (
  startMs: number,
  durationMs: number,
  targets: SnapTargets,
  pps: number,
): Snapped => {
  const snapped = snapMoveToTargets(
    startMs / 1000,
    durationMs / 1000,
    targets,
    pps,
    Number.POSITIVE_INFINITY,
  )
  return {
    ms: Math.round(snapped.start * 1000),
    guideMs: snapped.snapTime === null ? null : Math.round(snapped.snapTime * 1000),
  }
}
