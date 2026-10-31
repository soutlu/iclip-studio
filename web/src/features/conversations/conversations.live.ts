/**
 * 全局帧落到对话行池，照 Kimi 的事件 reducer：帧按到达先后生效，同一拍到达的帧合批落地，行的变化只改池，
 * 成员与计数要变时才重拉对应列表；轮状态变化时按 id 补读单行兜底（照 Kimi）。视频帧不上行，只让视频进度重拉。
 *
 * 帧带属主（合同 §5「全局帧」）：别人的对话只牵动全部对话页与视频进度，不动自己的侧栏。
 */

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

/**
 * 全部对话页与视频进度的重拉窗口。
 *
 * 治理者收全平台的帧：全部对话页是个无限查询，一次失效要顺序重拉所有已展开的分页，每页后端还跑两条 COUNT；
 * 视频进度一阵出片就是一串帧。窗口尾随而不是每帧重置，持续的帧流下也能按时重拉一次。
 */
const REFRESH_WINDOW_MS = 1000

/**
 * 窗口内只失效一次。各条路共用一个出口：立刻失效与窗口到期的失效撞在一起会互相取消已发出的重拉。
 */
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

/** 一批帧落地后要做的事，同类合并，一批只做一次。 */
interface Effects {
  /** 自己侧栏的成员或计数变了：重拉拓扑与分页列表。 */
  sidebar: boolean
  /** 只有按状态筛选的侧栏拓扑与分页列表可能换成员。 */
  filtered: boolean
  audit: boolean
  /** 出了新素材片的对话：全部对话页列着它时要重拉，那一行的封面只在那份查询里。 */
  masters: Set<string>
  /** 重连后对齐搜索结果的成员。 */
  search: boolean
  rows: Set<string>
  /** 有对话的视频记录跳了状态，或者重连了：视频进度要重拉。 */
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

/** 一批帧带出的窗口重拉。 */
interface Refreshes {
  audit: () => void
  videoProgress: () => void
}

/** 在侧栏顶层订阅一次全局会话更新；治理者还会收到别人对话的帧。 */
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

/** 一帧改池，并记下要做的事。 */
const reduce = (
  rows: ConversationRowStore,
  update: SessionUpdate,
  userId: string | null,
  effects: Effects,
): void => {
  if (update.kind === 'reconnected') {
    // 全局帧不补发；重连后整份重拉，结果经记录本合进池里。
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
      // 全部对话页的筛选归属与两个总数由服务端重算：行还不在、忙闲翻转、或这一帧是收尾时才值得重拉。
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
      // 照 Kimi：轮状态变了（开跑、收场、待审批 / 提问出现或消失）按 id 补读一行兜底，结果同样经记录本合并，
      // 读的期间到达的帧在结果回来后重放。
      // 随运行变的行字段虽然另有 updated 帧，补读不依赖服务端每个写入口都发了帧。
      // 筛选列表也只在轮状态变了时重算：同样的状态再来一帧，归属不会变。
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
      // 只有挂着对话的视频记录算进视频进度；收尾标记的抹除由服务端的 updated 帧送来。
      if (conversationId === null || update.jobKind !== 'video') return
      // 帧上只有单条任务的状态，要的是按对话的汇总：重拉视频进度，不补读行。
      effects.videoProgress = true
      // 帧上分不出素材片还是编辑段，编辑段完成也会多重拉一次，无害。
      if (update.status === 'completed') effects.masters.add(conversationId)
      return
    }
  }
}

/** 全部对话页的哪一份缓存列着这段对话；最新素材片的地址只在那份查询里，单行补读带不回来。 */
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
