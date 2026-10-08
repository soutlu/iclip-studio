/** 清单：工具条定时间、按人筛选，下面是按人与按任务执行次数两张表。 */

import { useEffect, useEffectEvent, useId } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { ListError, ListPending, NextPageFooter } from '@/shared/ui/list-state'
import {
  useAuditExecutions,
  useAuditPeople,
  type ExecutionSort,
  type ExecutionSortKey,
} from '../audit.api'
import { nextSort } from '../details-model'
import type { OverviewRange } from '../overview-range'
import { ExecutionsTable } from './executions-table'
import { Section } from './overview-bits'
import { OverviewToolbar } from './overview-toolbar'
import { PeopleTable } from './people-table'
import { PersonFilter } from './person-filter'
import { TableCard } from './table-bits'

type DetailsPanelProps = {
  range: OverviewRange
  onRangeChange: (next: OverviewRange) => void
  /** 按人筛选选中的用户名；null 是全部人。 */
  userName: string | null
  onUserNameChange: (userName: string | null) => void
  /** 按任务执行次数的排序，由接口排。 */
  sort: ExecutionSort
  onSortChange: (next: ExecutionSort) => void
  /** 上游归属用户名 → 显示名；名册里没有就原样显示。 */
  nameOf: (userName: string) => string | undefined
  /** 页面的滚动容器，按任务执行次数滚到接近底部时读下一页。 */
  getScrollElement: () => HTMLElement | null
}

const PEOPLE_INFO =
  '成片数：同一需求单下的多段对话合计为 1 件；未关联需求单的对话，每段有成功出片的计为 1 件。仅运行过、未出片的人也会列出。'

export function DetailsPanel({
  range,
  onRangeChange,
  userName,
  onUserNameChange,
  sort,
  onSortChange,
  nameOf,
  getScrollElement,
}: DetailsPanelProps) {
  const baseId = useId()
  const people = useAuditPeople(range)
  // 名单只认这个范围自己的那份；换范围时留着的上一份不拿来判人在不在。
  const roster = people.isPlaceholderData ? undefined : people.data?.items
  const person =
    userName !== null && roster !== undefined && !roster.some((item) => item.userName === userName)
      ? null
      : userName
  // 选中的人不在名单里就清掉，地址栏也跟着去掉。
  const clearPerson = useEffectEvent(() => onUserNameChange(null))
  useEffect(() => {
    if (person !== userName) clearPerson()
  }, [person, userName])

  const shown =
    people.data === undefined
      ? []
      : people.data.items.filter((item) => person === null || item.userName === person)

  return (
    <div className="flex flex-col gap-3">
      <OverviewToolbar onChange={onRangeChange} range={range}>
        <PersonFilter
          nameOf={nameOf}
          onChange={onUserNameChange}
          people={people.data?.items ?? []}
          value={person}
        />
      </OverviewToolbar>
      <Section id={`${baseId}-people`} info={PEOPLE_INFO} title="按人">
        <TableCard>
          {people.isError && people.data === undefined ? (
            <ListError
              message={errorMessageOf(people.error, '读取按人统计失败')}
              onRetry={() => void people.refetch()}
            />
          ) : people.data === undefined ? (
            <ListPending label="正在读取按人统计" />
          ) : (
            <div
              aria-busy={people.isPlaceholderData}
              className="transition-opacity ui-motion-s aria-busy:opacity-60"
            >
              <PeopleTable bucket={people.data.bucket} nameOf={nameOf} people={shown} />
            </div>
          )}
        </TableCard>
      </Section>
      <ExecutionsSection
        getScrollElement={getScrollElement}
        id={`${baseId}-executions`}
        nameOf={nameOf}
        onSort={(key) => onSortChange(nextSort(sort, key))}
        range={range}
        sort={sort}
        userName={person}
      />
    </div>
  )
}

type ExecutionsSectionProps = {
  id: string
  range: OverviewRange
  userName: string | null
  sort: ExecutionSort
  onSort: (key: ExecutionSortKey) => void
  nameOf: (userName: string) => string | undefined
  getScrollElement: () => HTMLElement | null
}

function ExecutionsSection({
  id,
  range,
  userName,
  sort,
  onSort,
  nameOf,
  getScrollElement,
}: ExecutionsSectionProps) {
  const query = useAuditExecutions(range, userName, sort)
  const first = query.data?.pages[0]
  const rows = query.data?.pages.flatMap((page) => page.items) ?? []
  const who = userName === null ? null : (nameOf(userName) ?? userName)
  return (
    <Section
      aside={
        first === undefined ? null : (
          <span className="text-label text-on-surface-muted">
            共 {first.total} 次{first.flagged > 0 ? ` · ${first.flagged} 次有异常` : ''}
          </span>
        )
      }
      id={id}
      info="一段对话计为一次任务执行"
      title="按任务执行次数"
    >
      <TableCard>
        {query.isError ? (
          <ListError
            message={errorMessageOf(query.error, '读取任务执行失败')}
            onRetry={() => void query.refetch()}
          />
        ) : first === undefined ? (
          <ListPending label="正在读取任务执行" />
        ) : rows.length === 0 ? (
          <p className="text-label text-on-surface-muted">
            {who === null ? '所选时间范围内暂无任务执行' : `${who}在所选时间范围内暂无任务执行`}
          </p>
        ) : (
          <div
            aria-busy={query.isPlaceholderData}
            className="transition-opacity ui-motion-s aria-busy:opacity-60"
          >
            <ExecutionsTable
              executions={rows}
              nameOf={nameOf}
              onSort={onSort}
              sort={sort}
              thresholds={first.thresholds}
            />
            {query.hasNextPage ? (
              <NextPageFooter
                getScrollElement={getScrollElement}
                query={query}
                shown={rows.length}
                total={first.total}
              />
            ) : null}
          </div>
        )}
      </TableCard>
    </Section>
  )
}
