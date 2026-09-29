/** 审计报表的只读口：总览与按人各按时间范围取一份，按任务执行按时间范围、人与排序翻页。 */

import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import {
  zAuditExecutionsOut,
  zAuditPeopleOut,
  zOverviewOut,
  type zExecutionsAuditExecutionsGetQuery,
  type zMetricsOut,
} from '@/shared/api/generated/zod.gen'
import { AUDIT_TIME_ZONE } from './audit-time'
import { overviewWindow, type OverviewRange } from './overview-range'

export type Metrics = z.output<typeof zMetricsOut>
export type Overview = z.output<typeof zOverviewOut>
export type TrendPoint = Overview['series'][number]
export type MovingAverages = NonNullable<TrendPoint['ma7']>
export type OverviewBucket = Overview['window']['bucket']
export type PeopleReport = z.output<typeof zAuditPeopleOut>
export type Person = PeopleReport['items'][number]
export type ExecutionsPage = z.output<typeof zAuditExecutionsOut>
export type Execution = ExecutionsPage['items'][number]
export type ExecutionShot = Execution['shots'][number]
export type ExecutionThresholds = ExecutionsPage['thresholds']
export type ExecutionAnomalyKind = Execution['anomalies'][number]

type ExecutionsQuery = z.input<typeof zExecutionsAuditExecutionsGetQuery>
export type ExecutionSortKey = NonNullable<ExecutionsQuery['sort']>
export type SortOrder = NonNullable<ExecutionsQuery['order']>

/** 按任务执行由接口排序；换排序就从第一页重读。 */
export type ExecutionSort = { key: ExecutionSortKey; order: SortOrder }

export const DEFAULT_EXECUTION_SORT: ExecutionSort = { key: 'start', order: 'desc' }

const EXECUTIONS_PAGE = 50

/** 按时间范围取数的查询串：UTC+8 零点切的时间窗与固定的审计时区，粒度由服务端定；now 可注入方便测试。 */
export const overviewSearchParams = (
  range: OverviewRange,
  now: Date = new Date(),
): URLSearchParams => {
  const { since, until } = overviewWindow(range, now)
  return new URLSearchParams({
    since: since.toISOString(),
    timezone: AUDIT_TIME_ZONE,
    until: until.toISOString(),
  })
}

const executionsSearchParams = (
  range: OverviewRange,
  userName: string | null,
  sort: ExecutionSort,
  cursor: string | null,
): URLSearchParams => {
  const { since, until } = overviewWindow(range, new Date())
  const params = new URLSearchParams({
    limit: String(EXECUTIONS_PAGE),
    order: sort.order,
    since: since.toISOString(),
    sort: sort.key,
    until: until.toISOString(),
  })
  if (userName !== null) params.set('userName', userName)
  if (cursor !== null) params.set('cursor', cursor)
  return params
}

export const auditQueryKeys = {
  all: ['audit'] as const,
  overview: (range: OverviewRange) => ['audit', 'overview', range] as const,
  people: (range: OverviewRange) => ['audit', 'people', range] as const,
  executions: (range: OverviewRange, userName: string | null, sort: ExecutionSort) =>
    ['audit', 'executions', range, userName, sort] as const,
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

/** 按人一次全给；按人筛选在前端做，所以不带人。换范围时同样先留着上一份。 */
export const useAuditPeople = (range: OverviewRange) =>
  useQuery({
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      apiFetch(`/audit/people?${overviewSearchParams(range).toString()}`, zAuditPeopleOut, {
        fallbackErrorMessage: '读取按人统计失败',
        signal,
      }),
    queryKey: auditQueryKeys.people(range),
  })

/**
 * 按任务执行一页 50 段，游标只对发它的那种排序有效，所以排序进查询键、换了就从头读。
 * 缓存留 30 分钟：点进一段对话看上一阵再退回来，已展开的分页不该缩回第一页。
 */
export const useAuditExecutions = (
  range: OverviewRange,
  userName: string | null,
  sort: ExecutionSort,
) =>
  useInfiniteQuery({
    gcTime: 30 * 60_000,
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam, signal }) =>
      apiFetch(
        `/audit/executions?${executionsSearchParams(range, userName, sort, pageParam).toString()}`,
        zAuditExecutionsOut,
        { fallbackErrorMessage: '读取任务执行失败', signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ExecutionsPage) => last.nextCursor,
    queryKey: auditQueryKeys.executions(range, userName, sort),
  })
