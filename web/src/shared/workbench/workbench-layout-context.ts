import { createContext } from 'react'

export interface WorkbenchLayout {
  compact: boolean
  sideBySide: boolean
  collapsed: boolean
  onCollapsedChange: (value: boolean) => void
  onOpen: (reason: 'automatic' | 'explicit') => void
}

export const WorkbenchLayoutContext = createContext<WorkbenchLayout | null>(null)
