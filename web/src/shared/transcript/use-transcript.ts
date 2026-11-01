import { use, useEffect, useSyncExternalStore } from 'react'
import { MAIN_AGENT_ID } from './connection'
import { TranscriptPoolsContext } from './transcript-context'
import { NO_SESSION_VIEW, type TranscriptView } from './view'

export type { TranscriptView } from './view'

const noop = () => {}

/**
 * 用一段对话里某个 agent 的流：主流走主会话池，子代理走子代理池；挂载时 activate，卸载时释放。
 * 同一段流多处同时用时共享一份；主流离开后仍在池里常驻，切回来不用重读。
 * `conversationId` 为 null 表示会话还没开（发第一条消息时才开的测试预览）：给一份空的就绪视图，不读也不订。
 */
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
