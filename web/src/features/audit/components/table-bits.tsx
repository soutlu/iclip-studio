/** 清单两张表共用的小件：单元格样式、横向滚动容器与可排序的表头。 */

import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import type { TableSort } from '../details-model'

/** 表头：数字列右对齐，首列贴左边。 */
export const TH =
  'border-b border-hairline px-2.5 py-2 text-right text-label font-medium whitespace-nowrap text-on-surface-muted first:pl-0 first:text-left'

/** 单元格：一行一条细线，末行不画；行要带 group/row。 */
export const TD =
  'border-b border-hairline px-2.5 py-2.5 text-right whitespace-nowrap tabular-nums group-last/row:border-b-0 first:pl-0 first:text-left'

/** 按比例分剩下宽度的文字列：max-w-0 让单元格可以比内容窄，内容一行截断、悬停看全名。 */
export const CLIP_TD = 'max-w-0 text-left whitespace-normal'

/**
 * 表格的横向滚动容器：窄屏上表格在卡片里横着滚，不撑宽整页。
 * 四周各留出焦点环的位置，否则伸出行外的焦点环会被滚动容器裁掉；负外边距抵掉这圈内边距，不挪表格。
 */
export function TableScroll({ children }: { children: ReactNode }) {
  return <div className="relative -m-1.5 overflow-x-auto p-1.5">{children}</div>
}

/** 可排序的表头：点了按这一列排，再点换方向；当前列加粗带箭头。 */
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
