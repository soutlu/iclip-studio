import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { WorkbenchOpenRequestContext } from './workbench-open-request-context'

export function WorkbenchOpenRequestProvider({ children }: { children: ReactNode }) {
  const [openToken, setOpenToken] = useState(0)
  const requestOpen = useCallback(() => setOpenToken((current) => current + 1), [])
  const value = useMemo(() => ({ openToken, requestOpen }), [openToken, requestOpen])

  return <WorkbenchOpenRequestContext value={value}>{children}</WorkbenchOpenRequestContext>
}
