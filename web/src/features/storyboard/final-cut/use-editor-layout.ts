import { useCallback, useRef, useState } from 'react'
import { z } from 'zod'
import type { ResizeInput } from '@/shared/ui/resize-handle'
import { readStoredJson, writeStored } from '../editing/browser-storage'

// 下列数值与 final-cut.css「外框」一节中 .wf-workspace 的钳制范围一致，调整时须同步修改
/** 右栏宽度（px）：默认值及拖拽上下限。 */
export const SIDE_WIDTH = { default: 432, min: 150, max: 580 } as const
/** 拖拽右栏至指针计算宽度低于此阈值（px）时自动收起为竖向图标轨（须在最窄宽度 150px 基础上继续向外拖出一段距离）。 */
const SIDE_COLLAPSE_BELOW = 92
/** 时间线最小高度（px）：满足工具条加两行轨道的展示空间。 */
export const TIMELINE_MIN_HEIGHT = 186
/** 拖拽调节右栏或时间线时，左上方预览舞台保留的最小宽高（px），确保播放控制条单行完整排布。 */
const STAGE_MIN = { width: 360, height: 200 } as const

const STORAGE_KEY = 'cue.layout.final-cut'

const layoutSchema = z.object({
  sideWidth: z.number().min(SIDE_WIDTH.min).max(SIDE_WIDTH.max),
  sideCollapsed: z.boolean(),
  timelineHeight: z.number().min(TIMELINE_MIN_HEIGHT).nullable(),
})

/**
 * final-cut 编辑器面板布局状态：右栏宽度、右栏是否收起为竖向图标轨、时间线高度（`null` 表示未手动调整，按内容自适应且不超过上限）。
 * 跨刷新持久化至浏览器本地存储；拖拽过程中仅更新内存态，松手后落盘。
 */
type EditorLayout = z.infer<typeof layoutSchema>

const DEFAULT_LAYOUT: EditorLayout = {
  sideWidth: SIDE_WIDTH.default,
  sideCollapsed: false,
  timelineHeight: null,
}

// 浏览器禁用或写满 Web Storage 时仅本次会话生效，不影响布局调整
const write = (layout: EditorLayout) => void writeStored(STORAGE_KEY, layout)

/**
 * 分隔条交互回调集合（见 `LayoutSplitter`）：指针拖拽时 `delta` 为自按下起的累计位移像素，
 * 键盘方向键（`input === 'keyboard'`）为单步位移像素。
 */
export type SplitterHandlers = {
  onStart: () => void
  onMove: (delta: number, input: ResizeInput) => void
  onEnd: () => void
  onCancel: () => void
  onReset: () => void
}

/** 拖拽测距所需的三个核心面板节点：预览舞台、右栏与时间线。 */
type LayoutParts = {
  stage: HTMLElement | null
  side: HTMLElement | null
  timeline: HTMLElement | null
}

type Axis = 'side' | 'timeline'

/** 单次拖拽会话快照：起拖前布局、目标面板起拖实测尺寸（右栏收起态取竖轨宽度）及允许拉伸上限。 */
type Drag = { axis: Axis; before: EditorLayout; size: number; max: number }

const boxOf = (element: HTMLElement | null) =>
  element?.getBoundingClientRect() ?? { width: 0, height: 0 }

/** 测量起拖时目标面板的实际尺寸与可拉伸上限（保证预览舞台不小于 `STAGE_MIN`）。 */
const measure = (axis: Axis, { stage, side, timeline }: LayoutParts) => {
  if (axis === 'side') {
    const size = boxOf(side).width
    // 舞台当前宽度已不足 360px 时，上限不低于起拖实测宽度，避免一触拖拽即导致右栏骤缩
    const room = Math.min(SIDE_WIDTH.max, size + boxOf(stage).width - STAGE_MIN.width)
    return { size, max: Math.max(size, room) }
  }
  const size = boxOf(timeline).height
  return { size, max: size + boxOf(stage).height - STAGE_MIN.height }
}

/**
 * 计算拖拽右栏分隔条后的目标布局：指针拖至窄于 `SIDE_COLLAPSE_BELOW` 时收起为竖轨并保留起拖前的记忆宽度，
 * 同一次拖拽拉回阈值以上时重新展开；键盘方向键不触发收起，收起态下向左按键直接恢复记忆宽度。
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
 * 管理编辑器三区布局状态与两条分隔条交互：拖拽以起拖实测尺寸为基准（适配窄视口下样式压缩后的实际尺寸），
 * `parts` 在起拖瞬间惰性读取。右栏居右、时间线居下，向左或向上拖拽为增大尺寸。
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
    // 舞台当前高度已达下限时，时间线高度仍不低于最小高度约束
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
