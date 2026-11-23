import { createContext } from 'react'

export interface WorkbenchLayout {
  compact: boolean
  sideBySide: boolean
  collapsed: boolean
  onCollapsedChange: (value: boolean) => void
  onOpen: (reason: 'automatic' | 'explicit') => void
  /** 工作台收起为竖轨时供宿主渲染页签图标与新建按钮的插槽元素（见 `WorkbenchRail`）；展开态为 `null`。 */
  railSlot: HTMLElement | null
}

export const WorkbenchLayoutContext = createContext<WorkbenchLayout | null>(null)
