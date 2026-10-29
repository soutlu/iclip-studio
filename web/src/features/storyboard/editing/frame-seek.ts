import type { Edge } from './timeline-drag'

// 媒体正好定在帧边界（镜头分界上的关键帧）时浏览器显示的是前一帧：定位到某一刻时媒体往后多走这么一点，
// 显示这一刻所在的那一帧；停在结尾一端时往前这么一点，显示结尾之前的最后一帧。
const FRAME_OFFSET = 0.001

/**
 * 预览停在某一刻时媒体实际定到的时刻（秒）：开头一端往后 0.001 秒、不超过 max，结尾一端往前 0.001 秒、
 * 不早于 min。只用于媒体定位，对外报的时间仍是 time 本身。
 */
export const framePosition = (time: number, edge: Edge, min: number, max: number): number =>
  edge === 'end' ? Math.max(min, time - FRAME_OFFSET) : Math.min(max, time + FRAME_OFFSET)
