/** 需求单关联对话列表的成员随全局帧刷新：这张单下新出现、换走或删掉了对话，或连接重连时。 */

import { useQueryClient } from '@tanstack/react-query'
import { use, useEffect } from 'react'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { conversationRowsOf } from './conversation-rows'
import { taskConversationsQueryKey } from './task-conversations.api'

/**
 * 面板挂载期间订阅。行上的标题、活动与出片汇总由 useLiveConversations 落进行池，面板按 id 取行，
 * 这里只管成员：列表里有哪几段对话由服务端按需求单算。
 */
export const useLiveTaskConversations = (taskId: string, canAudit: boolean): void => {
  const connection = use(TranscriptConnectionContext)
  if (connection === null) throw new Error('useLiveTaskConversations 要在 TranscriptProvider 里用')
  const queryClient = useQueryClient()

  useEffect(() => {
    const queryKey = taskConversationsQueryKey(taskId, canAudit)
    const rows = conversationRowsOf(queryClient)
    return connection.watchSessions((update) => {
      if (update.kind === 'reconnected') {
        // 全局帧不补发，重连后对齐一次。
        void queryClient.invalidateQueries({ queryKey })
        return
      }
      if (update.kind === 'created' || update.kind === 'updated') {
        // 先看池里的旧行：帧在同一拍里还没落池（useLiveConversations 合批到微任务里才落）。
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
