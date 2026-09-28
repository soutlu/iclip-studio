import { DndContext, PointerSensor, useDroppable, useSensor } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import {
  CollectionDeleteDialog,
  CollectionFormDialog,
  useCollections,
} from '@/features/collections'
import {
  ConversationDeleteDialog,
  ConversationMembershipDialog,
  conversationListStateSchema,
  refreshConversationLists,
  SidebarConversationRow,
  SIDEBAR_ROW_CLASS,
  SIDEBAR_ROW_MENU_OPEN,
  SIDEBAR_ROW_TITLE_CLASS,
  SIDEBAR_ROW_TRAILING_HIDDEN,
  SIDEBAR_ROW_TRAILING_SHOWN,
  useMoreConversations,
  useRecordOpenedConversation,
  useSetConversationMembership,
  useSidebarTopology,
  type Conversation,
  type ConversationListState,
  type ConversationPage,
  type SidebarCollection,
} from '@/features/conversations'
import { tasksQueryKeys, useTaskOptions } from '@/features/tasks'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { Icon, type IconName } from '@/shared/icons'
import { groupByRecency, RECENCY_LABEL } from '@/shared/lib/recency-group'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { MenuItem, MenuRoot, MenuSeparator, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'

// 合集默认只露前几个，其余收在「全部合集」里；后端最多返回 100 个合集。
const COLLECTIONS_PREVIEW = 3

// 任务区使用固定落点 ID，合集使用自身 UUID。
const UNGROUPED = 'ungrouped'

/** 改对话（重命名、删除、拖动归属）要有 agent:run；用到的组件自己读，不逐层传。 */
const useCanWrite = () => hasPermission(useUser().data, PERMISSION.agentRun)

/** 此刻，每到本地零点刷新一次：时间分组只看日历日，侧栏开着过夜也会跟着换组。 */
const useNowByDay = (): Date => {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const timer = window.setTimeout(() => setNow(new Date()), midnight.getTime() - now.getTime())
    return () => window.clearTimeout(timer)
  }, [now])
  return now
}

/**
 * 任务区和合集内容使用服务端分页，合集列表在前端收起；拖动改归属后由 mutation 刷新拓扑。
 * 登录态的加载与失败由应用侧栏处理，它只在登录身份就绪后渲染这里。
 */
export function SidebarConversations() {
  const queryClient = useQueryClient()
  const user = useUser().data
  const canRead = hasPermission(user, PERMISSION.agentRead)
  const canWrite = useCanWrite()
  const canManageCollections = hasPermission(user, PERMISSION.collectionsWrite)
  const canReadCollections = hasPermission(user, PERMISSION.collectionsRead)
  const canReadTasks = hasPermission(user, PERMISSION.tasksRead)
  const [state, setState] = useState<ConversationListState>('all')
  const topology = useSidebarTopology(canRead, state)
  useRecordOpenedConversation(topology.data)
  const [allCollectionsShown, setAllCollectionsShown] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)

  const [collectionForm, setCollectionForm] = useState<{
    collection?: { id: string; name: string }
    open: boolean
  }>({ open: false })
  const [collectionDelete, setCollectionDelete] = useState<{
    collection?: { id: string; name: string }
    open: boolean
  }>({ open: false })
  const [membership, setMembership] = useState<{
    conversation?: Conversation
    open: boolean
  }>({ open: false })
  // 删除确认由这里持有：删掉后那一行随列表刷新消失，弹窗仍能正常收起。
  const [conversationDelete, setConversationDelete] = useState<{
    conversation?: Conversation
    open: boolean
  }>({ open: false })
  const openMembership = (conversation: Conversation) => setMembership({ conversation, open: true })
  const confirmDelete = (conversation: Conversation) =>
    setConversationDelete({ conversation, open: true })

  const collections = useCollections(membership.open && canReadCollections)
  const tasks = useTaskOptions(membership.open && canReadTasks)

  // 合集的增删改只刷新合集自己的查询，侧栏拓扑由这里接着刷新。
  const refreshSidebar = () => void refreshConversationLists(queryClient, 'sidebar')

  /** 挂上需求单即认领（合同 §8），那张单会从「待认领」变「进行中」，列表与详情跟着刷新；对话列表由归属 mutation 自己刷新。 */
  const refreshClaimedTasks = () => {
    void queryClient.invalidateQueries({ queryKey: tasksQueryKeys.all })
  }

  // 拖动只改合集归属，不碰需求单；对话列表由 mutation 自己刷新。
  const moveMutation = useSetConversationMembership()
  const pointer = useSensor(PointerSensor, { activationConstraint: { distance: 5 } })

  /** 在 document 上拦截拖动结束后指向原对话的一次 click；行可能已重建，行级监听无法可靠阻止误跳转。 */
  const swallowClickAfterDrag = (conversationId: string) => {
    document.addEventListener(
      'click',
      (event) => {
        const link = event.target instanceof Element ? event.target.closest('a') : null
        if (link?.getAttribute('href')?.endsWith(conversationId) !== true) return
        event.preventDefault()
        event.stopPropagation()
      },
      { capture: true, once: true },
    )
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null)
    swallowClickAfterDrag(String(active.id))
    if (!canWrite || !over) return
    const from = (active.data.current as { collectionId: string | null } | undefined)?.collectionId
    const to = over.id === UNGROUPED ? null : String(over.id)
    if (from === to) return
    moveMutation.mutate(
      { collectionId: to, conversationId: String(active.id) },
      { onError: () => toast.error('移动失败，请重试') },
    )
  }

  const allCollections: readonly SidebarCollection[] = topology.data?.collections ?? []
  const visibleCollections = allCollectionsShown
    ? allCollections
    : allCollections.slice(0, COLLECTIONS_PREVIEW)

  // 运行筛选的指示点仅取拓扑首页数据，额外分页由子组件持有。
  const anyBusy =
    (topology.data?.ungrouped.items ?? []).some((one) => one.activity.busy) ||
    allCollections.some((one) => one.page.items.some((row) => row.activity.busy))

  if (!canRead) return <SidebarFeedback>当前账号没有查看对话权限</SidebarFeedback>
  if (topology.isPending) return <SidebarFeedback>正在加载对话…</SidebarFeedback>
  if (topology.isError)
    return (
      <SidebarFeedback error loading={topology.isFetching} onRetry={() => void topology.refetch()}>
        {topology.error instanceof ApiError && topology.error.status === 403
          ? '当前账号没有查看对话权限'
          : errorMessageOf(topology.error, '读取对话列表失败，请重试')}
      </SidebarFeedback>
    )

  return (
    <DndContext
      onDragEnd={onDragEnd}
      onDragStart={({ active }) => setDragging(String(active.id))}
      sensors={[pointer]}
    >
      {/* 吸顶标题用 local 层级压住合集引导线，isolate 把这组层级限定在滚动区内。 */}
      <div className="isolate flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pt-4 pb-2 ui-state-subtle">
        <ChipGroup
          aria-label="对话筛选"
          // Radix 取消当前选项给空串，不在档位里的值一律忽略，筛选始终有值。
          onValueChange={(value) => {
            const parsed = conversationListStateSchema.safeParse(value)
            if (parsed.success) setState(parsed.data)
          }}
          type="single"
          value={state}
          variant="segmented"
        >
          <FilterChip value="all" variant="segmented">
            全部
          </FilterChip>
          <FilterChip value="open" variant="segmented">
            <span className="relative">
              未完成
              {/* 提示点不参与排版，运行状态变化时文字仍保持居中。 */}
              {anyBusy && (
                <span
                  aria-hidden
                  className="absolute top-1/2 -right-2 size-1.5 -translate-y-1/2 rounded-full bg-primary"
                />
              )}
            </span>
          </FilterChip>
          <FilterChip value="done" variant="segmented">
            已完成
          </FilterChip>
        </ChipGroup>

        <SidebarSection
          action={
            canManageCollections
              ? {
                  icon: 'add',
                  label: '新建合集',
                  onClick: () => setCollectionForm({ open: true }),
                }
              : undefined
          }
          title="合集"
        >
          {visibleCollections.map((collection) => (
            <CollectionGroup
              key={collection.id}
              canManage={canManageCollections}
              collection={collection}
              dragging={dragging}
              onDelete={() =>
                setCollectionDelete({
                  collection: { id: collection.id, name: collection.name },
                  open: true,
                })
              }
              onDeleteConversation={confirmDelete}
              onOpenMembership={openMembership}
              onRename={() =>
                setCollectionForm({
                  collection: { id: collection.id, name: collection.name },
                  open: true,
                })
              }
              state={state}
            />
          ))}
          {allCollections.length === 0 && <EmptyHint>还没有合集</EmptyHint>}
          {allCollections.length > COLLECTIONS_PREVIEW && (
            <button
              aria-expanded={allCollectionsShown}
              className={cn(
                SIDEBAR_ROW_CLASS,
                'w-full text-body-sm text-on-surface-faint ui-focus',
              )}
              onClick={() => setAllCollectionsShown((shown) => !shown)}
              type="button"
            >
              {/* 空出图标位，文字与合集名对齐。 */}
              <span aria-hidden className="size-(--icon-md) shrink-0" />
              {allCollectionsShown ? '收起合集' : '全部合集'}
            </button>
          )}
        </SidebarSection>

        <UngroupedSection
          dragging={dragging}
          onDeleteConversation={confirmDelete}
          onOpenMembership={openMembership}
          page={topology.data?.ungrouped ?? { items: [], nextCursor: null }}
          state={state}
        />
      </div>

      <CollectionFormDialog
        collection={collectionForm.collection}
        onOpenChange={(open) => setCollectionForm((prev) => ({ ...prev, open }))}
        onSaved={refreshSidebar}
        open={collectionForm.open}
      />
      <CollectionDeleteDialog
        collection={collectionDelete.collection}
        onDeleted={refreshSidebar}
        onOpenChange={(open) => setCollectionDelete((prev) => ({ ...prev, open }))}
        open={collectionDelete.open}
      />
      <ConversationDeleteDialog
        conversation={conversationDelete.conversation}
        onOpenChange={(open) => setConversationDelete((prev) => ({ ...prev, open }))}
        open={conversationDelete.open}
      />
      <ConversationMembershipDialog
        collectionUnavailable={
          !canReadCollections
            ? '当前账号没有查看合集权限'
            : collections.isPending
              ? '正在加载合集…'
              : collections.isError
                ? '读取合集失败，请重试'
                : undefined
        }
        taskUnavailable={
          !canReadTasks
            ? '当前账号没有查看需求单权限'
            : tasks.isPending
              ? '正在加载需求单…'
              : tasks.isError
                ? '读取需求单失败，请重试'
                : undefined
        }
        {...(canReadCollections && collections.isError
          ? { onRetryCollections: () => void collections.refetch() }
          : {})}
        {...(canReadTasks && tasks.isError ? { onRetryTasks: () => void tasks.refetch() } : {})}
        collectionOptions={(collections.data ?? []).map((item) => ({
          id: item.id,
          label: item.name,
        }))}
        conversation={membership.conversation}
        onOpenChange={(open) => setMembership((prev) => ({ ...prev, open }))}
        onSaved={refreshClaimedTasks}
        open={membership.open}
        taskOptions={tasks.data ?? []}
      />
    </DndContext>
  )
}

function UngroupedSection({
  dragging,
  onDeleteConversation,
  onOpenMembership,
  page,
  state,
}: {
  dragging: string | null
  onDeleteConversation: (conversation: Conversation) => void
  onOpenMembership: (conversation: Conversation) => void
  page: ConversationPage
  state: ConversationListState
}) {
  const canWrite = useCanWrite()
  const groupId = useId()
  const now = useNowByDay()
  const { isOver, setNodeRef } = useDroppable({ id: UNGROUPED, disabled: !canWrite })
  const more = useMoreConversations({ state }, page.nextCursor)
  const items = uniqueConversations([
    ...page.items,
    ...(more.data?.pages.flatMap((one) => one.items) ?? []),
  ])
  const hasMore = more.data ? more.hasNextPage : Boolean(page.nextCursor)
  // 服务端按建立时间倒序给，每个时间分组只连成一段，组名可以当 key。
  const groups = groupByRecency(items, (item) => item.createdAt, now)

  return (
    <div className={cn('rounded-sm', isOver && 'bg-surface-container-high')} ref={setNodeRef}>
      <SidebarSection title="任务">
        {groups.map(({ bucket, items: rows }) => (
          <div
            aria-labelledby={`${groupId}-${bucket}`}
            className="flex flex-col gap-px"
            key={bucket}
            role="group"
          >
            <p
              className="mt-2 flex h-6 items-center px-2.5 text-caption text-on-surface-faint"
              id={`${groupId}-${bucket}`}
            >
              {RECENCY_LABEL[bucket]}
            </p>
            {rows.map((conversation) => (
              <SidebarConversationRow
                key={conversation.id}
                conversation={conversation}
                dragging={dragging === conversation.id}
                onDelete={() => onDeleteConversation(conversation)}
                onOpenMembership={() => onOpenMembership(conversation)}
              />
            ))}
          </div>
        ))}
        {items.length === 0 && <EmptyHint>{emptyConversations(state)}</EmptyHint>}
        {hasMore && (
          <ExpandRow
            error={more.error}
            label="展开显示更多对话"
            retryLabel="重试加载更多对话"
            loading={more.isFetching}
            onExpand={() => void more.fetchNextPage()}
          />
        )}
      </SidebarSection>
    </div>
  )
}

type SidebarSectionProps = {
  action?: { icon: IconName; label: string; onClick: () => void } | undefined
  children: React.ReactNode
  title: string
}

function SidebarSection({ action, children, title }: SidebarSectionProps) {
  const [open, setOpen] = useState(true)
  return (
    <section className="flex flex-col gap-px">
      {/* group 供折叠箭头与新建钮在悬停、键盘聚焦时浮现。 */}
      <div className="group layer-local-1 sticky top-0 flex h-7 items-center gap-1 bg-background px-2.5">
        <button
          aria-expanded={open}
          className="flex min-w-0 cursor-pointer items-center gap-1 rounded-xs text-caption font-medium text-on-surface-faint ui-focus"
          onClick={() => setOpen((prev) => !prev)}
          type="button"
        >
          <span className="min-w-0 truncate text-left">{title}</span>
          <Icon
            className={cn(
              'shrink-0 opacity-0 transition ui-motion-s group-focus-within:opacity-100 group-hover:opacity-100',
              !open && '-rotate-90',
            )}
            decorative
            name="expand"
            size="xs"
          />
        </button>
        {action && (
          <div className={cn(SIDEBAR_ROW_TRAILING_SHOWN, 'ml-auto shrink-0 items-center')}>
            <IconButton
              label={action.label}
              name={action.icon}
              onClick={action.onClick}
              size="xs"
            />
          </div>
        )}
      </div>
      {open && <div className="flex flex-col gap-px">{children}</div>}
    </section>
  )
}

function EmptyHint({ children }: { children: string }) {
  return <p className="px-2.5 py-1 text-body-sm text-on-surface-faint">{children}</p>
}

function SidebarFeedback({
  children,
  error = false,
  loading = false,
  onRetry,
}: {
  children: string
  error?: boolean
  loading?: boolean
  onRetry?: () => void
}) {
  return (
    <div className="min-h-0 flex-1 px-2 pt-4">
      <p
        className={cn('px-2.5 text-body-sm', error ? 'text-error' : 'text-on-surface-faint')}
        role={error ? 'alert' : 'status'}
      >
        {children}
      </p>
      {onRetry && (
        <button
          className={cn(SIDEBAR_ROW_CLASS, 'mt-2 w-full ui-focus')}
          disabled={loading}
          onClick={onRetry}
          type="button"
        >
          {loading ? '重试中…' : '重新加载对话'}
        </button>
      )}
    </div>
  )
}

const emptyConversations = (state: ConversationListState) =>
  state === 'open'
    ? '没有未完成的对话'
    : state === 'done'
      ? '没有标记完成的对话'
      : state === 'running'
        ? '没有进行中的对话'
        : '还没有对话'

/** 页边界可因活动时间变化重叠，保留首页优先的第一条记录。 */
const uniqueConversations = (items: readonly Conversation[]): Conversation[] => {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

/** 分页失败保留已加载内容，并在原入口显示原因和重试。 */
function ExpandRow({
  error,
  label,
  loading = false,
  onExpand,
  retryLabel,
}: {
  error?: unknown
  label: string
  loading?: boolean
  onExpand: () => void
  retryLabel: string
}) {
  return (
    <>
      {error != null && (
        <p className="px-2.5 py-1 text-body-sm text-error" role="alert">
          {errorMessageOf(error, '加载更多对话失败，请重试')}
        </p>
      )}
      <button
        aria-label={error != null ? retryLabel : label}
        className={cn(
          SIDEBAR_ROW_CLASS,
          'w-full justify-start text-body-sm text-on-surface-faint ui-focus',
        )}
        disabled={loading}
        onClick={onExpand}
        type="button"
      >
        {loading ? '加载中…' : error != null ? '重试加载' : '展开显示'}
      </button>
    </>
  )
}

type CollectionGroupProps = {
  canManage: boolean
  collection: SidebarCollection
  dragging: string | null
  onDelete: () => void
  onDeleteConversation: (conversation: Conversation) => void
  onOpenMembership: (conversation: Conversation) => void
  onRename: () => void
  state: ConversationListState
}

function CollectionGroup({
  canManage,
  collection,
  dragging,
  onDelete,
  onDeleteConversation,
  onOpenMembership,
  onRename,
  state,
}: CollectionGroupProps) {
  const [open, setOpen] = useState(false)
  const canWrite = useCanWrite()
  const { isOver, setNodeRef } = useDroppable({ id: collection.id, disabled: !canWrite })
  const more = useMoreConversations(
    { collectionId: collection.id, state },
    collection.page.nextCursor,
  )
  const items = uniqueConversations([
    ...collection.page.items,
    ...(more.data?.pages.flatMap((one) => one.items) ?? []),
  ])
  const hasMore = more.data ? more.hasNextPage : Boolean(collection.page.nextCursor)

  return (
    <div className="flex flex-col gap-px">
      <div
        className={cn(SIDEBAR_ROW_CLASS, SIDEBAR_ROW_MENU_OPEN, isOver && 'bg-state-dragged')}
        ref={setNodeRef}
      >
        <button
          aria-expanded={open}
          aria-label={`${collection.name} (${collection.conversationCount})`}
          className={SIDEBAR_ROW_TITLE_CLASS}
          onClick={() => setOpen((prev) => !prev)}
          type="button"
        >
          <Icon className="shrink-0 text-on-surface-variant" decorative name="folder" size="md" />
          <span aria-hidden className="min-w-0 flex-1 truncate text-left">
            {collection.name}
          </span>
        </button>
        {/* 能管理时计数与 ⋯ 共用尾部槽位；不能管理就一直显示计数。 */}
        <span
          aria-hidden
          className={cn(
            'shrink-0 text-caption text-on-surface-faint tabular-nums',
            canManage && SIDEBAR_ROW_TRAILING_HIDDEN,
          )}
        >
          {collection.conversationCount}
        </span>
        {canManage && (
          <div className={cn(SIDEBAR_ROW_TRAILING_SHOWN, 'shrink-0 items-center')}>
            <MenuRoot>
              <MenuTrigger asChild>
                <IconButton label={`${collection.name} 的操作`} name="more" size="xs" />
              </MenuTrigger>
              <MenuSurface align="end">
                <MenuItem icon="edit" onSelect={onRename}>
                  重命名
                </MenuItem>
                <MenuSeparator />
                <MenuItem destructive icon="delete" onSelect={onDelete}>
                  删除
                </MenuItem>
              </MenuSurface>
            </MenuRoot>
          </div>
        )}
      </div>
      {open && (
        <div className="relative flex flex-col gap-px pl-6.5">
          {/* 引导线对齐合集行 folder 图标的中心。 */}
          <span
            aria-hidden
            className="absolute inset-y-1 left-4.5 w-px -translate-x-1/2 bg-hairline"
          />
          {items.map((conversation) => (
            <SidebarConversationRow
              key={conversation.id}
              conversation={conversation}
              dragging={dragging === conversation.id}
              onDelete={() => onDeleteConversation(conversation)}
              onOpenMembership={() => onOpenMembership(conversation)}
            />
          ))}
          {items.length === 0 && (
            <EmptyHint>
              {state === 'all' ? '这个合集还是空的' : emptyConversations(state)}
            </EmptyHint>
          )}
          {hasMore && (
            <ExpandRow
              error={more.error}
              label={`展开显示 ${collection.name} 里更多对话`}
              retryLabel={`重试加载 ${collection.name} 里更多对话`}
              loading={more.isFetching}
              onExpand={() => void more.fetchNextPage()}
            />
          )}
        </div>
      )}
    </div>
  )
}
