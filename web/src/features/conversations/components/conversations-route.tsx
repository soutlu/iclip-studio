/** 全平台对话列表：筛选由服务端执行，条件存在地址栏由路由层下发，状态与总数由应用壳的全局订阅刷新。 */

import { useCallback, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { errorMessageOf } from '@/shared/api/client'
import { userPickerSourceOf, useUsersDirectory } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import type { TaskPreview, TaskPreviewState } from '@/shared/lib/task-preview'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { ListEmpty, ListError, NextPageFooter } from '@/shared/ui/list-state'
import { StatusBadge } from '@/shared/ui/status-badge'
import { Tag } from '@/shared/ui/tag'
import { useAuditConversations, type AuditConversation, type AuditFilters } from '../audit.api'
import { useConversationRows } from '../conversation-rows'
import { auditCoverUrl } from '../audit-cover'
import { conversationStatus } from '../conversation-status'
import { taskCellOf } from '../task-cell'
import { AuditFiltersBar } from './audit-filters'
import type { PickerSource } from '@/shared/ui/search-picker'

type ConversationsRouteProps = {
  /** 当前筛选条件与写回，由路由层落在查询参数上。 */
  filters: AuditFilters
  onFiltersChange: (next: AuditFilters) => void
  /** 在本页点开某段对话，供路由层记下从哪一屏进去的；新标签页打开不算。 */
  onOpen?: (conversationId: string) => void
  /** 需求单候选由路由层查询，feature 之间不直接互引；null 表示当前账号没有 tasks:read 权限。 */
  tasks: PickerSource | null
  taskPreviews: ReadonlyMap<string, TaskPreview>
  taskPreviewState: TaskPreviewState
  taskPreviewRetry?: () => void
}

export function ConversationsRoute({
  filters,
  onFiltersChange,
  onOpen,
  tasks,
  taskPreviews,
  taskPreviewState,
  taskPreviewRetry,
}: ConversationsRouteProps) {
  const mainRef = useRef<HTMLElement>(null)
  const getScrollElement = useCallback(() => mainRef.current, [])
  const directory = useUsersDirectory(true)
  const users = userPickerSourceOf(directory, 'id')
  const query = useAuditConversations(filters, true)
  // 成员与顺序取这一页的查询，行取池里的当前值；带墓碑的筛选下保留刚删的那行，等重拉换上带 deletedAt 的。
  const rows = useConversationRows(query.data?.pages.flatMap((page) => page.items) ?? [], {
    keepDeleted: filters.deleted !== 'live',
  })
  const latest = query.data?.pages.at(-1)
  const totals =
    latest === undefined ? undefined : { runningTotal: latest.runningTotal, total: latest.total }
  const taskLabels = new Map((tasks?.options ?? []).map((task) => [task.id, task.label]))

  return (
    <main
      aria-label="全部任务"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface-container-lowest"
      ref={mainRef}
    >
      {/* 预留应用壳中侧栏展开按钮的空间。 */}
      <div className="mx-auto flex w-full max-w-(--layout-list-page-max) flex-col px-4 pt-12 pb-8 sm:px-(--layout-list-page-gutter) md:pb-10">
        <h1 className="mb-4 text-headline font-semibold text-on-surface md:mb-5">全部任务</h1>
        <AuditFiltersBar
          filters={filters}
          onChange={onFiltersChange}
          tasks={tasks}
          totals={totals}
          users={users}
        />

        {taskPreviewState === 'error' ? (
          <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 text-body text-error">
            <span>部分需求单读取失败，已读取的内容仍可查看</span>
            <Button onClick={taskPreviewRetry} size="md" variant="ghost">
              重新读取需求单
            </Button>
          </div>
        ) : null}
        <section aria-label="任务列表" className="mt-4 flex flex-col lg:mt-6">
          {query.isPending ? (
            <AuditSkeleton />
          ) : query.isError ? (
            <ListError
              message={errorMessageOf(query.error, '读取全部任务失败')}
              onRetry={() => void query.refetch()}
            />
          ) : rows.length === 0 ? (
            <ListEmpty>暂无符合筛选条件的任务</ListEmpty>
          ) : (
            <>
              <ColumnHeader />
              <ul className="audit-rows">
                {rows.map((conversation) => (
                  <AuditRow
                    conversation={conversation}
                    key={conversation.id}
                    onOpen={onOpen}
                    ownerName={directory.nameOf(conversation.ownerUserId)}
                    taskPreviewState={taskPreviewState}
                    taskPreview={
                      conversation.taskId === null
                        ? undefined
                        : taskPreviews.get(conversation.taskId)
                    }
                    taskLabel={
                      conversation.taskId === null ? undefined : taskLabels.get(conversation.taskId)
                    }
                  />
                ))}
              </ul>
            </>
          )}

          {totals !== undefined && query.hasNextPage && rows.length > 0 ? (
            <NextPageFooter
              getScrollElement={getScrollElement}
              query={query}
              shown={rows.length}
              total={totals.total}
            />
          ) : null}
        </section>
      </div>
    </main>
  )
}

// 1280 起是五列表格加一列箭头：需求单列在 200–304px 之间伸缩，创作内容弹性、保底 280px。
// 更窄时收成卡片：封面占左侧两行，右边是标题和「需求单 · 属主」，状态与时间另起一整行。
// 卡片里的几块靠 display: contents 在表格下拆成各自的列，所以下面几组类名要一起改。
const COLUMNS_CLASS =
  'lg:grid-cols-[minmax(280px,1fr)_minmax(200px,304px)_120px_112px_72px_16px] lg:gap-x-5'

const ROW_CLASS = cn(
  '-mx-2 grid grid-cols-[56px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 rounded-md px-2 py-3.5 md:mx-0 md:p-3',
  COLUMNS_CLASS,
)
const CONTENT_CLASS = 'contents lg:flex lg:min-w-0 lg:items-center lg:gap-4'
const COVER_CLASS = 'col-start-1 row-span-2 row-start-1 size-14 shrink-0 rounded-md lg:size-16'
const TEXT_CLASS = 'col-start-2 row-start-1 flex min-w-0 flex-col gap-0.5 self-end lg:self-auto'
const META_CLASS =
  'col-start-2 row-start-2 flex min-w-0 items-center gap-1.5 self-start lg:contents'
const FOOT_CLASS =
  'col-span-2 row-start-3 mt-2 flex min-w-0 items-center justify-between gap-3 lg:contents'

function ColumnHeader() {
  return (
    <div
      aria-hidden
      className={cn(
        'hidden border-b border-hairline px-3 pb-2.5 text-label font-medium text-on-surface-faint lg:grid',
        COLUMNS_CLASS,
      )}
    >
      <span>创作内容</span>
      <span>关联需求单</span>
      <span>属主</span>
      <span>当前状态</span>
      <span>建立时间</span>
      <span />
    </div>
  )
}

type AuditRowProps = {
  conversation: AuditConversation
  onOpen: ((conversationId: string) => void) | undefined
  ownerName: string | undefined
  taskLabel: string | undefined
  taskPreview: TaskPreview | undefined
  taskPreviewState: TaskPreviewState
}

function AuditRow({
  conversation,
  onOpen,
  ownerName,
  taskLabel,
  taskPreview,
  taskPreviewState,
}: AuditRowProps) {
  const owner = ownerName ?? '未知用户'
  const status = conversationStatus(conversation.activity)
  const deleted = conversation.deletedAt !== null
  const taskName = taskCellOf(conversation.taskId, taskPreview, taskLabel, taskPreviewState)
  const cover = auditCoverUrl(conversation, taskPreview, taskPreviewState)
  return (
    <li>
      <Link
        className={cn('group ui-state text-on-surface ui-focus', ROW_CLASS)}
        onClick={(event) => {
          // 修饰键打开新标签页时，不改变当前页面的返回位置。
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          onOpen?.(conversation.id)
        }}
        params={{ conversationId: conversation.id }}
        to="/c/$conversationId"
      >
        <span className={CONTENT_CLASS}>
          <AuditCover
            deleted={deleted}
            key={cover ?? 'none'}
            title={conversation.title}
            url={cover}
          />
          <span className={TEXT_CLASS}>
            <span
              className={cn(
                'line-clamp-2 text-title font-semibold lg:line-clamp-1',
                deleted && 'text-on-surface-muted',
              )}
              title={conversation.title}
            >
              {conversation.title}
            </span>
            {conversation.deletedAt === null ? null : (
              <span className="inline-flex items-center gap-1 text-label text-on-surface-muted">
                <Icon decorative name="delete" size="sm" />
                <time
                  dateTime={conversation.deletedAt}
                  title={new Date(conversation.deletedAt).toLocaleString('zh-CN')}
                >
                  已删除 · {formatRelativeTime(conversation.deletedAt)}
                </time>
              </span>
            )}
          </span>
        </span>

        <span className={META_CLASS}>
          <span
            className={cn(
              'flex min-w-0 flex-[0_1_auto] items-center gap-1 text-label lg:block lg:text-body',
              conversation.taskId === null ? 'text-on-surface-faint' : 'text-on-surface-variant',
            )}
          >
            <Icon className="text-on-surface-faint lg:hidden" decorative name="task" size="xs" />
            <span
              className="min-w-0 truncate text-pretty lg:line-clamp-2 lg:whitespace-normal"
              title={conversation.taskId === null ? undefined : taskName}
            >
              {taskName}
              {/* 卡片里没有列名，得说清是没关联需求单。 */}
              {conversation.taskId === null ? <span className="lg:sr-only">需求单</span> : null}
            </span>
          </span>
          <span aria-hidden className="text-on-surface-faint lg:hidden">
            ·
          </span>
          <span className="flex max-w-[45%] min-w-0 flex-none items-center gap-1.5 text-label text-on-surface-variant lg:max-w-none lg:gap-2 lg:text-body">
            <span
              aria-hidden
              className="grid size-4.5 shrink-0 place-items-center rounded-full bg-surface-container-high text-caption font-semibold text-on-surface lg:size-6"
            >
              {owner.trim().charAt(0).toUpperCase()}
            </span>
            <span className="truncate" title={owner}>
              {owner}
            </span>
          </span>
        </span>

        <span className={FOOT_CLASS}>
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 lg:flex-col lg:flex-nowrap lg:items-start lg:gap-1.5">
            {status === 'idle' ? (
              // 从没跑过没有对应的角标，这一列仍要说出来。
              <span className="text-body whitespace-nowrap text-on-surface-faint">
                暂无运行记录
              </span>
            ) : (
              <StatusBadge appearance="label" kind="conversation" status={status} />
            )}
            {conversation.activity.videoGeneration === 'none' ? null : (
              <StatusBadge
                appearance="label"
                kind="video"
                status={conversation.activity.videoGeneration}
              />
            )}
            {conversation.completedAt === null ? null : <Tag variant="soft">属主已收尾</Tag>}
          </span>
          <time
            className="text-label whitespace-nowrap text-on-surface-faint tabular-nums lg:text-body lg:text-on-surface-muted"
            dateTime={conversation.createdAt}
            title={new Date(conversation.createdAt).toLocaleString('zh-CN')}
          >
            {formatRelativeTime(conversation.createdAt)}
          </time>
        </span>

        <Icon
          className="hidden -translate-x-1 -rotate-90 text-on-surface-faint opacity-0 transition-[opacity,translate] ui-motion-s group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100 lg:block"
          decorative
          name="expand"
          size="sm"
        />
      </Link>
    </li>
  )
}

/** 方框裁切铺满、居中，细描边压在图上；没有图或读不出来时只有中性底上的一个淡图标。 */
function AuditCover({
  deleted,
  title,
  url,
}: {
  deleted: boolean
  title: string
  url: string | null
}) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  return (
    <span
      className={cn(
        COVER_CLASS,
        'relative grid place-items-center overflow-hidden bg-surface-container-low after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:inset-ring after:inset-ring-hairline',
      )}
    >
      {url === null || failed ? (
        <Icon className="text-outline-variant" decorative name="image" size="lg" />
      ) : (
        <img
          alt={`${title}的封面`}
          className={cn(
            'size-full object-cover transition-opacity ui-motion-l',
            deleted && 'grayscale',
            !loaded ? 'opacity-0' : deleted && 'opacity-50',
          )}
          decoding="async"
          loading="lazy"
          onError={() => setFailed(true)}
          onLoad={() => setLoaded(true)}
          src={url}
        />
      )}
    </span>
  )
}

// 骨架几行的标题与需求单占位长短错开，看着像真列表。
const SKELETONS = [
  { id: 'a', title: 'w-5/12', task: 'w-3/4' },
  { id: 'b', title: 'w-1/3', task: 'w-2/3' },
  { id: 'c', title: 'w-1/2', task: 'w-4/5' },
  { id: 'd', title: 'w-1/3', task: 'w-3/5' },
  { id: 'e', title: 'w-5/12', task: 'w-3/4' },
  { id: 'f', title: 'w-2/5', task: 'w-2/3' },
] as const

const BAR_CLASS = 'rounded-xs bg-surface-container-low'

/** 首屏读取：沿用行的网格画几行灰条，读屏只听到状态文字。 */
function AuditSkeleton() {
  return (
    <>
      <ColumnHeader />
      <p className="sr-only" role="status">
        正在读取全部任务
      </p>
      <ul aria-hidden className="audit-rows motion-safe:animate-pulse">
        {SKELETONS.map(({ id, title, task }) => (
          <li key={id}>
            <div className={ROW_CLASS}>
              <span className={CONTENT_CLASS}>
                <span className={cn(COVER_CLASS, 'bg-surface-container-low')} />
                <span className={cn(TEXT_CLASS, 'flex-1')}>
                  <span className={cn(BAR_CLASS, 'h-4', title)} />
                </span>
              </span>
              <span className={META_CLASS}>
                <span className={cn(BAR_CLASS, 'h-3', task)} />
                <span className="flex items-center gap-1.5 lg:gap-2">
                  <span className="size-4.5 shrink-0 rounded-full bg-surface-container-low lg:size-6" />
                  <span className={cn(BAR_CLASS, 'h-3 w-16')} />
                </span>
              </span>
              <span className={FOOT_CLASS}>
                <span className="h-5 w-16 rounded-full bg-surface-container-low" />
                <span className={cn(BAR_CLASS, 'h-3 w-11')} />
              </span>
              <span className="hidden lg:block" />
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
