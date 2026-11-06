import { useQueryClient } from '@tanstack/react-query'
import { use, useEffect } from 'react'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { conversationRowsOf } from './conversation-rows'
import { taskConversationsQueryKey } from './task-conversations.api'

export const useLiveTaskConversations = (taskId: string, canAudit: boolean): void => {
  const connection = use(TranscriptConnectionContext)
  if (connection === null) throw new Error('useLiveTaskConversations 要在 TranscriptProvider 里用')
  const queryClient = useQueryClient()

  useEffect(() => {
    const queryKey = taskConversationsQueryKey(taskId, canAudit)
    const rows = conversationRowsOf(queryClient)
    return connection.watchSessions((update) => {
      if (update.kind === 'reconnected') {
        void queryClient.invalidateQueries({ queryKey })
        return
      }
      if (update.kind === 'created' || update.kind === 'updated') {
        const before = rows.get(update.conversationId)
        if (update.row.taskId === taskId || before?.taskId === taskId) {
          void queryClient.invalidateQueries({ queryKey })
        }
        return
      }
      if (update.kind === 'deleted') {
        const listed = queryClient
          .getQueryData<readonly { id: string }[]>(queryKey)
          ?.some(({ id }) => id === update.conversationId)
        if (listed === true) void queryClient.invalidateQueries({ queryKey })
      }
    })
  }, [canAudit, connection, queryClient, taskId])
}
