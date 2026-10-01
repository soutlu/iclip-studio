/**
 * 全局帧落到对话行池，照 Kimi 的事件 reducer：同一拍到达的帧合批落地，行的变化只改池，
 * 成员与计数要变时才重拉对应列表，帧上没有的字段（出片汇总）按 id 补读单行。
 *
 * 帧带属主（合同 §5「全局帧」）：别人的对话只牵动全部对话页，不动自己的侧栏。
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { use, useEffect } from 'react'
import { useUser } from '@/shared/auth'
import type { SessionUpdate } from '@/shared/transcript/connection'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import {
  conversationsQueryKeys,
  refreshConversationLists,
  refreshConversationRow,
} from './conversations.api'
import { conversationRowsOf, type ConversationRowStore } from './conversation-rows'

/**
 * 全部对话页的重拉窗口。
 *
 * 治理者收全平台的帧，而这是个无限查询：一次失效要顺序重拉所有已展开的分页，每页后端还跑两条 COUNT。
 * 窗口尾随而不是每帧重置，持续的帧流下也能按时重拉一次。
 */
const AUDIT_REFRESH_WINDOW_MS = 1000

/** 一批帧落地后要做的事，同类合并，一批只做一次。 */
interface Effects {
  /** 自己侧栏的成员或计数变了：丢掉额外分页、重拉拓扑。 */
  sidebar: boolean
  /** 只有按状态筛选的侧栏与额外分页可能换成员。 */
  filtered: boolean
  audit: boolean
  rows: Set<string>
}

const noEffects = (): Effects => ({
  audit: false,
  filtered: false,
  rows: new Set(),
  sidebar: false,
})

/** 在侧栏顶层订阅一次全局会话更新；治理者还会收到别人对话的帧。 */
export const useLiveConversations = (enabled = true): void => {
  const connection = use(TranscriptConnectionContext)
  if (connection === null) throw new Error('useLiveConversations 要在 TranscriptProvider 里用')
  const queryClient = useQueryClient()
  const userId = useUser().data?.id ?? null

  useEffect(() => {
    if (!enabled) return
    const rows = conversationRowsOf(queryClient)

    let auditTimer: ReturnType<typeof setTimeout> | undefined
    // 三条路共用一个出口：立刻失效与窗口到期的失效撞在一起会互相取消已发出的重拉。
    const refreshAuditSoon = () => {
      if (auditTimer !== undefined) return
      auditTimer = setTimeout(() => {
        auditTimer = undefined
        void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.auditAll })
      }, AUDIT_REFRESH_WINDOW_MS)
    }

    let queued: SessionUpdate[] = []
    const flush = () => {
      const batch = queued
      queued = []
      const effects = noEffects()
      rows.batch(() => {
        for (const update of batch) reduce(rows, update, userId, effects)
      })
      run(queryClient, effects, refreshAuditSoon)
    }

    const stop = connection.watchSessions((update) => {
      if (queued.length === 0) queueMicrotask(flush)
      queued.push(update)
    })

    return () => {
      if (auditTimer !== undefined) clearTimeout(auditTimer)
      stop()
    }
  }, [connection, enabled, queryClient, userId])
}

/** 一帧改池，并记下要做的事。 */
const reduce = (
  rows: ConversationRowStore,
  update: SessionUpdate,
  userId: string | null,
  effects: Effects,
): void => {
  if (update.kind === 'reconnected') {
    // 全局帧不补发；重连后整份重拉，按水位规则合进池里（ADR-0004 第 7 条）。
    effects.sidebar = true
    effects.audit = true
    return
  }
  const mine = update.mark.ownerUserId === userId

  switch (update.kind) {
    case 'title':
      rows.applyTitle(update.conversationId, update.title, update.mark)
      return

    case 'activity': {
      const before = rows.get(update.conversationId)
      // 全部对话页的筛选归属与两个总数由服务端重算：行还不在、忙闲翻转、或这一帧是收尾时才值得重拉。
      if (
        before === undefined ||
        before.activity.busy !== update.busy ||
        (!update.busy && update.lastTurnReason === 'completed')
      ) {
        effects.audit = true
      }
      rows.applyActivity(
        update.conversationId,
        {
          busy: update.busy,
          lastTurnReason: update.lastTurnReason,
          pendingInteraction: update.pendingInteraction,
        },
        update.mark,
      )
      if (!mine) return
      // 不补读单行：Kimi 补读是为了它活动帧上没有的摘要字段；我们开跑记录运行另发 updated 帧（ADR-0005），
      // 行上随运行变的 lastRunId、收尾标记、updatedAt 都由它送到，活动帧本身带齐轮次活动。
      effects.filtered = true
      return
    }

    case 'created':
      rows.applyRow(update.row, update.mark)
      effects.audit = true
      if (mine) effects.sidebar = true
      return

    case 'updated': {
      const before = rows.get(update.conversationId)
      rows.applyRow(update.row, update.mark)
      const membership =
        before === undefined ||
        before.collectionId !== update.row.collectionId ||
        before.taskId !== update.row.taskId
      const completion = before?.completedAt !== update.row.completedAt
      if (membership || completion) effects.audit = true
      if (!mine) return
      // 合集换了，拓扑里哪一组有它就变了；只换了收尾标记，变的只是按状态筛选的那几份。
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
      // 图片与切段不上行；收尾标记的抹除由服务端的 updated 帧送来。
      if (conversationId === null || update.jobKind !== 'video') return
      // 帧上只有单条任务的状态，行上要的是视频汇总：补读这一行。别人的对话只在池里已有这一行时补。
      if (mine || rows.get(conversationId) !== undefined) effects.rows.add(conversationId)
      return
    }
  }
}

const run = (queryClient: QueryClient, effects: Effects, refreshAuditSoon: () => void): void => {
  if (effects.sidebar) void refreshConversationLists(queryClient, 'sidebar')
  else if (effects.filtered) {
    queryClient.removeQueries(conversationsQueryKeys.filteredLists('more'))
    void queryClient.invalidateQueries(conversationsQueryKeys.filteredLists('sidebar'))
  }
  if (effects.audit) refreshAuditSoon()
  for (const conversationId of effects.rows)
    void refreshConversationRow(queryClient, conversationId)
}
