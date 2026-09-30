/** 按人：一人一行，成片数带长度条，末列是每期成片的迷你图；点表头在前端排序。 */

import { useState } from 'react'
import { cn } from '@/shared/lib/utils'
import type { OverviewBucket, Person } from '../audit.api'
import { DEFAULT_PEOPLE_SORT, nextSort, sortPeople, type PeopleSortKey } from '../details-model'
import { EMPTY, fmtDuration, fmtRate, fmtTokens } from '../overview-format'
import { Sparkline } from './sparkline'
import { SortHeader, TableScroll, TD, TH } from './table-bits'

type PeopleTableProps = {
  people: readonly Person[]
  /** 迷你图每一格的粒度，决定末列列名。 */
  bucket: OverviewBucket
  nameOf: (userName: string) => string | undefined
}

const TREND_TITLE: Record<OverviewBucket, string> = {
  hour: '每小时成片',
  day: '每天成片',
  week: '每周成片',
}

/** 成片数长度条最长多少 px。 */
const BAR_MAX = 80

export function PeopleTable({ people, bucket, nameOf }: PeopleTableProps) {
  const [sort, setSort] = useState(DEFAULT_PEOPLE_SORT)
  if (people.length === 0) {
    return <p className="text-label text-on-surface-muted">这个范围里没人出片，也没人跑过</p>
  }
  const onSort = (key: PeopleSortKey) => setSort((current) => nextSort(current, key))
  const maxDeliveries = Math.max(1, ...people.map((person) => person.metrics.deliveries))
  return (
    <TableScroll>
      {/* 宽屏固定列宽：「人」320、迷你图 152（110 的图加两侧内边距），5 个数字列均分余下宽度；
          窄屏按内容排、横着滚。固定布局只认表头行的宽度。 */}
      <table
        aria-label="按人"
        className="w-full border-separate border-spacing-0 text-body @6xl:table-fixed"
      >
        <thead>
          <tr>
            <th className={cn(TH, '@6xl:w-80')} scope="col">
              人
            </th>
            <SortHeader column="deliveries" onSort={onSort} sort={sort}>
              成片数
            </SortHeader>
            <SortHeader column="attempts" onSort={onSort} sort={sort}>
              每镜头重试次数
            </SortHeader>
            <SortHeader column="oneTake" onSort={onSort} sort={sort}>
              一次通过
            </SortHeader>
            <SortHeader column="cycle" onSort={onSort} sort={sort}>
              单任务平均时长
            </SortHeader>
            <SortHeader column="perDelivery" onSort={onSort} sort={sort}>
              每件成片消耗
            </SortHeader>
            <th className={cn(TH, '@6xl:w-38')} scope="col">
              {TREND_TITLE[bucket]}
            </th>
          </tr>
        </thead>
        <tbody>
          {sortPeople(people, sort).map((person) => {
            const { metrics } = person
            const name = nameOf(person.userName) ?? person.userName
            return (
              <tr className="group/row hover:bg-state-hover" key={person.userName}>
                <td className={cn(TD, '@6xl:overflow-hidden')}>
                  <span className="flex items-center gap-2.5">
                    <span
                      aria-hidden
                      className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-container-high text-caption font-semibold text-on-surface-variant"
                    >
                      {name.slice(-1)}
                    </span>
                    {name}
                    {name === person.userName ? null : (
                      <span className="text-caption text-on-surface-muted">{person.userName}</span>
                    )}
                  </span>
                </td>
                <td className={TD}>
                  <span className="inline-flex items-center justify-end gap-2">
                    {metrics.deliveries}
                    <i
                      aria-hidden
                      className="block h-1.5 rounded-full bg-chart-1"
                      style={{
                        width: `${Math.max(2, (metrics.deliveries / maxDeliveries) * BAR_MAX)}px`,
                      }}
                    />
                  </span>
                </td>
                <td className={TD}>
                  {metrics.attemptsPerShot === null ? EMPTY : metrics.attemptsPerShot.toFixed(1)}
                </td>
                <td className={TD}>{fmtRate(metrics.oneTakeRate)}</td>
                <td className={TD}>{fmtDuration(metrics.activeCycleSeconds?.avg ?? null)}</td>
                <td className={TD}>{fmtTokens(metrics.tokensPerDelivery)}</td>
                <td className={TD}>
                  <Sparkline
                    height={24}
                    values={person.trend.map((point) => point.deliveries)}
                    width={110}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </TableScroll>
  )
}
