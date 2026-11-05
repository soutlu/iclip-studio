import type { Edge } from './timeline-drag'

// 浏览器在帧边界定格时显示前一帧，故跳至帧起点时向后偏移、跳至末尾时向前偏移。
const FRAME_OFFSET = 0.001

export const framePosition = (time: number, edge: Edge, min: number, max: number): number =>
  edge === 'end' ? Math.max(min, time - FRAME_OFFSET) : Math.min(max, time + FRAME_OFFSET)
