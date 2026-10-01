import { use, useCallback, useSyncExternalStore } from 'react'
import type { LocalPromptStore, LocalPrompts } from './local-prompts'
import { LocalPromptsContext } from './transcript-context'

/** 读一段对话的本地发送状态，并拿到写入用的 store；离开页面再回来状态仍在。 */
export const useLocalPrompts = (
  conversationId: string,
): { state: LocalPrompts; store: LocalPromptStore } => {
  const store = use(LocalPromptsContext)
  if (store === null) throw new Error('useLocalPrompts 要在 TranscriptProvider 里用')
  const subscribe = useCallback((onChange: () => void) => store.subscribe(onChange), [store])
  const state = useSyncExternalStore(subscribe, () => store.get(conversationId))
  return { state, store }
}
