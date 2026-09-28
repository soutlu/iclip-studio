import { useCallback, useRef, useState } from 'react'
import { z } from 'zod'
import {
  DEFAULT_LAYOUT,
  CHAT_MIN,
  CONTENT_RAIL_WIDTH,
  SIDEBAR_WIDTH,
  WORKBENCH_WIDTH,
  type ShellLayoutState,
} from './-app-shell-layout'

const STORAGE_KEY = 'cue.layout.panes'
const pane = z.enum(['chat', 'workbench'])
const layoutSchema = z.object({
  sidebarCollapsed: z.boolean(),
  sidebarWidth: z.number().min(SIDEBAR_WIDTH.min).max(SIDEBAR_WIDTH.max),
  sidebarClipWidth: z.number().gt(SIDEBAR_WIDTH.collapsed).lt(SIDEBAR_WIDTH.min).nullable(),
  contentClip: z
    .discriminatedUnion('pane', [
      z.object({ pane: z.literal('chat'), width: z.number().gt(CONTENT_RAIL_WIDTH).lt(CHAT_MIN) }),
      z.object({
        pane: z.literal('workbench'),
        width: z.number().gt(CONTENT_RAIL_WIDTH).lt(WORKBENCH_WIDTH.min),
      }),
    ])
    .nullable(),
  workbenchWidth: z.number().min(WORKBENCH_WIDTH.min),
  firstPane: pane,
  mode: z.enum(['split', 'chat', 'workbench']).nullable(),
  activePane: pane,
})

const read = (): ShellLayoutState => {
  const fallback = { ...DEFAULT_LAYOUT }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === null) return fallback
    const parsed = layoutSchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

const write = (state: ShellLayoutState): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 浏览器禁用站点存储时，布局偏好仍在当前会话生效。
  }
}

/** 拖动中可暂缓持久化；同步 ref 确保同一事件中的 persist 读取最终宽度。 */
export function useShellLayout() {
  const [state, setState] = useState(read)
  const latestRef = useRef(state)
  const update = useCallback(
    (updater: (current: ShellLayoutState) => ShellLayoutState, persist = true) => {
      const next = updater(latestRef.current)
      latestRef.current = next
      setState(next)
      if (persist) write(next)
    },
    [],
  )
  const persist = useCallback(() => write(latestRef.current), [])
  return { state, update, persist }
}
