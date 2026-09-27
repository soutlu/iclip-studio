/** 审计报表的只读口：总览按时间范围取一份，两张明细表按筛选范围翻页。 */

import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import {
  zAnomaliesOut,
  zAuditConversationsOut,
  zOverviewOut,
  type zMetricsOut,
} from '@/shared/api/generated/zod.gen'
import { dateRangeBounds, type DateRange } from '@/shared/lib/date-range'
import { overviewWindow, type OverviewRange } from './overview-range'

export type Metrics = z.output<typeof zMetricsOut>
export type Overview = z.output<typeof zOverviewOut>
export type TrendPoint = Overview['series'][number]
export type MovingAverages = NonNullable<TrendPoint['ma7']>
export type OverviewBucket = Overview['window']['bucket']
export type ConversationReportsPage = z.output<typeof zAuditConversationsOut>
export type ConversationReport = ConversationReportsPage['items'][number]
export type AnomaliesPage = z.output<typeof zAnomaliesOut>
export type Anomaly = AnomaliesPage['items'][number]
export type AnomalyKind = Anomaly['kind']

/** 三个标签页共用的筛选：时间范围、人（上游归属用的用户名）与需求单。 */
export interface AuditScope extends DateRange {
  userName: string | null
  taskId: string | null
}

export const DEFAULT_AUDIT_SCOPE: AuditScope = {
  range: '30d',
  since: null,
  until: null,
  taskId: null,
  userName: null,
}

const CONVERSATIONS_PAGE = 20
const ANOMALIES_PAGE = 50

type Window = { since: Date | null; until: Date | null }

const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

const scopeParams = (scope: AuditScope, window: Window): URLSearchParams => {
  const params = new URLSearchParams()
  if (window.since !== null) params.set('since', window.since.toISOString())
  if (window.until !== null) params.set('until', window.until.toISOString())
  if (scope.userName !== null) params.set('userName', scope.userName)
  if (scope.taskId !== null) params.set('taskId', scope.taskId)
  return params
}

/** 总览的查询串：本地零点切的时间窗与浏览器时区，粒度与上一期由服务端定；now 可注入方便测试。 */
export const overviewSearchParams = (
  range: OverviewRange,
  now: Date = new Date(),
  timeZone: string = browserTimeZone(),
): URLSearchParams => {
  const { since, until } = overviewWindow(range, now)
  return new URLSearchParams({
    since: since.toISOString(),
    timezone: timeZone,
    until: until.toISOString(),
  })
}

export const conversationsSearchParams = (
  scope: AuditScope,
  cursor: string | null,
  now: Date = new Date(),
): URLSearchParams => {
  const params = scopeParams(scope, dateRangeBounds(scope, now))
  params.set('limit', String(CONVERSATIONS_PAGE))
  if (cursor !== null) params.set('cursor', cursor)
  return params
}

export const anomaliesSearchParams = (
  scope: AuditScope,
  kinds: readonly AnomalyKind[] | null,
  cursor: string | null,
  now: Date = new Date(),
): URLSearchParams => {
  const params = scopeParams(scope, dateRangeBounds(scope, now))
  params.set('limit', String(ANOMALIES_PAGE))
  for (const kind of kinds ?? []) params.append('kind', kind)
  if (cursor !== null) params.set('cursor', cursor)
  return params
}

export const auditQueryKeys = {
  all: ['audit'] as const,
  overview: (range: OverviewRange) => ['audit', 'overview', range] as const,
  conversations: (scope: AuditScope) => ['audit', 'conversations', scope] as const,
  anomalies: (scope: AuditScope, kinds: readonly AnomalyKind[] | null) =>
    ['audit', 'anomalies', scope, kinds] as const,
}

/**
 * 总览一次取齐本期、上一期、趋势与均线。预设的「此刻」在发请求时才取，重取就是最新的。
 * 换范围时先留着上一份数据，新数据到了再换，页面不闪回骨架。
 */
export const useAuditOverview = (range: OverviewRange) =>
  useQuery({
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      apiFetch(`/audit/overview?${overviewSearchParams(range).toString()}`, zOverviewOut, {
        fallbackErrorMessage: '读取审计总览失败',
        signal,
      }),
    queryKey: auditQueryKeys.overview(range),
  })

/** 缓存留 30 分钟：点进一段对话看上一阵再退回明细表，已展开的分页不该缩回第一页。 */
export const useAuditConversationReports = (scope: AuditScope) =>
  useInfiniteQuery({
    gcTime: 30 * 60_000,
    queryFn: ({ pageParam, signal }) =>
      apiFetch(
        `/audit/conversations?${conversationsSearchParams(scope, pageParam).toString()}`,
        zAuditConversationsOut,
        { fallbackErrorMessage: '读取对话明细失败', signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ConversationReportsPage) => last.nextCursor,
    queryKey: auditQueryKeys.conversations(scope),
  })

/** kinds 为空即全部种类；路由层与面板用同一组 kinds 调用时共享同一份缓存。 */
export const useAuditAnomalies = (scope: AuditScope, kinds: readonly AnomalyKind[]) => {
  const filter = kinds.length === 0 ? null : kinds
  return useInfiniteQuery({
    queryFn: ({ pageParam, signal }) =>
      apiFetch(
        `/audit/anomalies?${anomaliesSearchParams(scope, filter, pageParam).toString()}`,
        zAnomaliesOut,
        { fallbackErrorMessage: '读取异常列表失败', signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: AnomaliesPage) => last.nextCursor,
    queryKey: auditQueryKeys.anomalies(scope, filter),
  })
}
