import { useInfiniteQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import {
  zAuditConversationsConversationsAuditGetQuery,
  zConversationsAuditOut,
} from '@/shared/api/generated/zod.gen'
import { dateRangeBounds, type DateRange } from '@/shared/lib/date-range'
import { conversationsQueryKeys, type ConversationListState } from './conversations.api'
import { conversationRowsOf } from './conversation-rows'

export const auditDeletedSchema = zAuditConversationsConversationsAuditGetQuery.shape.deleted
  .unwrap()
  .unwrap()

type AuditDeleted = z.output<typeof auditDeletedSchema>

export interface AuditFilters extends DateRange {
  state: ConversationListState
  deleted: AuditDeleted
  ownerUserId: string | null
  taskId: string | null
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = {
  deleted: 'live',
  ownerUserId: null,
  range: 'all',
  since: null,
  state: 'all',
  taskId: null,
  until: null,
}

export type AuditPage = z.output<typeof zConversationsAuditOut>

export type AuditConversation = AuditPage['items'][number]

const PAGE_LIMIT = 50

export const auditSearchParams = (
  filters: AuditFilters,
  cursor: string | null,
  { limit = PAGE_LIMIT, now = new Date() }: { limit?: number; now?: Date } = {},
): URLSearchParams => {
  const params = new URLSearchParams()
  params.set('state', filters.state)
  params.set('deleted', filters.deleted)
  params.set('limit', String(limit))
  if (filters.ownerUserId !== null) params.set('ownerUserId', filters.ownerUserId)
  if (filters.taskId !== null) params.set('taskId', filters.taskId)
  const { since, until } = dateRangeBounds(filters, now)
  if (since !== null) params.set('since', since.toISOString())
  if (until !== null) params.set('until', until.toISOString())
  if (cursor !== null) params.set('cursor', cursor)
  return params
}

const fetchAuditPage = (
  filters: AuditFilters,
  cursor: string | null,
  signal: AbortSignal,
): Promise<AuditPage> =>
  apiFetch(
    `/conversations/audit?${auditSearchParams(filters, cursor).toString()}`,
    zConversationsAuditOut,
    {
      fallbackErrorMessage: '读取全部任务失败',
      signal,
    },
  )

export const useAuditConversations = (filters: AuditFilters, enabled: boolean) =>
  useInfiniteQuery({
    enabled,
    gcTime: 30 * 60_000,
    queryFn: ({ client, pageParam, signal }) => {
      const rows = conversationRowsOf(client)
      return rows.track(
        () => fetchAuditPage(filters, pageParam, signal),
        (page, book) => ({ ...page, items: rows.mergeRows(page.items, book) }),
      )
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last: AuditPage) => last.nextCursor,
    queryKey: conversationsQueryKeys.audit(filters),
  })
