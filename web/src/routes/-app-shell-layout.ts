// 数值与 design-system.html 的 --layout-app-* 对齐；拖动热区覆盖边界，不占列宽。
export const SIDEBAR_WIDTH = { default: 264, min: 200, max: 400, collapsed: 56 } as const
export const WORKBENCH_WIDTH = { default: 820, min: 560 } as const
export const CHAT_MIN = 400
export const CONTENT_RAIL_WIDTH = 40
export const COMPACT_MAX = 600
export const APP_RESIZE_HANDLE_WIDTH = 8

export type ResizeInput = 'pointer' | 'keyboard'
export type ContentPane = 'chat' | 'workbench'
export type ContentMode = 'split' | ContentPane
export type ShellLayoutState = {
  sidebarCollapsed: boolean
  sidebarWidth: number
  sidebarClipWidth: number | null
  workbenchWidth: number
  contentClip: { pane: ContentPane; width: number } | null
  firstPane: ContentPane
  /** null 表示尚未选择内容布局，首个自动产物可初始化展开状态。 */
  mode: ContentMode | null
  activePane: ContentPane
}

export const DEFAULT_LAYOUT: ShellLayoutState = {
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_WIDTH.default,
  sidebarClipWidth: null,
  workbenchWidth: WORKBENCH_WIDTH.default,
  contentClip: null,
  firstPane: 'chat',
  mode: null,
  activePane: 'chat',
}

export const clampWidth = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

/** 内容操作在窄屏只切换活动栏，桌面才修改展开偏好。 */
export function selectContentPane(
  state: ShellLayoutState,
  pane: ContentPane,
  mode: ContentMode,
  sideBySide: boolean,
): ShellLayoutState {
  if (!sideBySide) return { ...state, activePane: pane }
  return {
    ...state,
    activePane: pane,
    contentClip: null,
    mode,
  }
}

/** 只派生当前视口的几何，不覆盖用户在更宽视口中选择的展开宽度和排列。 */
export function resolveShellLayout({
  viewport,
  hasWorkbench,
  state,
}: {
  viewport: number
  hasWorkbench: boolean
  state: ShellLayoutState
}) {
  const compact = viewport < COMPACT_MAX
  const expandedSidebar = clampWidth(state.sidebarWidth, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max)
  const sidebarWidth = compact
    ? expandedSidebar
    : state.sidebarCollapsed
      ? SIDEBAR_WIDTH.collapsed
      : (state.sidebarClipWidth ?? expandedSidebar)
  const contentWidth = Math.max(0, viewport - (compact ? 0 : sidebarWidth))
  const fitsSplit = contentWidth >= CHAT_MIN + WORKBENCH_WIDTH.min
  const mode: ContentMode = !hasWorkbench
    ? 'chat'
    : !fitsSplit
      ? state.activePane
      : (state.mode ?? 'chat')
  const sideBySide = hasWorkbench && fitsSplit
  const rail = compact || !hasWorkbench ? 0 : Math.min(CONTENT_RAIL_WIDTH, contentWidth)
  const workbenchMax = Math.max(WORKBENCH_WIDTH.min, contentWidth - CHAT_MIN)
  const workbenchWidth = !hasWorkbench
    ? 0
    : mode === 'split'
      ? state.contentClip?.pane === 'workbench'
        ? state.contentClip.width
        : state.contentClip?.pane === 'chat'
          ? contentWidth - state.contentClip.width
          : clampWidth(state.workbenchWidth, WORKBENCH_WIDTH.min, workbenchMax)
      : mode === 'workbench'
        ? contentWidth - rail
        : rail

  return {
    compact,
    sideBySide,
    mode,
    sidebarWidth,
    contentWidth,
    chatWidth: contentWidth - workbenchWidth,
    workbenchWidth,
    workbenchMax,
  }
}

/** 可见边界连续跟随指针；低于内容最小宽时记录裁切宽度，到轨道宽度才折叠。 */
export function resizeSidebar(
  state: ShellLayoutState,
  rawWidth: number,
  input: ResizeInput = 'pointer',
): ShellLayoutState {
  if (input === 'keyboard' && state.sidebarCollapsed) {
    return rawWidth > SIDEBAR_WIDTH.collapsed
      ? { ...state, sidebarCollapsed: false, sidebarClipWidth: null }
      : state
  }
  const width = clampWidth(rawWidth, SIDEBAR_WIDTH.collapsed, SIDEBAR_WIDTH.max)
  const sidebarCollapsed = width === SIDEBAR_WIDTH.collapsed
  return {
    ...state,
    sidebarCollapsed,
    sidebarClipWidth: !sidebarCollapsed && width < SIDEBAR_WIDTH.min ? width : null,
    sidebarWidth: width >= SIDEBAR_WIDTH.min ? width : state.sidebarWidth,
  }
}

/** 裁切记在被收窄的那一栏上，换位和窗口变化不会改写正常展开宽度。 */
export function resizeContent(
  state: ShellLayoutState,
  rawWorkbenchWidth: number,
  availableWidth: number,
  input: ResizeInput = 'pointer',
): ShellLayoutState {
  if (availableWidth < CHAT_MIN + WORKBENCH_WIDTH.min) return state

  if (input === 'keyboard' && state.mode !== 'split') {
    const expanding =
      state.mode === 'workbench'
        ? rawWorkbenchWidth < availableWidth - CONTENT_RAIL_WIDTH
        : rawWorkbenchWidth > CONTENT_RAIL_WIDTH
    return expanding ? { ...state, mode: 'split', contentClip: null } : state
  }

  const width = clampWidth(
    rawWorkbenchWidth,
    CONTENT_RAIL_WIDTH,
    availableWidth - CONTENT_RAIL_WIDTH,
  )
  const chatWidth = availableWidth - width
  const mode: ContentMode =
    width === CONTENT_RAIL_WIDTH ? 'chat' : chatWidth === CONTENT_RAIL_WIDTH ? 'workbench' : 'split'
  const contentClip: ShellLayoutState['contentClip'] =
    mode !== 'split'
      ? null
      : width < WORKBENCH_WIDTH.min
        ? { pane: 'workbench', width }
        : chatWidth < CHAT_MIN
          ? { pane: 'chat', width: chatWidth }
          : null
  return {
    ...state,
    mode,
    contentClip,
    activePane: mode === 'split' ? state.activePane : mode,
    workbenchWidth: mode === 'split' && contentClip === null ? width : state.workbenchWidth,
  }
}
