import { use, useEffect, useSyncExternalStore } from 'react'
import { MAIN_AGENT_ID } from './connection'
import { TranscriptPoolsContext } from './transcript-context'
import type { TranscriptView } from './view'

export type { TranscriptView } from './view'

/**
 * 用一段对话里某个 agent 的流：主流走主会话池，子代理走子代理池；挂载时 activate，卸载时释放。
 * 同一段流多处同时用时共享一份；主流离开后仍在池里常驻，切回来不用重读。
 */
export const useTranscript = (
  conversationId: string,
  agentId: string = MAIN_AGENT_ID,
): { view: TranscriptView; refresh: () => void; loadOlder: () => Promise<void> } => {
  const pools = use(TranscriptPoolsContext)
  if (pools === null) throw new Error('useTranscript 要在 TranscriptProvider 里用')
  const main = agentId === MAIN_AGENT_ID

  useEffect(
    () =>
      main ? pools.main.activate(conversationId) : pools.sub.activate(conversationId, agentId),
    [agentId, conversationId, main, pools],
  )

  const view = useSyncExternalStore(main ? pools.main.subscribe : pools.sub.subscribe, () =>
    main ? pools.main.view(conversationId) : pools.sub.view(conversationId, agentId),
  )

  return {
    loadOlder: () =>
      main ? pools.main.loadOlder(conversationId) : pools.sub.loadOlder(conversationId, agentId),
    refresh: () =>
      main ? pools.main.refresh(conversationId) : pools.sub.refresh(conversationId, agentId),
    view,
  }
}
