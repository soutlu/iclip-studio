import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useRef } from 'react'
import { z } from 'zod'
import {
  DetailsPanel,
  executionSortFromSearch,
  executionSortSearchFields,
  executionSortToSearch,
  OverviewAsOf,
  OverviewPanel,
  overviewRangeFromSearch,
  overviewRangeSearchFields,
  overviewRangeToSearch,
  type ExecutionSort,
  type OverviewRange,
} from '@/features/audit'
import { useUsersDirectory } from '@/shared/auth'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import { requireGovernor } from '../-require-governor'

const TABS = [
  { value: 'overview', label: '总览' },
  { value: 'details', label: '清单' },
] as const

type TabValue = (typeof TABS)[number]['value']

/** 等于缺省的条件不落地址栏，非法取值退回缺省。 */
const auditSearchSchema = z.object({
  ...overviewRangeSearchFields,
  ...executionSortSearchFields,
  tab: z.enum(['overview', 'details']).optional().catch(undefined),
  userName: z.string().min(1).optional().catch(undefined),
})

// 标签、时间范围、按人筛选与排序都存在查询参数里，退回报表、刷新与分享链接都还原同一屏。
export const Route = createFileRoute('/_shell/audit')({
  beforeLoad: requireGovernor,
  component: AuditPage,
  validateSearch: auditSearchSchema,
})

/** 两个标签共用一个时间范围；按人筛选与排序只在清单里用。 */
function AuditPage() {
  const search = Route.useSearch()
  const { tab = 'overview' } = search
  const navigate = Route.useNavigate()
  // 按任务执行次数滚到底自动翻页，要以整页的滚动容器为准。
  const mainRef = useRef<HTMLElement>(null)
  const getScrollElement = useCallback(() => mainRef.current, [])
  const directory = useUsersDirectory(true)
  const range = overviewRangeFromSearch(search)
  const userName = search.userName ?? null
  const sort = executionSortFromSearch(search)
  // 改一项时其余原样带上。
  const navigateWith = (next: {
    range?: OverviewRange
    tab?: TabValue
    userName?: string | null
    sort?: ExecutionSort
  }) =>
    void navigate({
      replace: true,
      search: {
        ...overviewRangeToSearch(next.range ?? range),
        ...executionSortToSearch(next.sort ?? sort),
        tab: next.tab === undefined ? search.tab : next.tab === 'overview' ? undefined : next.tab,
        userName: (next.userName === undefined ? userName : next.userName) ?? undefined,
      },
    })

  // 报表按上游归属的用户名归人，显示名按用户名查。
  const nameOf = directory.nameOfUsername

  // 总览是默认标签，不写进地址。
  const selectTab = (value: string) =>
    navigateWith({ tab: TABS.find((item) => item.value === value)?.value ?? 'overview' })

  return (
    <main
      aria-label="审计"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-dashboard-bg"
      ref={mainRef}
    >
      {/* 预留应用壳中侧栏展开按钮的空间。 */}
      <div className="mx-auto flex w-full max-w-360 flex-col gap-5 px-4 pt-12 pb-14 sm:px-8">
        <TabsRoot className="flex flex-col gap-4" onValueChange={selectTab} value={tab}>
          <header className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-baseline gap-2.5">
              <h1 className="text-title-lg font-semibold tracking-tight text-on-surface">审计</h1>
              {tab === 'overview' ? <OverviewAsOf range={range} /> : null}
            </div>
            <TabsList aria-label="审计内容" className="h-8">
              {TABS.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </header>

          <TabsContent className="flex flex-col ui-focus" value="overview">
            <OverviewPanel
              nameOf={nameOf}
              onRangeChange={(next) => navigateWith({ range: next })}
              range={range}
            />
          </TabsContent>
          <TabsContent className="flex flex-col ui-focus" value="details">
            <DetailsPanel
              getScrollElement={getScrollElement}
              nameOf={nameOf}
              onRangeChange={(next) => navigateWith({ range: next })}
              onSortChange={(next) => navigateWith({ sort: next })}
              onUserNameChange={(next) => navigateWith({ userName: next })}
              range={range}
              sort={sort}
              userName={userName}
            />
          </TabsContent>
        </TabsRoot>
      </div>
    </main>
  )
}
