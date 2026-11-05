import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import { zConversationsAuditOut, zConversationsPageOut } from '@/shared/api/generated/zod.gen'
import { drainPages } from '@/shared/api/paging'
import { auditSearchParams, DEFAULT_AUDIT_FILTERS } from './audit.api'
import { conversationsQueryKeys, type Conversation } from './conversations.api'
import { conversationRowsOf } from './conversation-rows'
import { useVideoProgress, videoPhaseOf, type VideoProgress } from './video-progress.api'

const TASK_PAGE_LIMIT = 100

const POLL_MS = 5000

export const fetchTaskConversations = async (
  taskId: string,
  canAudit: boolean,
  signal: AbortSignal,
): Promise<Conversation[]> => {
  const options = {
    cache: 'no-store' as const,
    fallbackErrorMessage: '读取关联任务失败',
    signal,
  }
  if (!canAudit) {
    const page = await apiFetch(
      `/conversations/by-task/${encodeURIComponent(taskId)}`,
      zConversationsPageOut,
      options,
    )
    return page.items
  }

  const filters = {
    ...DEFAULT_AUDIT_FILTERS,
    deleted: 'live' as const,
    range: 'all' as const,
    taskId,
  }
  return drainPages<Conversation, string>(async (cursor) => {
    const params = auditSearchParams(filters, cursor ?? null, { limit: TASK_PAGE_LIMIT })
    const page = await apiFetch(
      `/conversations/audit?${params.toString()}`,
      zConversationsAuditOut,
      options,
    )
    return { items: page.items, next: page.nextCursor }
  })
}

export const taskConversationsRefetchInterval = (
  conversations: readonly Conversation[] | undefined,
  progress: VideoProgress | undefined,
): number | false =>
  (conversations ?? []).some(
    ({ activity, id }) => activity.busy || videoPhaseOf(progress, id) !== 'none',
  )
    ? POLL_MS
    : false

export const taskConversationsQueryKey = (taskId: string, canAudit: boolean) =>
  [...conversationsQueryKeys.all, 'task', taskId, canAudit ? 'audit' : 'own'] as const

export const useTaskConversations = (taskId: string, canAudit: boolean) => {
  const queryClient = useQueryClient()
  const rows = conversationRowsOf(queryClient)
  const queryKey = taskConversationsQueryKey(taskId, canAudit)
  const refetchInterval = () =>
    taskConversationsRefetchInterval(
      queryClient
        .getQueryData<readonly Conversation[]>(queryKey)
        ?.map((row) => rows.resolve(row) ?? row),
      queryClient.getQueryData<VideoProgress>(conversationsQueryKeys.videoProgress),
    )
  useVideoProgress(refetchInterval)
  return useQuery({
    queryKey,
    queryFn: ({ client, signal }) => {
      const rows = conversationRowsOf(client)
      return rows.track(
        () => fetchTaskConversations(taskId, canAudit, signal),
        (found, book) => rows.mergeRows(found, book),
      )
    },
    refetchInterval,
  })
}
