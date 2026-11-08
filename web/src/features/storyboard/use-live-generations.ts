import { useQueryClient } from '@tanstack/react-query'
import { use, useEffect } from 'react'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { storyboardQueryKeys } from './storyboard.api'

export const useLiveGenerations = (conversationId: string): void => {
  const connection = use(TranscriptConnectionContext)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (connection === null) return undefined
    return connection.watchSessions((update) => {
      const relevant =
        update.kind === 'reconnected' ||
        (update.kind === 'generation' && update.conversationId === conversationId)
      if (!relevant) return
      void queryClient.invalidateQueries({
        queryKey: storyboardQueryKeys.conversation(conversationId),
      })
    })
  }, [connection, conversationId, queryClient])
}
