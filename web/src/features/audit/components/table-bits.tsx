/** 清单两张表共用的小件：装表格的卡片、单元格样式、横向滚动容器与可排序的表头。 */

import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import type { TableSort } from '../details-model'
import { Card } from './overview-bits'

/** 表头：中性底色、吸顶，底线用 inset 阴影跟着单元格走；数字列右对齐，首末列补回卡片内边距。 */
export const TH =
  'sticky top-0 layer-local-1 h-11 bg-surface-container-low px-4 py-0 text-right text-label font-medium whitespace-nowrap text-on-surface-muted shadow-[var(--shadow-hairline-bottom)] first:pl-5.5 first:text-left last:pr-5.5'

/** 单元格：一行一条细线，末行不画；行要带 group/row。 */
export const TD =
  'h-11 border-b border-hairline px-4 py-0 text-right whitespace-nowrap tabular-nums group-last/row:border-b-0 first:pl-5.5 first:text-left last:pr-5.5'

/** 按比例分剩下宽度的文字列：max-w-0 让单元格可以比内容窄，内容一行截断、悬停看全名。 */
export const CLIP_TD = 'max-w-0 text-left whitespace-normal'

/**
 * 装表格的卡片，也是判断宽屏的容器：看卡宽而不是视口，侧栏拖宽或收起都跟着变。
 * 宽屏线取 @6xl（卡内 72rem）：按人表固定布局下 5 个数字列各约 145px，放得下三位数加长度条。
 * overflow-clip 让圆角裁掉表头底色，又不形成滚动容器，表头仍相对页面的滚动容器吸顶。
 */
export function TableCard({ children }: { children: ReactNode }) {
  return <Card className="@container overflow-clip px-5.5 py-5">{children}</Card>
}

/**
 * 表格外层：负外边距抵掉 TableCard 的内边距，表格贴满卡片左右和顶边，后面没有页脚时也贴底边。
 * 卡宽不够时表格在卡片里横着滚，不撑宽整页；够宽时不滚，否则表头会相对它吸顶而失效。
 */
export function TableScroll({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-5.5 -mt-5 overflow-x-auto last:-mb-5 @6xl:overflow-visible">{children}</div>
  )
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
