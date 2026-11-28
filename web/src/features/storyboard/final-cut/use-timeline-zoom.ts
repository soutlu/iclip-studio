import { useRef, useState } from 'react'
import type { FilmClip } from './composition/film'
import type { TimelineHandle } from './film-timeline'
import { FIT_ZOOM, timelineScale, zoomScrollLeft, zoomToClips, type Zoom } from './timeline-scale'

/**
 * 时间线的缩放与横向滚动：按可视宽度和工程总长 `total` 算比例尺，工具条缩放时保住播放头（`playheadNow`）
 * 在屏幕上的位置，Z 缩放到选中的片段（`selectedClips`）。`timelineRef` 挂在时间线上。
 */
export function useTimelineZoom(
  total: number,
  playheadNow: () => number,
  selectedClips: readonly FilmClip[],
) {
  const [viewportWidth, setViewportWidth] = useState(0)
  const [zoom, setZoom] = useState<Zoom>(FIT_ZOOM)
  const scale = timelineScale(viewportWidth, total, zoom)
  const timelineRef = useRef<TimelineHandle | null>(null)
  const [scrollRequest, setScrollRequest] = useState<{ left: number } | null>(null)
  // 工具条上的缩放：播放头留在屏幕上原来的地方，看不见它时把它放到中间
  const zoomTo = (next: Zoom) => {
    const left = timelineRef.current?.scrollLeft() ?? 0
    const { pps } = timelineScale(viewportWidth, total, next)
    setZoom(next)
    setScrollRequest({ left: zoomScrollLeft(playheadNow(), left, scale.pps, pps, viewportWidth) })
  }
  const zoomToSelection = () => {
    const target = zoomToClips(selectedClips, viewportWidth, scale.fitPps)
    if (target === null) return
    setZoom(target.zoom)
    setScrollRequest({ left: target.scrollLeft })
  }
  return {
    setViewportWidth,
    zoom,
    scale,
    timelineRef,
    scrollRequest,
    zoomTo,
    zoomToSelection,
  }
}
