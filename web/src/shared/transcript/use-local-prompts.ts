import { use, useCallback, useSyncExternalStore } from 'react'
import { NO_LOCAL_PROMPTS, type LocalPromptStore, type LocalPrompts } from './local-prompts'
import { LocalPromptsContext } from './transcript-context'

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
