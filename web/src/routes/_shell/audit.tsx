import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useRef, useState } from 'react'
import {
  AnomaliesPanel,
  AuditScopeBar,
  ConversationsPanel,
  OverviewAsOf,
  OverviewPanel,
  overviewRangeFromSearch,
  overviewRangeToSearch,
  useAuditAnomalies,
  useAuditConversationReports,
  type AnomalyKind,
  type AuditScope,
  type OverviewRange,
} from '@/features/audit'
import { userPickerSourceOf, useUsersDirectory } from '@/shared/auth'
import { cn } from '@/shared/lib/utils'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import { auditSearchSchema, scopeFromSearch, searchFromScope } from '../-audit-search'
import { requireGovernor } from '../-require-governor'
import { useAuditTaskPreviews } from '../-use-audit-task-previews'
import { useTaskPickerSource } from '../-use-task-picker-source'

const TABS = [
  { value: 'overview', label: '总览' },
  { value: 'conversations', label: '对话明细' },
  { value: 'anomalies', label: '异常' },
] as const

type TabValue = (typeof TABS)[number]['value']

// 标签与筛选范围都存在查询参数里，退回报表、刷新与分享链接都还原同一屏。
export const Route = createFileRoute('/_shell/audit')({
  beforeLoad: requireGovernor,
  component: AuditPage,
  validateSearch: auditSearchSchema,
})

/**
 * 总览只按时间看全体，有自己的时间范围；对话明细与异常共用一份带人和需求单的筛选。
 * 人和需求单的候选在路由层取，feature 之间不互引。
 */
function AuditPage() {
  const search = Route.useSearch()
  const { tab = 'overview' } = search
  const navigate = Route.useNavigate()
  // 两张明细表滚到底自动翻页，要以整页的滚动容器为准。
  const mainRef = useRef<HTMLElement>(null)
  const getScrollElement = useCallback(() => mainRef.current, [])
  const taskSource = useTaskPickerSource()
  const directory = useUsersDirectory(true)
  const scope = scopeFromSearch(search)
  const overviewRange = overviewRangeFromSearch(search)
  // 改一份筛选时另一份与当前标签原样带上。
  const navigateWith = (next: { scope?: AuditScope; overview?: OverviewRange; tab?: TabValue }) =>
    void navigate({
      replace: true,
      search: {
        ...searchFromScope(next.scope ?? scope),
        ...overviewRangeToSearch(next.overview ?? overviewRange),
        tab: next.tab === undefined ? search.tab : next.tab === 'overview' ? undefined : next.tab,
      },
    })

  // 报表按上游归属的用户名归人，候选的 id 与显示名都按用户名查。
  const userSource = userPickerSourceOf(directory, 'username')
  const nameOf = directory.nameOfUsername

  // 切标签不动筛选范围；总览是默认标签，不写进地址。
  const selectTab = (value: string) =>
    navigateWith({ tab: TABS.find((item) => item.value === value)?.value ?? 'overview' })

  return (
    <main
      aria-label="审计"
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-y-auto',
        // 总览是看板：内容区铺浅灰、卡片浮起；明细与异常两个标签仍是原来的白底。
        tab === 'overview' ? 'bg-dashboard-bg' : 'bg-surface-container-lowest',
      )}
      ref={mainRef}
    >
      {/* 预留应用壳中侧栏展开按钮的空间。 */}
      <div className="mx-auto flex w-full max-w-360 flex-col gap-5 px-4 pt-12 pb-14 sm:px-8">
        <TabsRoot className="flex flex-col gap-4" onValueChange={selectTab} value={tab}>
          <header className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-baseline gap-2.5">
              <h1 className="text-title-lg font-semibold tracking-tight text-on-surface">审计</h1>
              {tab === 'overview' ? <OverviewAsOf range={overviewRange} /> : null}
            </div>
            <TabsList aria-label="审计内容" className="h-8">
              {TABS.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </header>

          {tab === 'overview' ? null : (
            <AuditScopeBar
              onChange={(next) => navigateWith({ scope: next })}
              scope={scope}
              tasks={taskSource}
              users={userSource}
            />
          )}

          <TabsContent className="flex flex-col ui-focus" value="overview">
            <OverviewPanel
              nameOf={nameOf}
              onRangeChange={(next) => navigateWith({ overview: next })}
              range={overviewRange}
            />
          </TabsContent>
          <TabsContent className="flex flex-col ui-focus" value="conversations">
            <ConversationsTab getScrollElement={getScrollElement} nameOf={nameOf} scope={scope} />
          </TabsContent>
          <TabsContent className="flex flex-col ui-focus" value="anomalies">
            <AnomaliesTab getScrollElement={getScrollElement} nameOf={nameOf} scope={scope} />
          </TabsContent>
        </TabsRoot>
      </div>
    </main>
  )
}

type TabProps = {
  scope: AuditScope
  nameOf: (userName: string) => string | undefined
  getScrollElement: () => HTMLElement | null
}

/**
 * 按列表已读到的每页行批量取需求单标题，一页一个请求；取不到的由面板退回占位字。
 *
 * 不借选择器候选：那只有最近一页需求单，挂在更早需求单上的行会拿不到标题。
 */
const useTaskTitleOf = (
  pages: readonly { items: readonly { taskId: string | null }[] }[] | undefined,
) => {
  const { taskPreviews } = useAuditTaskPreviews(
    (pages ?? []).map((page) =>
      page.items.flatMap((row) => (row.taskId === null ? [] : [row.taskId])),
    ),
  )
  return (taskId: string) => taskPreviews.get(taskId)?.title
}

// 标签与面板读同一个查询键，这里只为拿到行上的 taskId，不多发请求。
function ConversationsTab({ scope, nameOf, getScrollElement }: TabProps) {
  const reports = useAuditConversationReports(scope)
  const taskTitleOf = useTaskTitleOf(reports.data?.pages)
  return (
    <ConversationsPanel
      getScrollElement={getScrollElement}
      nameOf={nameOf}
      scope={scope}
      taskTitleOf={taskTitleOf}
    />
  )
}

function AnomaliesTab({ scope, nameOf, getScrollElement }: TabProps) {
  const [kinds, setKinds] = useState<AnomalyKind[]>([])
  const anomalies = useAuditAnomalies(scope, kinds)
  const taskTitleOf = useTaskTitleOf(anomalies.data?.pages)
  return (
    <AnomaliesPanel
      getScrollElement={getScrollElement}
      kinds={kinds}
      nameOf={nameOf}
      onKindsChange={setKinds}
      scope={scope}
      taskTitleOf={taskTitleOf}
    />
  )
}
