/** 清单页签的排序规则：点表头怎么换排序，按人表在前端怎么排，按任务执行的排序怎么存进查询串。 */

import { z } from 'zod'
import {
  DEFAULT_EXECUTION_SORT,
  type ExecutionSort,
  type ExecutionSortKey,
  type Person,
  type SortOrder,
} from './audit.api'

export type TableSort<K extends string> = { key: K; order: SortOrder }

/** 点表头：换一列从降序开始，同一列再点换方向。 */
export const nextSort = <K extends string>(current: TableSort<K>, key: K): TableSort<K> =>
  current.key === key
    ? { key, order: current.order === 'desc' ? 'asc' : 'desc' }
    : { key, order: 'desc' }

export type PeopleSortKey = 'deliveries' | 'attempts' | 'oneTake' | 'cycle' | 'perDelivery'

export const DEFAULT_PEOPLE_SORT: TableSort<PeopleSortKey> = { key: 'deliveries', order: 'desc' }

const PEOPLE_SORT_VALUE: Record<PeopleSortKey, (person: Person) => number | null> = {
  deliveries: ({ metrics }) => metrics.deliveries,
  attempts: ({ metrics }) => metrics.attemptsPerShot,
  oneTake: ({ metrics }) => metrics.oneTakeRate,
  cycle: ({ metrics }) => metrics.activeCycleSeconds?.avg ?? null,
  perDelivery: ({ metrics }) => metrics.tokensPerDelivery,
}

/** 按人表的排序：空值不管升降都排最后，取值相同的保持接口给的次序（成片多的在前）。 */
export function sortPeople(people: readonly Person[], sort: TableSort<PeopleSortKey>): Person[] {
  const valueOf = PEOPLE_SORT_VALUE[sort.key]
  const sign = sort.order === 'asc' ? 1 : -1
  return [...people].sort((x, y) => {
    const a = valueOf(x)
    const b = valueOf(y)
    if (a === null || b === null) return Number(a === null) - Number(b === null)
    return (a - b) * sign
  })
}

const EXECUTION_SORT_KEYS = [
  'start',
  'retries',
  'cycle',
  'tokens',
] as const satisfies readonly ExecutionSortKey[]

/** 按任务执行的排序在查询串里的两个字段，拼进审计页的 search schema；退回清单时排序还在。 */
export const executionSortSearchFields = {
  sort: z.enum(EXECUTION_SORT_KEYS).optional().catch(undefined),
  order: z.enum(['asc', 'desc']).optional().catch(undefined),
}

type ExecutionSortSearch = {
  sort?: ExecutionSortKey | undefined
  order?: SortOrder | undefined
}

export const executionSortFromSearch = ({ sort, order }: ExecutionSortSearch): ExecutionSort => ({
  key: sort ?? DEFAULT_EXECUTION_SORT.key,
  order: order ?? DEFAULT_EXECUTION_SORT.order,
})

/** 等于缺省的那一半不落地址栏。 */
export const executionSortToSearch = (sort: ExecutionSort): ExecutionSortSearch => ({
  sort: sort.key === DEFAULT_EXECUTION_SORT.key ? undefined : sort.key,
  order: sort.order === DEFAULT_EXECUTION_SORT.order ? undefined : sort.order,
})
