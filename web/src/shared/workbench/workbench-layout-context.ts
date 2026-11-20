import { createContext } from 'react'

export interface WorkbenchLayout {
  compact: boolean
  sideBySide: boolean
  collapsed: boolean
  onCollapsedChange: (value: boolean) => void
  onOpen: (reason: 'automatic' | 'explicit') => void
  /** 工作台收起成竖条时竖条里给宿主放页签图标和「+」的元素（见 `WorkbenchRail`）；没收成竖条时是 null。 */
  railSlot: HTMLElement | null
}

export const WorkbenchLayoutContext = createContext<WorkbenchLayout | null>(null)
