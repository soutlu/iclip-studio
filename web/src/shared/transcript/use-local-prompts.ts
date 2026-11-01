import { use, useCallback, useSyncExternalStore } from 'react'
import { NO_LOCAL_PROMPTS, type LocalPromptStore, type LocalPrompts } from './local-prompts'
import { LocalPromptsContext } from './transcript-context'

/**
 * 读一段对话的本地发送状态，并拿到写入用的 store；离开页面再回来状态仍在。
 * `conversationId` 为 null（会话还没开）时状态是空的，写入时由调用方带上开好的会话 id。
 */
export const useLocalPrompts = (
  conversationId: string | null,
): { state: LocalPrompts; store: LocalPromptStore } => {
  const store = use(LocalPromptsContext)
  if (store === null) throw new Error('useLocalPrompts 要在 TranscriptProvider 里用')
  const subscribe = useCallback((onChange: () => void) => store.subscribe(onChange), [store])
  const state = useSyncExternalStore(subscribe, () =>
    conversationId === null ? NO_LOCAL_PROMPTS : store.get(conversationId),
  )
  return { state, store }
}
