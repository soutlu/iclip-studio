import { use, useEffect, useSyncExternalStore } from 'react'
import { MAIN_AGENT_ID } from './connection'
import { TranscriptPoolsContext } from './transcript-context'
import { NO_SESSION_VIEW, type TranscriptView } from './view'

export type { TranscriptView } from './view'

const noop = () => {}

export const useTranscript = (
  conversationId: string | null,
  agentId: string = MAIN_AGENT_ID,
): { view: TranscriptView; refresh: () => void; loadOlder: () => Promise<void> } => {
  const pools = use(TranscriptPoolsContext)
  if (pools === null) throw new Error('useTranscript 要在 TranscriptProvider 里用')
  const main = agentId === MAIN_AGENT_ID

  useEffect(() => {
    if (conversationId === null) return undefined
    return main ? pools.main.activate(conversationId) : pools.sub.activate(conversationId, agentId)
  }, [agentId, conversationId, main, pools])

  const view = useSyncExternalStore(main ? pools.main.subscribe : pools.sub.subscribe, () =>
    conversationId === null
      ? NO_SESSION_VIEW
      : main
        ? pools.main.view(conversationId)
        : pools.sub.view(conversationId, agentId),
  )

  if (conversationId === null) return { loadOlder: () => Promise.resolve(), refresh: noop, view }
  return {
    loadOlder: () =>
      main ? pools.main.loadOlder(conversationId) : pools.sub.loadOlder(conversationId, agentId),
    refresh: () =>
      main ? pools.main.refresh(conversationId) : pools.sub.refresh(conversationId, agentId),
    view,
  }
}
