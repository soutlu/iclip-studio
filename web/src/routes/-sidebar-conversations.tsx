import { DndContext, PointerSensor, useDroppable, useSensor } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react'
import { CollectionDeleteDialog, useCollections, useSaveCollection } from '@/features/collections'
import {
  ConversationDeleteDialog,
  ConversationMembershipDialog,
  DisclosureChevron,
  refreshConversationLists,
  SidebarConversationRow,
  SIDEBAR_ROW_CLASS,
  SIDEBAR_ROW_MENU_OPEN,
  SIDEBAR_ROW_TITLE_CLASS,
  SIDEBAR_ROW_TRAILING_SHOWN,
  SidebarRowEditor,
  useSidebarRowEditing,
  useRecordOpenedConversation,
  useSetConversationMembership,
  useSidebarCollectionPages,
  useSidebarPages,
  useSidebarTopology,
  useConversationRows,
  type Conversation,
  type ConversationListState,
  type SidebarCollection,
  type SidebarPagesQuery,
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
import {
  SidebarVirtualList,
  type SidebarSection,
  type SidebarVirtualRow,
} from './-sidebar-virtual-list'

const COLLECTIONS_PREVIEW = 3

const COLLECTIONS_SECTION: SidebarSection = { key: 'collections', label: '合集' }
const UNGROUPED_SECTION = {
  key: 'ungrouped',
  label: '任务',
  dropId: 'ungrouped',
} as const satisfies SidebarSection

const FILTER_OPTIONS = [
  'all',
  'running',
  'done',
] as const satisfies readonly ConversationListState[]
type SidebarFilter = (typeof FILTER_OPTIONS)[number]
const FILTER_LABEL: Record<SidebarFilter, string> = {
  all: '全部',
  done: '已完成',
  running: '运行中',
}
const isSidebarFilter = (value: string): value is SidebarFilter =>
  (FILTER_OPTIONS as readonly string[]).includes(value)

const OPEN_COLLECTIONS_KEY = 'cue.sidebar.open-collections'

const readOpenCollections = (): ReadonlySet<string> => {
  try {
    const stored = window.localStorage.getItem(OPEN_COLLECTIONS_KEY)
    const parsed: unknown = stored === null ? [] : JSON.parse(stored)
    return new Set(
      Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === 'string') : [],
    )
  } catch {
    return new Set()
  }
}

const writeOpenCollections = (open: ReadonlySet<string>): void => {
  try {
    window.localStorage.setItem(OPEN_COLLECTIONS_KEY, JSON.stringify([...open]))
  } catch {
    // 浏览器禁用或占满存储时 setItem 会抛错，展开状态只留在这次打开的页面里。
  }
}

const useOpenCollections = () => {
  const [open, setOpen] = useState(readOpenCollections)
  const toggle = (collectionId: string) => {
    const next = new Set(open)
    if (next.has(collectionId)) next.delete(collectionId)
    else next.add(collectionId)
    setOpen(next)
    writeOpenCollections(next)
  }
  return { open, toggle }
}

const useCanWrite = () => hasPermission(useUser().data, PERMISSION.agentRun)

const useNowRefreshedAtMidnight = (): Date => {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const timer = window.setTimeout(() => setNow(new Date()), midnight.getTime() - now.getTime())
    return () => window.clearTimeout(timer)
  }, [now])
  return now
}

/**
 * 侧栏的合集与任务区。任务区滚到底接着读，展开的合集读全；拖动改归属后由 mutation 刷新列表。
 * 只在登录身份就绪后渲染。
 *
 * @param onStartInCollection 合集行上「在合集里新建任务」：由应用侧栏接去首页。
 */
export function SidebarConversations({
  onStartInCollection,
}: {
  onStartInCollection: (collectionId: string) => void
}) {
  const queryClient = useQueryClient()
  const user = useUser().data
  const canRead = hasPermission(user, PERMISSION.agentRead)
  const canWrite = useCanWrite()
  const canManageCollections = hasPermission(user, PERMISSION.collectionsWrite)
  const canReadCollections = hasPermission(user, PERMISSION.collectionsRead)
  const canReadTasks = hasPermission(user, PERMISSION.tasksRead)
  const [state, setState] = useState<SidebarFilter>('all')
  const topology = useSidebarTopology(canRead, state)
  useRecordOpenedConversation(topology.data)
  const [allCollectionsShown, setAllCollectionsShown] = useState(false)
  const openCollections = useOpenCollections()
  const [dragging, setDragging] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const getScrollElement = useCallback(() => scrollRef.current, [])
  const now = useNowRefreshedAtMidnight()

  const [creatingCollection, setCreatingCollection] = useState(false)
  const addCollectionRef = useRef<HTMLButtonElement>(null)
  const createdCollectionRef = useRef<string | null>(null)
  const [focusCollectionId, setFocusCollectionId] = useState<string | null>(null)
  const [collectionDelete, setCollectionDelete] = useState<{
    collection?: { id: string; name: string }
    open: boolean
  }>({ open: false })
  const [membership, setMembership] = useState<{
    conversation?: Conversation
    open: boolean
  }>({ open: false })
  const [conversationDelete, setConversationDelete] = useState<{
    conversation?: Conversation
    open: boolean
  }>({ open: false })
  const openMembership = useCallback(
    (conversation: Conversation) => setMembership({ conversation, open: true }),
    [setMembership],
  )
  const confirmDelete = useCallback(
    (conversation: Conversation) => setConversationDelete({ conversation, open: true }),
    [setConversationDelete],
  )

  const collections = useCollections(membership.open && canReadCollections)
  const tasks = useTaskOptions(membership.open && canReadTasks)

  const refreshSidebar = () => refreshConversationLists(queryClient, 'sidebar')
  const saveCollection = useSaveCollection(refreshSidebar)

  const refreshClaimedTasks = () => {
    void queryClient.invalidateQueries({ queryKey: tasksQueryKeys.all })
  }

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
    const to = over.id === UNGROUPED_SECTION.dropId ? null : String(over.id)
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
  const ungroupedPages = useSidebarPages(state, topology.data?.ungrouped)
  const collectionPages = useSidebarCollectionPages(
    visibleCollections.map((collection) => ({
      collectionId: collection.id,
      firstPage: collection.page,
      open: openCollections.open.has(collection.id),
    })),
    state,
  )

  const startCreatingCollection = () => {
    createdCollectionRef.current = null
    setCreatingCollection(true)
  }
  const closeCollectionDraft = ({ refocus }: { refocus: boolean }) => {
    setCreatingCollection(false)
    if (!refocus) return
    const created = createdCollectionRef.current
    if (created === null) addCollectionRef.current?.focus()
    else setFocusCollectionId(created)
  }

  const firstPageRows = useConversationRows([
    ...(topology.data?.ungrouped.items ?? []),
    ...allCollections.flatMap((one) => one.page.items),
  ])
  const anyBusy = firstPageRows.some((row) => row.activity.busy)

  const rows: SidebarVirtualRow[] = []
  const addConversation = (
    conversation: Conversation,
    section: SidebarSection,
    group?: SidebarVirtualRow['group'],
    collectionId?: string,
  ) => {
    rows.push({
      key: `conversation:${collectionId ?? section.key}:${conversation.id}`,
      section,
      ...(group === undefined ? {} : { group }),
      height: 36,
      focusable: true,
      retain: dragging === conversation.id,
      render: (onInteractionChange) => (
        <div className={collectionId === undefined ? undefined : 'relative pl-6.5'}>
          {collectionId !== undefined && (
            <span
              aria-hidden
              className="absolute inset-y-0 left-4.5 w-px -translate-x-1/2 bg-hairline"
            />
          )}
          <SidebarConversationRow
            conversation={conversation}
            dragging={dragging === conversation.id}
            onDelete={confirmDelete}
            onOpenMembership={openMembership}
            onInteractionChange={onInteractionChange}
          />
        </div>
      ),
    })
  }
  rows.push({
    key: 'collections-heading',
    section: COLLECTIONS_SECTION,
    height: 32,
    sticky: true,
    focusable: canManageCollections,
    render: () => (
      <SidebarHeading
        title={COLLECTIONS_SECTION.label}
        action={
          canManageCollections
            ? { icon: 'add', label: '新建合集', onClick: startCreatingCollection }
            : undefined
        }
        actionRef={addCollectionRef}
      />
    ),
  })
  if (creatingCollection)
    rows.push({
      key: 'create-collection',
      section: COLLECTIONS_SECTION,
      height: 36,
      focusable: true,
      retain: true,
      render: () => (
        <SidebarRowEditor
          failureMessage="新建合集失败"
          initialValue=""
          label="新合集名称"
          leading={<CollectionIcon />}
          onClose={closeCollectionDraft}
          onSubmit={async (name) => {
            createdCollectionRef.current = (await saveCollection.mutateAsync({ name })).id
          }}
          placeholder="新合集名称"
        />
      ),
    })
  for (const collection of visibleCollections) {
    rows.push({
      key: `collection:${collection.id}`,
      section: COLLECTIONS_SECTION,
      height: 36,
      focusable: true,
      retain: dragging !== null || focusCollectionId === collection.id,
      render: (onInteractionChange) => (
        <CollectionHeader
          canManage={canManageCollections}
          collection={collection}
          onDelete={() =>
            setCollectionDelete({
              collection: { id: collection.id, name: collection.name },
              open: true,
            })
          }
          onFocusHandled={() => setFocusCollectionId(null)}
          focusRequested={focusCollectionId === collection.id}
          onRename={(name) => saveCollection.mutateAsync({ collectionId: collection.id, name })}
          onStartConversation={() => onStartInCollection(collection.id)}
          onToggle={() => openCollections.toggle(collection.id)}
          open={openCollections.open.has(collection.id)}
          onInteractionChange={onInteractionChange}
        />
      ),
    })
    if (!openCollections.open.has(collection.id)) continue
    const pages = collectionPages.get(collection.id)
    const items = pages?.items ?? []
    for (const item of items) addConversation(item, COLLECTIONS_SECTION, undefined, collection.id)
    if (items.length === 0)
      rows.push({
        key: `empty:${collection.id}`,
        section: COLLECTIONS_SECTION,
        height: 28,
        render: () => (
          <div className="pl-6.5">
            <EmptyHint>{state === 'all' ? '该合集暂无任务' : emptyConversations(state)}</EmptyHint>
          </div>
        ),
      })
    const query = pages?.query
    if (query?.isError)
      rows.push({
        key: `retry:${collection.id}`,
        section: COLLECTIONS_SECTION,
        height: 64,
        focusable: true,
        render: () => (
          <div className="pl-6.5">
            <RetryRow
              error={query.error}
              loading={query.isFetching}
              onRetry={() => retryPages(query)}
              retryLabel={`重新加载 ${collection.name} 里更多任务`}
            />
          </div>
        ),
      })
  }
  if (allCollections.length === 0 && !creatingCollection)
    rows.push({
      key: 'collections-empty',
      section: COLLECTIONS_SECTION,
      height: 28,
      render: () => <EmptyHint>暂无合集</EmptyHint>,
    })
  if (allCollections.length > COLLECTIONS_PREVIEW)
    rows.push({
      key: 'collections-more',
      section: COLLECTIONS_SECTION,
      height: 36,
      focusable: true,
      render: () => (
        <button
          aria-expanded={allCollectionsShown}
          className={cn(SIDEBAR_ROW_CLASS, 'w-full text-body-sm text-on-surface-faint ui-focus')}
          onClick={() => setAllCollectionsShown((shown) => !shown)}
          type="button"
        >
          <span aria-hidden className="w-(--icon-md) shrink-0" />
          {allCollectionsShown ? '收起合集' : '全部合集'}
        </button>
      ),
    })
  rows.push({
    key: 'sections-gap',
    section: COLLECTIONS_SECTION,
    height: 15,
    render: () => <div className="h-3.75" />,
  })
  rows.push({
    key: 'ungrouped-heading',
    section: UNGROUPED_SECTION,
    height: 32,
    sticky: true,
    render: () => <SidebarHeading title={UNGROUPED_SECTION.label} />,
  })
  for (const { bucket, items } of groupByRecency(
    ungroupedPages.items,
    (item) => item.createdAt,
    now,
  )) {
    const group = { key: bucket, label: RECENCY_LABEL[bucket] }
    rows.push({
      key: `date:${bucket}`,
      section: UNGROUPED_SECTION,
      group,
      height: 32,
      render: () => (
        <p className="flex h-8 items-end px-2.5 pb-1 text-caption text-on-surface-faint">
          {group.label}
        </p>
      ),
    })
    for (const item of items) addConversation(item, UNGROUPED_SECTION, group)
  }
  if (ungroupedPages.items.length === 0)
    rows.push({
      key: 'ungrouped-empty',
      section: UNGROUPED_SECTION,
      height: 28,
      render: () => <EmptyHint>{emptyConversations(state)}</EmptyHint>,
    })
  const ungroupedQuery = ungroupedPages.query
  if (ungroupedQuery.isError)
    rows.push({
      key: 'ungrouped-retry',
      section: UNGROUPED_SECTION,
      height: 64,
      focusable: true,
      render: () => (
        <RetryRow
          error={ungroupedQuery.error}
          loading={ungroupedQuery.isFetching}
          onRetry={() => retryPages(ungroupedQuery)}
          retryLabel="重新加载更多任务"
        />
      ),
    })
  else if (ungroupedQuery.hasNextPage)
    rows.push({
      key: 'ungrouped-next',
      section: UNGROUPED_SECTION,
      height: ungroupedQuery.isFetchingNextPage ? 36 : 1,
      retain: true,
      render: () => <NextPageRow getScrollElement={getScrollElement} query={ungroupedQuery} />,
    })

  if (!canRead) return <SidebarFeedback>当前账号没有查看任务权限</SidebarFeedback>

  return (
    <DndContext
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
      onDragStart={({ active }) => setDragging(String(active.id))}
      sensors={[pointer]}
    >
      <div
        aria-label="任务列表"
        role="region"
        className="isolate flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pt-2 pb-2 [overflow-anchor:none]"
        ref={scrollRef}
      >
        <ConversationFilter busy={anyBusy} onChange={setState} value={state} />
        {topology.isPending ? (
          <SidebarFeedback inList>正在加载任务…</SidebarFeedback>
        ) : topology.isError ? (
          <SidebarFeedback
            error
            inList
            loading={topology.isFetching}
            onRetry={() => void topology.refetch()}
          >
            {topology.error instanceof ApiError && topology.error.status === 403
              ? '当前账号没有查看任务权限'
              : errorMessageOf(topology.error, '读取任务列表失败，请重试')}
          </SidebarFeedback>
        ) : (
          <SidebarVirtualList rows={rows} getScrollElement={getScrollElement} canDrop={canWrite} />
        )}
      </div>

      <CollectionDeleteDialog
        collection={collectionDelete.collection}
        onDeleted={() => void refreshSidebar()}
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

type SidebarHeadingProps = {
  action?:
    | {
        icon: IconName
        label: string
        onClick: () => void
      }
    | undefined
  actionRef?: RefObject<HTMLButtonElement | null>
  title: string
}

function SidebarHeading({ action, actionRef, title }: SidebarHeadingProps) {
  return (
    <div className="flex h-8 items-center gap-1 bg-surface-container-low px-2.5">
      <h2 className="min-w-0 truncate text-label font-semibold text-on-surface-variant">{title}</h2>
      {action && (
        <div className="ml-auto flex shrink-0 items-center">
          <IconButton
            className="-mr-1.25"
            label={action.label}
            name={action.icon}
            onClick={action.onClick}
            ref={actionRef}
            size="xs"
          />
        </div>
      )}
    </div>
  )
}

function ConversationFilter({
  busy,
  onChange,
  value,
}: {
  busy: boolean
  onChange: (value: SidebarFilter) => void
  value: SidebarFilter
}) {
  return (
    <ChipGroup
      aria-label="任务筛选"
      className="h-7 gap-0.5 bg-transparent p-0"
      // Radix 再点一次已选项会给空串，不在档位里的值一律忽略，筛选始终有值。
      onValueChange={(next) => {
        if (isSidebarFilter(next)) onChange(next)
      }}
      type="single"
      value={value}
      variant="segmented"
    >
      {FILTER_OPTIONS.map((option) => (
        <FilterChip
          className="rounded-sm text-on-surface-muted hover:text-on-surface data-[state=on]:bg-state-active data-[state=on]:shadow-none"
          key={option}
          value={option}
          variant="segmented"
          {...(option === 'running' && busy ? { 'aria-label': '运行中，有任务正在运行' } : {})}
        >
          {FILTER_LABEL[option]}
          {option === 'running' && busy && (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-on-surface" />
          )}
        </FilterChip>
      ))}
    </ChipGroup>
  )
}

function EmptyHint({ children }: { children: string }) {
  return <p className="px-2.5 py-1 text-body-sm text-on-surface-faint">{children}</p>
}

function SidebarFeedback({
  children,
  error = false,
  inList = false,
  loading = false,
  onRetry,
}: {
  children: string
  error?: boolean
  inList?: boolean
  loading?: boolean
  onRetry?: () => void
}) {
  return (
    <div className={inList ? undefined : 'min-h-0 flex-1 px-2 pt-4'}>
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
          {loading ? '重试中…' : '重新加载任务'}
        </button>
      )}
    </div>
  )
}

const emptyConversations = (state: SidebarFilter) =>
  state === 'done' ? '暂无标记完成的任务' : state === 'running' ? '暂无运行中的任务' : '暂无任务'

const retryPages = (query: SidebarPagesQuery): void => {
  void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())
}

function NextPageRow({
  getScrollElement,
  query,
}: {
  getScrollElement: () => HTMLElement | null
  query: SidebarPagesQuery
}) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const { dataUpdatedAt, isFetchingNextPage } = query
  const paused = query.isFetching || query.isError
  const loadNextPage = useEffectEvent(() => void query.fetchNextPage({ cancelRefetch: false }))

  // IntersectionObserver 只在相交状态变化时回调：每读到一次数据、每次暂停结束都重建，让它按当下布局再报一次。
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (paused || sentinel === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadNextPage()
      },
      // rootMargin 的百分比按 root 计算，root 必须是侧栏的滚动容器。
      { root: getScrollElement(), rootMargin: '0px 0px 100% 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [dataUpdatedAt, getScrollElement, paused])

  return (
    <div
      className={
        isFetchingNextPage
          ? cn(SIDEBAR_ROW_CLASS, 'w-full justify-start text-body-sm text-on-surface-faint')
          : 'h-px'
      }
      ref={sentinelRef}
      role="status"
    >
      {isFetchingNextPage ? '加载中…' : null}
    </div>
  )
}

function RetryRow({
  error,
  loading,
  onRetry,
  retryLabel,
}: {
  error: unknown
  loading: boolean
  onRetry: () => void
  retryLabel: string
}) {
  return (
    <>
      <p className="px-2.5 py-1 text-body-sm text-error" role="alert">
        {errorMessageOf(error, '加载更多任务失败，请重试')}
      </p>
      <button
        aria-label={retryLabel}
        className={cn(
          SIDEBAR_ROW_CLASS,
          'w-full justify-start text-body-sm text-on-surface-faint ui-focus',
        )}
        disabled={loading}
        onClick={onRetry}
        type="button"
      >
        {loading ? '加载中…' : '重新加载'}
      </button>
    </>
  )
}

type CollectionHeaderProps = {
  canManage: boolean
  collection: SidebarCollection
  onDelete: () => void
  focusRequested: boolean
  onFocusHandled: () => void
  onRename: (name: string) => Promise<unknown>
  onStartConversation: () => void
  open: boolean
  onToggle: () => void
  onInteractionChange: (active: boolean) => void
}

function CollectionHeader({
  canManage,
  collection,
  focusRequested,
  onDelete,
  onFocusHandled,
  onRename,
  onStartConversation,
  onToggle,
  open,
  onInteractionChange,
}: CollectionHeaderProps) {
  const { close, editing, onMenuCloseAutoFocus, onMenuOpenChange, returnRef, start } =
    useSidebarRowEditing<HTMLButtonElement>(onInteractionChange)
  const canWrite = useCanWrite()

  useEffect(() => {
    if (!focusRequested) return
    returnRef.current?.focus()
    onFocusHandled()
  }, [focusRequested, onFocusHandled, returnRef])
  const { isOver, setNodeRef } = useDroppable({ id: collection.id, disabled: !canWrite })

  return (
    <div className="flex flex-col gap-px">
      {editing ? (
        <SidebarRowEditor
          failureMessage="重命名合集失败"
          initialValue={collection.name}
          label={`重命名 ${collection.name}`}
          leading={<CollectionIcon />}
          onClose={close}
          onSubmit={onRename}
          trailing={<CollectionCount count={collection.conversationCount} />}
        />
      ) : (
        <div
          className={cn(SIDEBAR_ROW_CLASS, SIDEBAR_ROW_MENU_OPEN, isOver && 'bg-state-dragged')}
          ref={setNodeRef}
        >
          <button
            ref={returnRef}
            aria-expanded={open}
            aria-label={`${collection.name} (${collection.conversationCount})`}
            className={SIDEBAR_ROW_TITLE_CLASS}
            onClick={onToggle}
            type="button"
          >
            <CollectionIcon />
            <span className="flex min-w-0 flex-1 items-center gap-1">
              <span aria-hidden className="min-w-0 truncate text-left">
                {collection.name}
              </span>
              <DisclosureChevron className="text-on-surface-faint" open={open} />
            </span>
          </button>
          <CollectionCount count={collection.conversationCount} />
          {(canWrite || canManage) && (
            <div className={cn(SIDEBAR_ROW_TRAILING_SHOWN, 'shrink-0 items-center')}>
              {canWrite && (
                <IconButton
                  label={`在「${collection.name}」里新建任务`}
                  name="compose"
                  onClick={onStartConversation}
                  size="xs"
                />
              )}
              {canManage && (
                <MenuRoot onOpenChange={onMenuOpenChange}>
                  <MenuTrigger asChild>
                    <IconButton label={`${collection.name} 的操作`} name="more" size="xs" />
                  </MenuTrigger>
                  <MenuSurface align="end" onCloseAutoFocus={onMenuCloseAutoFocus}>
                    <MenuItem icon="edit" onSelect={start}>
                      重命名
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem destructive icon="delete" onSelect={onDelete}>
                      删除
                    </MenuItem>
                  </MenuSurface>
                </MenuRoot>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CollectionIcon() {
  return (
    <Icon className="shrink-0 text-on-surface-variant" decorative name="collection" size="md" />
  )
}

function CollectionCount({ count }: { count: number }) {
  return (
    <span aria-hidden className="shrink-0 text-caption text-on-surface-faint tabular-nums">
      {count}
    </span>
  )
}
