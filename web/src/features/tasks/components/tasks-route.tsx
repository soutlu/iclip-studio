import { useCallback, useId, useRef, useState, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import { ListEmpty, ListError, LoadMoreFooter, NextPageFooter } from '@/shared/ui/list-state'
import type { TaskCreationStarter } from '../task-creation'
import { canEditTaskField } from '../task-permissions'
import { useTasksPages, type Task } from '../tasks.api'
import { RenameTaskDialog } from './rename-task-dialog'
import { TaskCard } from './task-card'
import { TaskCardSkeletons } from './task-card-skeletons'
import { TaskDialog } from './task-dialog'
import { TaskHero } from './task-hero'

/** 路由负责登录守卫；我的需求单由 claimedBy=me 筛选，认领身份由服务端解析。 */
type TasksRouteProps = {
  creation?: TaskCreationStarter
  relatedContent?: (taskId: string) => ReactNode
}

export function TasksRoute({ creation, relatedContent }: TasksRouteProps = {}) {
  const { data: user } = useUser()
  const mainRef = useRef<HTMLElement>(null)
  const getScrollElement = useCallback(() => mainRef.current, [])
  const myTasksId = useId()
  const [keyword, setKeyword] = useState('')
  const [myTasksExpanded, setMyTasksExpanded] = useState(false)
  const [dialog, setDialog] = useState<{ open: boolean; taskId?: string }>({ open: false })
  const [rename, setRename] = useState<{ open: boolean; task?: Task }>({ open: false })

  const myTasks = useTasksPages('mine', Boolean(user))
  const allTasks = useTasksPages('all', Boolean(user))
  const loadedMine = myTasks.data?.pages.flatMap((page) => page.items) ?? []
  const loadedAll = allTasks.data?.pages.flatMap((page) => page.items) ?? []

  // 搜索只在已读取的页里筛；还有下一页时页脚说明已读取了多少。
  const filter = (items: Task[]): Task[] => {
    const kw = keyword.trim().toLowerCase()
    return kw ? items.filter((task) => task.title.toLowerCase().includes(kw)) : items
  }

  const mine = filter(loadedMine)
  const all = filter(loadedAll)
  const searching = keyword.trim().length > 0
  // 收起时只放网格的一行；列数未知（网格尚未排版）时不收起。
  const [myColumns, myGridRef] = useGridColumnCount()
  const collapsible = !searching && myColumns > 0 && mine.length > myColumns
  const collapsed = collapsible && !myTasksExpanded
  const visibleMine = collapsed ? mine.slice(0, myColumns) : mine

  const canWrite = hasPermission(user, PERMISSION.tasksWrite)
  // 重命名与详情弹窗改标题同一条规则。
  const renameProps = (task: Task) =>
    canEditTaskField(user, task, 'title') ? { onRename: () => setRename({ open: true, task }) } : {}

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto" ref={mainRef}>
      {/* 页头预留侧栏展开按钮的覆盖空间。 */}
      <div className="flex w-full flex-col gap-8 px-6 pt-12 pb-10">
        <header className="flex items-center justify-between gap-6">
          <div className="flex min-w-0 flex-1 flex-col gap-5">
            <div>
              <h1 className="text-headline font-semibold text-on-surface">需求单</h1>
              <p className="mt-3 text-body text-on-surface-variant">多人协同，打造超级团队</p>
            </div>
            {/* 搜索同时筛两个分区，放在页头；放不下时整条换到按钮下一行。 */}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={!canWrite}
                leadingIcon="add"
                onClick={() => setDialog({ open: true })}
                size="md"
                variant="inverted"
              >
                新建需求单
              </Button>
              <div className="min-w-0 grow basis-40 sm:max-w-60">
                <Input
                  aria-label="搜索需求单"
                  leadingIcon="search"
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索需求单"
                  value={keyword}
                  wrapperClassName="h-(--control-height-md) rounded-sm border-border"
                />
              </div>
            </div>
          </div>
          <TaskHero className="h-40 w-auto shrink-0 max-md:hidden" />
        </header>

        <div className="flex flex-col gap-8">
          <section aria-label="我的需求单" className="flex flex-col gap-4">
            <h2 className="text-title-lg font-semibold text-on-surface">我的需求单</h2>
            {/* 翻页失败时 isError 也为真，已读取的卡片照常显示，错误只落在页脚。 */}
            {myTasks.isPending ? (
              <TaskCardSkeletons count={2} label="正在读取我的需求单" />
            ) : myTasks.isError && !myTasks.isFetchNextPageError ? (
              <ListError
                message={errorMessageOf(myTasks.error, '读取我的需求单失败')}
                onRetry={() => void myTasks.refetch()}
              />
            ) : mine.length === 0 ? (
              <ListEmpty>{searching ? '暂无匹配的需求单' : '暂无已认领的需求单'}</ListEmpty>
            ) : (
              <div className="grid-task-cards" id={myTasksId} ref={myGridRef}>
                {visibleMine.map((task) => (
                  <TaskCard
                    key={task.id}
                    onClick={() => setDialog({ open: true, taskId: task.id })}
                    task={task}
                    {...renameProps(task)}
                  />
                ))}
              </div>
            )}
            {collapsible && (
              <div className="flex pt-2">
                <Button
                  aria-controls={myTasksId}
                  aria-expanded={myTasksExpanded}
                  className="rounded-full px-6"
                  onClick={() => setMyTasksExpanded((expanded) => !expanded)}
                  size="md"
                  trailingIcon={myTasksExpanded ? 'collapse' : 'expand'}
                  variant="outlined"
                >
                  {myTasksExpanded ? '收起' : '展开更多'}
                </Button>
              </div>
            )}
            {/* 收起时只看一行，翻页入口等已读取的卡片全部可见时再出现，不和「展开更多」挤在一起。
                重试翻页期间 isFetchNextPageError 仍为真，这时换回页脚显示「正在读取…」。 */}
            {!collapsed && myTasks.hasNextPage ? (
              myTasks.isFetchNextPageError && !myTasks.isFetchingNextPage ? (
                <ListError
                  message={errorMessageOf(myTasks.error, '读取我的需求单失败')}
                  onRetry={() => void myTasks.fetchNextPage()}
                />
              ) : (
                <LoadMoreFooter
                  isFetching={myTasks.isFetchingNextPage}
                  label="展开显示更多需求单"
                  onMore={() => void myTasks.fetchNextPage()}
                  shown={loadedMine.length}
                  total={myTasks.data?.pages.at(-1)?.total}
                />
              )
            ) : null}
          </section>

          <section aria-label="全部需求单" className="flex flex-col gap-4">
            <h2 className="text-title-lg font-semibold text-on-surface">全部需求单</h2>
            {allTasks.isPending ? (
              <TaskCardSkeletons count={6} label="正在读取全部需求单" />
            ) : allTasks.isError && !allTasks.isFetchNextPageError ? (
              <ListError
                message={errorMessageOf(allTasks.error, '读取需求单列表失败')}
                onRetry={() => void allTasks.refetch()}
              />
            ) : all.length === 0 ? (
              <ListEmpty>{searching ? '暂无匹配的需求单' : '暂无需求单'}</ListEmpty>
            ) : (
              <div className="grid-task-cards">
                {all.map((task) => (
                  <TaskCard
                    key={task.id}
                    onClick={() => setDialog({ open: true, taskId: task.id })}
                    task={task}
                  />
                ))}
              </div>
            )}
            {allTasks.hasNextPage ? (
              allTasks.isFetchNextPageError && !allTasks.isFetchingNextPage ? (
                <ListError
                  message={errorMessageOf(allTasks.error, '读取需求单列表失败')}
                  onRetry={() => void allTasks.fetchNextPage()}
                />
              ) : (
                <NextPageFooter
                  getScrollElement={getScrollElement}
                  query={allTasks}
                  shown={loadedAll.length}
                  total={allTasks.data?.pages.at(-1)?.total}
                />
              )
            ) : null}
          </section>
        </div>
      </div>

      <TaskDialog
        creation={creation}
        relatedContent={relatedContent}
        onOpenChange={(open) => setDialog((prev) => ({ ...prev, open }))}
        open={dialog.open}
        taskId={dialog.taskId}
      />
      <RenameTaskDialog
        onOpenChange={(open) => setRename((prev) => ({ ...prev, open }))}
        open={rename.open}
        task={rename.task}
      />
    </main>
  )
}

/** 挂上网格后读出它实际排出的列数，随网格尺寸变化更新；读不到已排版的列轨道时为 0。
 *  列数由 CSS 决定，这里不复刻卡宽、间距与断点。 */
function useGridColumnCount() {
  const [columns, setColumns] = useState(0)
  const gridRef = useCallback((grid: HTMLElement | null) => {
    if (!grid) return
    const measure = () => {
      // 排过版的网格逐条报出轨道像素宽；未排版时退回声明值（或 none），按未知处理。
      const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ')
      setColumns(tracks.every((track) => /^\d+(?:\.\d+)?px$/.test(track)) ? tracks.length : 0)
    }
    // 挂载时在提交阶段同步量一次，首帧就按一行绘制；ResizeObserver 的回调赶不上首帧。
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [])
  return [columns, gridRef] as const
}
