import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import type { TableSort } from '../details-model'
import { Card } from './overview-bits'

export const TH =
  'sticky top-0 layer-local-1 h-11 bg-surface-container-low px-4 py-0 text-right text-label font-medium whitespace-nowrap text-on-surface-muted shadow-[var(--shadow-hairline-bottom)] first:pl-5.5 first:text-left last:pr-5.5'

export const TD =
  'h-11 border-b border-hairline px-4 py-0 text-right whitespace-nowrap tabular-nums group-last/row:border-b-0 first:pl-5.5 first:text-left last:pr-5.5'

export const CLIP_TD = 'max-w-0 text-left whitespace-normal'

export function TableCard({ children }: { children: ReactNode }) {
  return <Card className="@container overflow-clip px-5.5 py-5">{children}</Card>
}

export function TableScroll({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-5.5 -mt-5 overflow-x-auto last:-mb-5 @6xl:overflow-visible">{children}</div>
  )
}

export function SortHeader<K extends string>({
  column,
  sort,
  onSort,
  children,
}: {
  column: K
  sort: TableSort<K>
  onSort: (column: K) => void
  children: ReactNode
}) {
  const active = sort.key === column
  return (
    <th
      aria-sort={active ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={TH}
      scope="col"
    >
      <button
        className={cn(
          '-mx-1 -my-0.5 inline-flex ui-state cursor-pointer items-center gap-0.75 rounded-sm px-1 py-0.5 whitespace-nowrap ui-focus hover:text-on-surface',
          active && 'font-semibold text-on-surface',
        )}
        onClick={() => onSort(column)}
        type="button"
      >
        {children}
        {active ? (
          <svg aria-hidden className="size-2.5 fill-current" viewBox="0 0 10 10">
            <path d={sort.order === 'asc' ? 'M5 2.5 8 6.5H2Z' : 'M5 7.5 2 3.5h6Z'} />
          </svg>
        ) : null}
      </button>
    </th>
  )
}
