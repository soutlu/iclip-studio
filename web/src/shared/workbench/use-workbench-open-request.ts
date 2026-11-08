import { use } from 'react'
import type { WorkbenchOpenRequest } from './workbench-open-request-context'
import { WorkbenchOpenRequestContext } from './workbench-open-request-context'

export const useWorkbenchOpenRequest = (): WorkbenchOpenRequest => {
  const openRequest = use(WorkbenchOpenRequestContext)
  if (openRequest === null) {
    throw new Error('useWorkbenchOpenRequest 要在 WorkbenchOpenRequestProvider 里用')
  }
  return openRequest
}
