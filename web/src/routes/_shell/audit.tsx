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

const auditSearchSchema = z.object({
  ...overviewRangeSearchFields,
  ...executionSortSearchFields,
  tab: z.enum(['overview', 'details']).optional().catch(undefined),
  userName: z.string().min(1).optional().catch(undefined),
})

export const Route = createFileRoute('/_shell/audit')({
  beforeLoad: requireGovernor,
  component: AuditPage,
  validateSearch: auditSearchSchema,
})

function AuditPage() {
  const search = Route.useSearch()
  const { tab = 'overview' } = search
  const navigate = Route.useNavigate()
  const mainRef = useRef<HTMLElement>(null)
  const getScrollElement = useCallback(() => mainRef.current, [])
  const directory = useUsersDirectory(true)
  const range = overviewRangeFromSearch(search)
  const userName = search.userName ?? null
  const sort = executionSortFromSearch(search)
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

  const nameOf = directory.nameOfUsername

  const selectTab = (value: string) =>
    navigateWith({ tab: TABS.find((item) => item.value === value)?.value ?? 'overview' })

  return (
    <main
      aria-label="审计"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-dashboard-bg"
      ref={mainRef}
    >
      <div className="mx-auto flex w-full max-w-(--layout-list-page-max) flex-col gap-5 px-4 pt-12 pb-14 sm:px-(--layout-list-page-gutter)">
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
