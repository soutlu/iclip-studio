import { useCallback, useRef, useState } from 'react'
import { z } from 'zod'
import { readStoredJson, writeStored } from '../editing/browser-storage'

// 这几个数和 final-cut.css「外框」一节里 .wf-workspace 的夹值一致，改了两边一起改
/** 右栏宽度（px）：默认、拖动能到的最窄和最宽。 */
export const SIDE_WIDTH = { default: 432, min: 376, max: 520 } as const
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

/** 一条分隔条的回调，见 `LayoutSplitter`：`delta` 是从按下起指针沿着拖动方向走了多少像素。 */
export type SplitterHandlers = {
  onStart: () => void
  onMove: (delta: number) => void
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

const MIN_SIZE: Record<Axis, number> = { side: SIDE_WIDTH.min, timeline: TIMELINE_MIN_HEIGHT }

const boxOf = (element: HTMLElement | null) =>
  element?.getBoundingClientRect() ?? { width: 0, height: 0 }

/** 按下分隔条时那一块的实际尺寸，和最大能拉到多大（预览舞台至少留 `STAGE_MIN`）。 */
const measure = (axis: Axis, { stage, side, timeline }: LayoutParts) => {
  if (axis === 'side') {
    const size = boxOf(side).width
    return { size, max: Math.min(SIDE_WIDTH.max, size + boxOf(stage).width - STAGE_MIN.width) }
  }
  const size = boxOf(timeline).height
  return { size, max: size + boxOf(stage).height - STAGE_MIN.height }
}

const resized = (layout: EditorLayout, axis: Axis, size: number | null): EditorLayout =>
  axis === 'side'
    ? { ...layout, sideWidth: size ?? SIDE_WIDTH.default }
    : { ...layout, timelineHeight: size }

/**
 * 编辑器的摆法和改它的两条分隔条。拖动从按下时量出的实际尺寸起算（窄窗口里样式会把记着的宽度压小），
 * `parts` 在按下分隔条时才读。右栏在右边、时间线在下面：往左、往上拖是变大。
 */
export function useEditorLayout(parts: () => LayoutParts) {
  const [layout, setLayout] = useState(
    () => readStoredJson(STORAGE_KEY, layoutSchema) ?? DEFAULT_LAYOUT,
  )
  const latestRef = useRef(layout)
  const dragRef = useRef<{ axis: Axis; before: EditorLayout; size: number; max: number } | null>(
    null,
  )
  const update = useCallback((next: EditorLayout, persist: boolean) => {
    latestRef.current = next
    setLayout(next)
    if (persist) write(next)
  }, [])

  const start = (axis: Axis) => {
    dragRef.current = { axis, before: latestRef.current, ...measure(axis, parts()) }
  }
  const move = (delta: number) => {
    const drag = dragRef.current
    if (drag === null) return
    // 舞台已经挤到最小时也不比最窄、最矮还小
    const size = Math.max(MIN_SIZE[drag.axis], Math.min(drag.size - delta, drag.max))
    update(resized(latestRef.current, drag.axis, Math.round(size)), false)
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
  const reset = (axis: Axis) => update(resized(latestRef.current, axis, null), true)

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
