import { DndContext, PointerSensor, useDroppable, useSensor } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { useQueryClient } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type RefObject,
} from 'react'
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
  useSidebarPages,
  useSidebarRowEditing,
  useRecordOpenedConversation,
  useSetConversationMembership,
  useSidebarTopology,
  useConversationRows,
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

// 侧栏筛选只开放这三档，同时作用于合集与任务区。
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

// 展开着的合集记在本浏览器里，换筛选、收起合集列表、刷新页面都不会把它们合上。
const OPEN_COLLECTIONS_KEY = 'cue.sidebar.open-collections'

/** 读展开着的合集；存储不可用或内容不对时当作都收着。 */
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
    // 存储不可用时，展开状态只在这次打开的页面里保留。
  }
}

/** 展开着的合集：只由用户点合集行开合。 */
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
 * 任务区和合集内容使用服务端分页：任务区滚到底接着读，展开的合集读全；合集列表在前端收起。
 * 拖动改归属后由 mutation 刷新拓扑与分页列表。
 * 登录态的加载与失败由应用侧栏处理，它只在登录身份就绪后渲染这里。
 *
 * @param onStartInCollection 合集行上「在合集里新建任务」：由应用侧栏接去首页，与「新建任务」同一条路。
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

  // 新建合集在合集区顶部插入一行原位编辑行。
  const [creatingCollection, setCreatingCollection] = useState(false)
  const addCollectionRef = useRef<HTMLButtonElement>(null)
  // 键盘建成的合集：等它的行渲染出来后由那一行接住焦点。侧栏合集按建立时间倒序（合同 §6），新合集总在最前、可见。
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
  const refreshSidebar = () => refreshConversationLists(queryClient, 'sidebar')
  // 等侧栏拓扑重拉完才算保存完成，编辑行退出时新名字已在列表里，不闪回旧名。
  const saveCollection = useSaveCollection(refreshSidebar)

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

  // 「运行中」上的指示点仅取拓扑首页数据，往后的分页由子组件持有；行取池里的当前值。
  const firstPageRows = useConversationRows([
    ...(topology.data?.ungrouped.items ?? []),
    ...allCollections.flatMap((one) => one.page.items),
  ])
  const anyBusy = firstPageRows.some((row) => row.activity.busy)

  if (!canRead) return <SidebarFeedback>当前账号没有查看任务权限</SidebarFeedback>

  return (
    <DndContext
      onDragEnd={onDragEnd}
      onDragStart={({ active }) => setDragging(String(active.id))}
      sensors={[pointer]}
    >
      {/* 吸顶标题用 local 层级压住合集引导线，isolate 把这组层级限定在滚动区内。 */}
      <div
        className="isolate flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pt-2 pb-2"
        ref={scrollRef}
      >
        {/* 筛选始终挂在这一位置：换档时拓扑按新档位读取，加载与失败只替换下方内容，选中项与键盘焦点留在原处。 */}
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
          <>
            <SidebarSection
              action={
                canManageCollections
                  ? {
                      icon: 'add',
                      label: '新建合集',
                      onClick: startCreatingCollection,
                    }
                  : undefined
              }
              actionRef={addCollectionRef}
              title="合集"
            >
              {creatingCollection && (
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
              )}
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
                  onFocusHandled={() => setFocusCollectionId(null)}
                  onOpenMembership={openMembership}
                  focusRequested={focusCollectionId === collection.id}
                  onRename={(name) =>
                    saveCollection.mutateAsync({ collectionId: collection.id, name })
                  }
                  onStartConversation={() => onStartInCollection(collection.id)}
                  onToggle={() => openCollections.toggle(collection.id)}
                  open={openCollections.open.has(collection.id)}
                  state={state}
                />
              ))}
              {allCollections.length === 0 && !creatingCollection && (
                <EmptyHint>还没有合集</EmptyHint>
              )}
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
                  <span aria-hidden className="w-(--icon-md) shrink-0" />
                  {allCollectionsShown ? '收起合集' : '全部合集'}
                </button>
              )}
            </SidebarSection>

            <UngroupedSection
              dragging={dragging}
              firstPage={topology.data?.ungrouped ?? { items: [], nextCursor: null }}
              getScrollElement={getScrollElement}
              onDeleteConversation={confirmDelete}
              onOpenMembership={openMembership}
              state={state}
            />
          </>
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

function UngroupedSection({
  dragging,
  firstPage,
  getScrollElement,
  onDeleteConversation,
  onOpenMembership,
  state,
}: {
  dragging: string | null
  /** 拓扑里任务区的第一页，作分页列表的首页。 */
  firstPage: ConversationPage
  /** 侧栏的滚动容器，列表末尾进入它下方一屏以内就读下一页。 */
  getScrollElement: () => HTMLElement | null
  onDeleteConversation: (conversation: Conversation) => void
  onOpenMembership: (conversation: Conversation) => void
  state: SidebarFilter
}) {
  const canWrite = useCanWrite()
  const groupId = useId()
  const now = useNowByDay()
  const { isOver, setNodeRef } = useDroppable({ id: UNGROUPED, disabled: !canWrite })
  const pages = useSidebarPages({ state }, { firstPage })
  const items = useConversationRows(
    uniqueConversations(pages.data.pages.flatMap((one) => one.items)),
  )
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
        {pages.isError ? (
          <RetryRow
            error={pages.error}
            loading={pages.isFetching}
            onRetry={() => retryPages(pages)}
            retryLabel="重新加载更多任务"
          />
        ) : (
          pages.hasNextPage && <NextPageRow getScrollElement={getScrollElement} query={pages} />
        )}
      </SidebarSection>
    </div>
  )
}

type SidebarSectionProps = {
  action?:
    | {
        icon: IconName
        label: string
        onClick: () => void
      }
    | undefined
  /** 尾部动作按钮的引用，供编辑结束后把焦点还给它。 */
  actionRef?: RefObject<HTMLButtonElement | null>
  children: React.ReactNode
  title: string
}

/** 侧栏分区常驻展开，标题只作标签；收起只发生在单个合集上。 */
function SidebarSection({ action, actionRef, children, title }: SidebarSectionProps) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-px">
      {/* 吸顶标题底色与侧栏同色，滚过的行不会从标题下透出来。左右内距与行相同：标题字与行首图标同一左缘，
          尾部控件靠负右距让图形右缘落在行内容右缘，与合集计数、任务状态图形同一列。 */}
      <div className="layer-local-1 sticky top-0 flex h-8 items-center gap-1 bg-surface-container-low px-2.5">
        <h2
          className="min-w-0 truncate text-label font-semibold text-on-surface-variant"
          id={headingId}
        >
          {title}
        </h2>
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
      <div className="flex flex-col gap-px">{children}</div>
    </section>
  )
}

/**
 * 侧栏筛选：三档等宽平铺在合集上方，合集与任务区一起按它筛。选中项一层浅墨底、字重提一档，不浮起。
 * 有任务在跑时「运行中」上带一个墨色小点，绿色只留给生成。
 */
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
          // 共享分段的选中项是浮起的白块，侧栏底上换成选中行同款浅墨底、去掉投影。
          className="rounded-sm text-on-surface-muted hover:text-on-surface data-[state=on]:bg-state-active data-[state=on]:shadow-none"
          key={option}
          value={option}
          variant="segmented"
          {...(option === 'running' && busy ? { 'aria-label': '运行中，有任务在跑' } : {})}
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
  /** 排在滚动区里筛选下方：内距与上方间距由滚动区给，文字与行首对齐。 */
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
  state === 'done' ? '没有标记完成的任务' : state === 'running' ? '没有运行中的任务' : '还没有任务'

/** 页边界可因活动时间变化重叠，保留首页优先的第一条记录。 */
const uniqueConversations = (items: readonly Conversation[]): Conversation[] => {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

/** 分页列表的查询状态；直接传 useSidebarPages 的返回值。 */
type SidebarPagesQuery = {
  /** 最近一次读到数据的时刻；每变一次都按当下位置重新判断。 */
  dataUpdatedAt: number
  isError: boolean
  isFetching: boolean
  isFetchingNextPage: boolean
  isFetchNextPageError: boolean
  fetchNextPage: (options?: { cancelRefetch?: boolean }) => Promise<unknown>
  refetch: () => Promise<unknown>
}

/** 翻下一页失败就重读那一页；从头重拉失败就整份再重拉。 */
const retryPages = (query: SidebarPagesQuery): void => {
  void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())
}

/**
 * 任务区列表末尾：滚到接近底部就读下一页，读取中写「加载中…」。闲着时只占一线高，不留空白。
 *
 * 查询读取中或出错时暂停：在途的原位重拉不被打断，失败后只由重试按钮再读。
 */
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

  // 相交状态不变就不回调，所以每读到一次数据、每次暂停结束都重建观察器，让它按当下布局再报一次。
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (paused || sentinel === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadNextPage()
      },
      // 根得是侧栏的滚动容器，下边距才会按它的一屏往外扩。
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

/** 分页失败保留已加载内容，在列表末尾显示原因和重试。 */
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

type CollectionGroupProps = {
  canManage: boolean
  collection: SidebarCollection
  dragging: string | null
  onDelete: () => void
  onDeleteConversation: (conversation: Conversation) => void
  onOpenMembership: (conversation: Conversation) => void
  /** 刚用键盘建成这个合集：挂上后把焦点交给它的行按钮，再调 onFocusHandled 清掉请求。 */
  focusRequested: boolean
  onFocusHandled: () => void
  /** 提交新名字；列表刷新出新名字后 resolve。 */
  onRename: (name: string) => Promise<unknown>
  /** 在这个合集里新建任务：去首页，输入框预选这个合集。 */
  onStartConversation: () => void
  /** 展开与否由侧栏持有，合集行卸载重挂（换筛选、收起合集列表）后照旧。 */
  open: boolean
  onToggle: () => void
  state: SidebarFilter
}

/** 合集展开时读全它的对话，收着不发请求。 */
function CollectionGroup({
  canManage,
  collection,
  dragging,
  focusRequested,
  onDelete,
  onDeleteConversation,
  onFocusHandled,
  onOpenMembership,
  onRename,
  onStartConversation,
  onToggle,
  open,
  state,
}: CollectionGroupProps) {
  const { close, editing, returnRef, start } = useSidebarRowEditing<HTMLButtonElement>()
  const canWrite = useCanWrite()

  useEffect(() => {
    if (!focusRequested) return
    returnRef.current?.focus()
    onFocusHandled()
  }, [focusRequested, onFocusHandled, returnRef])
  const { isOver, setNodeRef } = useDroppable({ id: collection.id, disabled: !canWrite })
  const pages = useSidebarPages(
    { collectionId: collection.id, state },
    { enabled: open, firstPage: collection.page },
  )
  const items = useConversationRows(
    uniqueConversations(pages.data.pages.flatMap((one) => one.items)),
  )
  const { fetchNextPage, hasNextPage, isError, isFetching } = pages
  // 展开着就一页接一页读到底；失败后停下，只由重试按钮再读。
  useEffect(() => {
    if (open && hasNextPage && !isFetching && !isError) {
      void fetchNextPage({ cancelRefetch: false })
    }
  }, [fetchNextPage, hasNextPage, isError, isFetching, open])

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
            {/* 名字后紧跟细箭头，收起朝右、展开朝下，看得出这一行能展开；整个按钮仍占满行。 */}
            <span className="flex min-w-0 flex-1 items-center gap-1">
              <span aria-hidden className="min-w-0 truncate text-left">
                {collection.name}
              </span>
              <DisclosureChevron className="text-on-surface-faint" open={open} />
            </span>
          </button>
          {/* 计数常驻；能新建任务时羽毛笔、能管理时 ⋯ 依次排在它右边，与 ⋯ 一起悬停或聚焦才现身。 */}
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
                <MenuRoot>
                  <MenuTrigger asChild>
                    <IconButton label={`${collection.name} 的操作`} name="more" size="xs" />
                  </MenuTrigger>
                  <MenuSurface align="end">
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
      {open && (
        <div className="relative flex flex-col gap-px pl-6.5">
          {/* 引导线对齐合集行文件夹图标的中心；缩进让对话标题与合集名左缘对齐。 */}
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
          {isError && (
            <RetryRow
              error={pages.error}
              loading={isFetching}
              onRetry={() => retryPages(pages)}
              retryLabel={`重新加载 ${collection.name} 里更多任务`}
            />
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

/** 行尾的对话数；可访问名已带在合集按钮上，这里只给看的。 */
function CollectionCount({ count }: { count: number }) {
  return (
    <span aria-hidden className="shrink-0 text-caption text-on-surface-faint tabular-nums">
      {count}
    </span>
  )
}
