/** 应用壳持有面板布局状态；宿主只发出打开与折叠请求。 */

import { createContext } from 'react'

export interface WorkbenchLayout {
  compact: boolean
  sideBySide: boolean
  collapsed: boolean
  onCollapsedChange: (value: boolean) => void
  /** 区分默认自动打开与显式查看；布局偏好由壳裁定，调用方保持引用稳定。 */
  onOpen: (reason: 'automatic' | 'explicit') => void
}

export const WorkbenchLayoutContext = createContext<WorkbenchLayout | null>(null)
