import { createContext } from 'react'

export interface WorkbenchOpenRequest {
  requestOpen: () => void
  openToken: number
}

export const WorkbenchOpenRequestContext = createContext<WorkbenchOpenRequest | null>(null)
