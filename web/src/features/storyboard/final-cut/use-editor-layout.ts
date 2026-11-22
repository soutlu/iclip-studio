import { useCallback, useRef, useState } from 'react'
import { z } from 'zod'
import type { ResizeInput } from '@/shared/ui/resize-handle'
import { readStoredJson, writeStored } from '../editing/browser-storage'

// 这几个数和 final-cut.css「外框」一节里 .wf-workspace 的夹值一致，改了两边一起改
/** 右栏宽度（px）：默认、拖动能到的最窄和最宽。 */
export const SIDE_WIDTH = { default: 432, min: 150, max: 580 } as const
/** 拖右栏时按指针算出的宽度不到这么宽（px）就收成竖轨：比最窄 150 再往外拖出一截才收。 */
const SIDE_COLLAPSE_BELOW = 92
/** 时间线最矮多高（px）：工具条加两行轨道。 */
export const TIMELINE_MIN_HEIGHT = 186
/** 拖右栏、时间线时左上的预览舞台至少留多宽、多高（px）：宽度够播放条排开一行。 */
const STAGE_MIN = { width: 360, height: 200 } as const

const STORAGE_KEY = 'cue.layout.final-cut'

const layoutSchema = z.object({
  sideWidth: z.number().min(SIDE_WIDTH.min).max(SIDE_WIDTH.max),
  sideCollapsed: z.boolean(),
  timelineHeight: z.number().min(TIMELINE_MIN_HEIGHT).nullable(),
})

/**
 * final-cut 编辑器的摆法：右栏宽度、右栏是不是收成图标轨、时间线高度（`null` 是没拖过，按内容高、最多占一小半）。
 * 照工作台、对话宽度的做法跨刷新记住，拖动中途不写，松手才写。
 */
type EditorLayout = z.infer<typeof layoutSchema>

const DEFAULT_LAYOUT: EditorLayout = {
  sideWidth: SIDE_WIDTH.default,
  sideCollapsed: false,
  timelineHeight: null,
}

// 浏览器禁用或写满 Web Storage 时只是记不住，摆法照常用
const write = (layout: EditorLayout) => void writeStored(STORAGE_KEY, layout)

/**
 * 一条分隔条的回调，见 `LayoutSplitter`：`delta` 是从按下起指针沿着拖动方向走了多少像素，
 * 方向键是一下挪的像素（`input` 为 `keyboard`）。
 */
export type SplitterHandlers = {
  onStart: () => void
  onMove: (delta: number, input: ResizeInput) => void
  onEnd: () => void
  onCancel: () => void
  onReset: () => void
}

/** 拖动时量尺寸要用的三块：左上的预览舞台、右栏、时间线面板。 */
type LayoutParts = {
  stage: HTMLElement | null
  side: HTMLElement | null
  timeline: HTMLElement | null
}

type Axis = 'side' | 'timeline'

/** 一次拖动：按下前的摆法，按下时那一块的实际尺寸（右栏收着时是竖轨的宽），最大能拉到多大。 */
type Drag = { axis: Axis; before: EditorLayout; size: number; max: number }

const boxOf = (element: HTMLElement | null) =>
  element?.getBoundingClientRect() ?? { width: 0, height: 0 }

/** 按下分隔条时那一块的实际尺寸，和最大能拉到多大（预览舞台至少留 `STAGE_MIN`）。 */
const measure = (axis: Axis, { stage, side, timeline }: LayoutParts) => {
  if (axis === 'side') {
    const size = boxOf(side).width
    // 舞台已经不足 360 时也不比按下时窄，不然一拖右栏就缩一截
    const room = Math.min(SIDE_WIDTH.max, size + boxOf(stage).width - STAGE_MIN.width)
    return { size, max: Math.max(size, room) }
  }
  const size = boxOf(timeline).height
  return { size, max: size + boxOf(stage).height - STAGE_MIN.height }
}

/**
 * 拖右栏分隔条以后的摆法。指针拖到比 `SIDE_COLLAPSE_BELOW` 还窄收成竖轨，记着的宽度留按下前的，
 * 同一次拖回来又展开；方向键不收起，收着时往左一下展开到记着的宽度。
 */
const sideDragged = (
  layout: EditorLayout,
  drag: Drag,
  delta: number,
  input: ResizeInput,
): EditorLayout => {
  if (input === 'keyboard' && layout.sideCollapsed)
    return delta < 0 ? { ...layout, sideCollapsed: false } : layout
  const width = drag.size - delta
  if (input === 'pointer' && width < SIDE_COLLAPSE_BELOW)
    return { ...layout, sideCollapsed: true, sideWidth: drag.before.sideWidth }
  return {
    ...layout,
    sideCollapsed: false,
    sideWidth: Math.round(Math.max(SIDE_WIDTH.min, Math.min(width, drag.max))),
  }
}

/**
 * 编辑器的摆法和改它的两条分隔条。拖动从按下时量出的实际尺寸起算（窄窗口里样式会把记着的宽度压小），
 * `parts` 在按下分隔条时才读。右栏在右边、时间线在下面：往左、往上拖是变大。
 */
export function useEditorLayout(parts: () => LayoutParts) {
  const [layout, setLayout] = useState(
    () => readStoredJson(STORAGE_KEY, layoutSchema) ?? DEFAULT_LAYOUT,
  )
  const latestRef = useRef(layout)
  const dragRef = useRef<Drag | null>(null)
  const update = useCallback((next: EditorLayout, persist: boolean) => {
    latestRef.current = next
    setLayout(next)
    if (persist) write(next)
  }, [])

  const start = (axis: Axis) => {
    dragRef.current = { axis, before: latestRef.current, ...measure(axis, parts()) }
  }
  const move = (delta: number, input: ResizeInput) => {
    const drag = dragRef.current
    if (drag === null) return
    const current = latestRef.current
    if (drag.axis === 'side') {
      update(sideDragged(current, drag, delta, input), false)
      return
    }
    // 舞台已经挤到最矮时也不比最矮还小
    const height = Math.max(TIMELINE_MIN_HEIGHT, Math.min(drag.size - delta, drag.max))
    update({ ...current, timelineHeight: Math.round(height) }, false)
  }
  const end = () => {
    dragRef.current = null
    write(latestRef.current)
  }
  const cancel = () => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag !== null) update(drag.before, false)
  }
  const reset = (axis: Axis) =>
    update(
      axis === 'side'
        ? { ...latestRef.current, sideWidth: SIDE_WIDTH.default, sideCollapsed: false }
        : { ...latestRef.current, timelineHeight: null },
      true,
    )

  return {
    layout,
    setSideCollapsed: (sideCollapsed: boolean) => {
      if (latestRef.current.sideCollapsed !== sideCollapsed)
        update({ ...latestRef.current, sideCollapsed }, true)
    },
    sideSplitter: {
      onStart: () => start('side'),
      onMove: move,
      onEnd: end,
      onCancel: cancel,
      onReset: () => reset('side'),
    } satisfies SplitterHandlers,
    timelineSplitter: {
      onStart: () => start('timeline'),
      onMove: move,
      onEnd: end,
      onCancel: cancel,
      onReset: () => reset('timeline'),
    } satisfies SplitterHandlers,
  }
}
