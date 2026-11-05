import { z } from 'zod'
import {
  DEFAULT_EXECUTION_SORT,
  type ExecutionSort,
  type ExecutionSortKey,
  type Person,
  type SortOrder,
} from './audit.api'

export type TableSort<K extends string> = { key: K; order: SortOrder }

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

export const executionSortToSearch = (sort: ExecutionSort): ExecutionSortSearch => ({
  sort: sort.key === DEFAULT_EXECUTION_SORT.key ? undefined : sort.key,
  order: sort.order === DEFAULT_EXECUTION_SORT.order ? undefined : sort.order,
})
