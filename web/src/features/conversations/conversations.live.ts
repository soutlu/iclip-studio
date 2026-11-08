import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import { use, useEffect } from 'react'
import { useUser } from '@/shared/auth'
import type { SessionUpdate } from '@/shared/transcript/connection'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import type { AuditPage } from './audit.api'
import {
  conversationsQueryKeys,
  refreshConversationLists,
  refreshConversationRow,
} from './conversations.api'
import { conversationRowsOf, type ConversationRowStore } from './conversation-rows'

const REFRESH_WINDOW_MS = 1000

const trailingRefresh = (queryClient: QueryClient, queryKey: readonly unknown[]) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer)
    },
    soon: () => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        void queryClient.invalidateQueries({ queryKey })
      }, REFRESH_WINDOW_MS)
    },
  }
}

interface Effects {
  sidebar: boolean
  filtered: boolean
  audit: boolean
  masters: Set<string>
  search: boolean
  rows: Set<string>
  videoProgress: boolean
}

const noEffects = (): Effects => ({
  audit: false,
  filtered: false,
  masters: new Set(),
  rows: new Set(),
  search: false,
  sidebar: false,
  videoProgress: false,
})

interface Refreshes {
  audit: () => void
  videoProgress: () => void
}

export const useLiveConversations = (enabled = true): void => {
  const connection = use(TranscriptConnectionContext)
  if (connection === null) throw new Error('useLiveConversations 要在 TranscriptProvider 里用')
  const queryClient = useQueryClient()
  const userId = useUser().data?.id ?? null

  useEffect(() => {
    if (!enabled) return
    const rows = conversationRowsOf(queryClient)
    const audit = trailingRefresh(queryClient, conversationsQueryKeys.auditAll)
    const videoProgress = trailingRefresh(queryClient, conversationsQueryKeys.videoProgress)
    const refreshes: Refreshes = { audit: audit.soon, videoProgress: videoProgress.soon }

    let queued: SessionUpdate[] = []
    const flush = () => {
      const batch = queued
      queued = []
      const effects = noEffects()
      rows.batch(() => {
        for (const update of batch) reduce(rows, update, userId, effects)
      })
      run(queryClient, effects, refreshes)
    }

    const stop = connection.watchSessions((update) => {
      if (queued.length === 0) queueMicrotask(flush)
      queued.push(update)
    })

    return () => {
      audit.cancel()
      videoProgress.cancel()
      stop()
    }
  }, [connection, enabled, queryClient, userId])
}

const reduce = (
  rows: ConversationRowStore,
  update: SessionUpdate,
  userId: string | null,
  effects: Effects,
): void => {
  if (update.kind === 'reconnected') {
    effects.sidebar = true
    effects.audit = true
    effects.search = true
    effects.videoProgress = true
    return
  }
  const mine = update.ownerUserId === userId

  switch (update.kind) {
    case 'title':
      rows.applyTitle(update.conversationId, update.title)
      return

    case 'activity': {
      const before = rows.get(update.conversationId)
      if (
        before === undefined ||
        before.activity.busy !== update.busy ||
        (!update.busy && update.lastTurnReason === 'completed')
      ) {
        effects.audit = true
      }
      rows.applyActivity(update.conversationId, {
        busy: update.busy,
        lastTurnReason: update.lastTurnReason,
        pendingInteraction: update.pendingInteraction,
      })
      if (!mine) return
      if (
        before === undefined ||
        before.activity.busy !== update.busy ||
        before.activity.pendingInteraction !== update.pendingInteraction ||
        (before.activity.lastTurnReason ?? null) !== update.lastTurnReason
      ) {
        effects.rows.add(update.conversationId)
        effects.filtered = true
      }
      return
    }

    case 'created':
      rows.applyRow(update.row)
      effects.audit = true
      if (mine) effects.sidebar = true
      return

    case 'updated': {
      const before = rows.get(update.conversationId)
      rows.applyRow(update.row)
      const membership =
        before === undefined ||
        before.collectionId !== update.row.collectionId ||
        before.taskId !== update.row.taskId
      const completion = before?.completedAt !== update.row.completedAt
      if (membership || completion) effects.audit = true
      if (!mine) return
      if (membership) effects.sidebar = true
      else if (completion) effects.filtered = true
      return
    }

    case 'deleted':
      rows.applyDeleted(update.conversationId)
      effects.audit = true
      if (mine) effects.sidebar = true
      return

    case 'generation': {
      const conversationId = update.conversationId
      if (conversationId === null || update.jobKind !== 'video') return
      effects.videoProgress = true
      if (update.status === 'completed') effects.masters.add(conversationId)
      return
    }
  }
}

const listedInAudit = (queryClient: QueryClient, conversationId: string): boolean =>
  queryClient
    .getQueriesData<InfiniteData<AuditPage>>({ queryKey: conversationsQueryKeys.auditAll })
    .some(
      ([, data]) =>
        data?.pages.some((page) => page.items.some((item) => item.id === conversationId)) ?? false,
    )

const run = (queryClient: QueryClient, effects: Effects, refreshes: Refreshes): void => {
  if (effects.sidebar) void refreshConversationLists(queryClient, 'sidebar')
  else if (effects.filtered) {
    void queryClient.invalidateQueries(conversationsQueryKeys.filteredLists('more'))
    void queryClient.invalidateQueries(conversationsQueryKeys.filteredLists('sidebar'))
  }
  if (effects.search)
    void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.searchAll })
  if (
    effects.audit ||
    [...effects.masters].some((conversationId) => listedInAudit(queryClient, conversationId))
  ) {
    refreshes.audit()
  }
  if (effects.videoProgress) refreshes.videoProgress()
  for (const conversationId of effects.rows)
    void refreshConversationRow(queryClient, conversationId)
}
