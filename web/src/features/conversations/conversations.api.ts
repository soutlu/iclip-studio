import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFilters,
} from '@tanstack/react-query'
import { useCallback, useRef, useSyncExternalStore } from 'react'
import { z } from 'zod'
import { ApiError, apiFetch } from '@/shared/api/client'
import type { PromptContentPart } from '@/shared/transcript/vendor'
import { mintUuid } from '@/shared/lib/uuid'
import { conversationRowsOf, type ConversationRowStore } from './conversation-rows'
import type { ComposerPart } from '@/shared/ui/composer'
import {
  zApproveConversationsConversationIdInteractionsInteractionIdPostResponse,
  zConversationAgentsOut,
  zConversationEnvelope,
  zConversationPageOut,
  zConversationsPageOut,
  zImageContent,
  zPrompt,
  zReadSidebarConversationsGetQuery,
  zSidebarOut,
  zTextContent,
  zVideoContent,
  type zConversationIn,
} from '@/shared/api/generated/zod.gen'

export type Conversation = z.output<typeof zConversationsPageOut>['items'][number]

export type ConversationPage = z.output<typeof zConversationPageOut>

/** 侧栏拓扑里的一个合集：元信息、总条数，加第一页对话。 */
export type SidebarCollection = z.output<typeof zSidebarOut>['collections'][number]

/** 侧栏拓扑：任务区第一页加每个合集（各带自己的第一页）。 */
export type SidebarTopology = z.output<typeof zSidebarOut>

const conversationsPageSchema = zConversationsPageOut.transform((payload) => payload.items)
const conversationEnvelopeSchema = zConversationEnvelope.transform(
  (payload) => payload.conversation,
)

const SEARCH_LIMIT = 50

/** 侧栏与全部对话页共用：``open`` / ``done`` 看属主标没标收尾，``running`` 是此刻在跑的那几段。
 *
 * 取合同查询参数的枚举，路由解析地址栏也用这一份，合同加档位时两边一起变。 */
export const conversationListStateSchema = zReadSidebarConversationsGetQuery.shape.state
  .unwrap()
  .unwrap()

export type ConversationListState = z.output<typeof conversationListStateSchema>

const SIDEBAR_KEY = ['conversations', 'sidebar'] as const
const MORE_KEY = ['conversations', 'more'] as const
const AUDIT_KEY = ['conversations', 'audit'] as const
const SEARCH_KEY = ['conversations', 'search'] as const

export const conversationsQueryKeys = {
  all: ['conversations'] as const,
  agents: ['conversation-agents'] as const,
  /** 治理者的全部对话，按筛选条件分键；auditAll 作前缀整体失效。 */
  audit: (filters: object) => [...AUDIT_KEY, filters] as const,
  auditAll: AUDIT_KEY,
  /** 用户手动展开的额外分页；拓扑刷新时整体丢弃。 */
  moreAll: MORE_KEY,
  more: (bucket: string, cursor: string, state: ConversationListState) =>
    [...MORE_KEY, bucket, cursor, state] as const,
  search: (keyword: string) => [...SEARCH_KEY, keyword] as const,
  /** 所有关键词的搜索结果；重连对账时整体失效。 */
  searchAll: SEARCH_KEY,
  /** 未传 state 时作为所有筛选的缓存键前缀。 */
  sidebar: (state?: ConversationListState): readonly string[] =>
    state === undefined ? SIDEBAR_KEY : [...SIDEBAR_KEY, state],
  /**
   * 按 all 以外的状态筛选的侧栏拓扑或额外分页，对话状态一变它们的归属就可能不同。
   * state 是 sidebar(state) 与 more(…) 的末位，改这两种键的布局要连这里一起改。
   */
  filteredLists: (list: 'more' | 'sidebar'): QueryFilters => ({
    queryKey: list === 'sidebar' ? SIDEBAR_KEY : MORE_KEY,
    predicate: ({ queryKey }) => queryKey.at(-1) !== 'all',
  }),
}

/**
 * 对话列表的刷新配方：先丢掉用户手动展开的额外分页（拓扑一变它们的游标就不作数，留着会逐页重拉），
 * 再失效列表。
 *
 * 缺省失效全部会话列表（侧栏拓扑、搜索、需求单下的尝试、全部对话页），给改了对话的写操作用。
 * ``'sidebar'`` 只重拉侧栏拓扑，给全局帧与合集变动用：全部对话页另有节流窗口，不跟着每帧重拉。
 */
export const refreshConversationLists = (
  queryClient: QueryClient,
  scope: 'all' | 'sidebar' = 'all',
): Promise<void> => {
  queryClient.removeQueries({ queryKey: conversationsQueryKeys.moreAll })
  return queryClient.invalidateQueries({
    queryKey: scope === 'all' ? conversationsQueryKeys.all : conversationsQueryKeys.sidebar(),
  })
}

/** 仅提供当前服务实际装配的顶层 Agent；顺序和默认项由服务端定义。 */
export const useConversationAgents = (enabled: boolean) =>
  useQuery({
    enabled,
    queryKey: conversationsQueryKeys.agents,
    queryFn: ({ signal }) =>
      apiFetch('/conversations/agents', zConversationAgentsOut, {
        signal,
        cache: 'no-store',
        fallbackErrorMessage: '读取创作助手列表失败',
      }),
  })

/** 服务端按标题搜索当前用户的全部对话，按最近活动排序。 */
export const searchConversations = async (
  keyword: string,
  signal: AbortSignal,
): Promise<Conversation[]> =>
  apiFetch(
    `/conversations/search?q=${encodeURIComponent(keyword)}&limit=${SEARCH_LIMIT}`,
    conversationsPageSchema,
    { signal, cache: 'no-store', fallbackErrorMessage: '搜索任务失败' },
  )

/** 拓扑里的行进池合并（合同 §5 水位规则），查询里留下合并后的行与成员、计数。 */
const mergeTopology = (
  store: ConversationRowStore,
  topology: SidebarTopology,
): SidebarTopology => ({
  ...topology,
  collections: topology.collections.map((collection) => ({
    ...collection,
    page: { ...collection.page, items: store.mergeRows(collection.page.items) },
  })),
  ungrouped: { ...topology.ungrouped, items: store.mergeRows(topology.ungrouped.items) },
})

/** 分组、计数和首页数据来自同一服务端拓扑，避免不同查询时间点造成不一致。 */
export const useSidebarTopology = (enabled: boolean, state: ConversationListState) =>
  useQuery({
    enabled,
    queryFn: async ({ client, signal }) =>
      mergeTopology(
        conversationRowsOf(client),
        await apiFetch(`/conversations?state=${state}`, zSidebarOut, {
          signal,
          cache: 'no-store',
          fallbackErrorMessage: '读取任务列表失败',
        }),
      ),
    queryKey: conversationsQueryKeys.sidebar(state),
  })

/**
 * 在侧栏已缓存的拓扑里找这段对话所在的合集：从最新拉到的那份起，先见到它的那份说了算，
 * 在合集页里就是那个合集，在未归类里就是没有。拓扑每组只带第一页，哪份都没见到也是没有。
 */
const sidebarCollectionOf = (
  topologies: readonly { data: SidebarTopology | undefined; updatedAt: number }[],
  conversationId: string,
): SidebarCollection | undefined => {
  const newestFirst = [...topologies].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const { data } of newestFirst) {
    if (data === undefined) continue
    const collection = data.collections.find((one) =>
      one.page.items.some((item) => item.id === conversationId),
    )
    if (collection !== undefined) return collection
    if (data.ungrouped.items.some((item) => item.id === conversationId)) return undefined
  }
  return undefined
}

/** 只读侧栏的查询缓存、不发请求；侧栏重拉或换筛选时跟着更新。 */
export const useCachedConversationCollection = (
  conversationId: string,
): SidebarCollection | undefined => {
  const queryClient = useQueryClient()
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  )
  // 返回缓存里的那个合集对象本身：缓存不变时引用不变，满足快照稳定的要求。
  return useSyncExternalStore(subscribe, () =>
    sidebarCollectionOf(
      queryClient
        .getQueriesData<SidebarTopology>({ queryKey: conversationsQueryKeys.sidebar() })
        .map(([queryKey, data]) => ({
          data,
          updatedAt: queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0,
        })),
      conversationId,
    ),
  )
}

/** 额外分页仅由用户触发；拓扑失效时丢弃这些页，避免自动逐页重拉。bucket 筛选需与拓扑一致。 */
export const useMoreConversations = (
  { collectionId, state }: { collectionId?: string | undefined; state: ConversationListState },
  cursor: string | null,
) => {
  return useInfiniteQuery({
    queryKey: conversationsQueryKeys.more(collectionId ?? 'ungrouped', cursor ?? '', state),
    queryFn: async ({ client, pageParam, signal }) => {
      const page = await apiFetch(
        `${
          collectionId ? `/conversations/by-collection/${collectionId}` : '/conversations/ungrouped'
        }?cursor=${encodeURIComponent(pageParam)}&state=${state}`,
        zConversationPageOut,
        { signal, cache: 'no-store', fallbackErrorMessage: '加载更多任务失败' },
      )
      return { ...page, items: conversationRowsOf(client).mergeRows(page.items) }
    },
    initialPageParam: cursor ?? '',
    getNextPageParam: (last: z.output<typeof zConversationPageOut>) => last.nextCursor,
    enabled: false,
  })
}

/** 每段对话正在进行的那一次单行补读，按行池分表。 */
const rowReads = new WeakMap<ConversationRowStore, Map<string, AbortController>>()

const rowReadsOf = (store: ConversationRowStore): Map<string, AbortController> => {
  let reads = rowReads.get(store)
  if (reads === undefined) {
    reads = new Map()
    rowReads.set(store, reads)
  }
  return reads
}

/**
 * 取一段对话的整行并合进行池（照 Kimi 的单行补读）：轮次状态、出片汇总变化后用它跟上
 * `lastRunId`、`activity.videoGeneration` 等帧上没有的字段，不必整份重拉侧栏。看不见了（404）按删除处理。
 *
 * 照 Kimi `hydrateLiveSession` 以最后一次为准：新的一次中止在途那次，读回来只认仍是最新的那次。
 * 不能复用在途的请求：视频汇总没有帧来源，在途期间又来的变化若只等那次旧读，旧值进池后就再也没有东西纠正它。
 * 记了墓碑的照样读（不照 Kimi 跳过）：治理者复盘时读得到墓碑行，它的视频汇总也要跟上。
 */
export const refreshConversationRow = async (
  queryClient: QueryClient,
  conversationId: string,
): Promise<void> => {
  const store = conversationRowsOf(queryClient)
  const reads = rowReadsOf(store)
  reads.get(conversationId)?.abort()
  const controller = new AbortController()
  reads.set(conversationId, controller)
  const current = () => reads.get(conversationId) === controller
  try {
    const row = await apiFetch(`/conversations/${conversationId}`, conversationEnvelopeSchema, {
      cache: 'no-store',
      fallbackErrorMessage: '读取任务失败',
      signal: controller.signal,
    })
    if (current()) store.mergeRows([row])
  } catch (error) {
    // 已被后来的一次接替（含被它中止）：这次的结果不作数，也不算失败。
    if (!current()) return
    if (error instanceof ApiError && error.status === 404) {
      store.applyDeleted(conversationId)
      return
    }
    // 补读失败不影响列表：行留在帧给的状态，下一帧或下一次重拉再对齐。
    console.warn('补读对话行失败', { conversationId })
  } finally {
    if (current()) reads.delete(conversationId)
  }
}

/** 创建对话；调用方可提供幂等编号、需求单和合集归属。 */
export const createConversation = async (
  body: z.input<typeof zConversationIn>,
): Promise<Conversation> =>
  apiFetch('/conversations', conversationEnvelopeSchema, {
    body,
    fallbackErrorMessage: '新建任务失败',
    method: 'POST',
  })

/** 起一段对话的入参：正文给 composer 的 ``parts`` 或已拼好的 ``content``；归属与标题不给就不带。 */
export type StartConversationInput = {
  agentId: string
  collectionId?: string | null
  taskId?: string | null
  title?: string
} & ({ parts: readonly ComposerPart[] } | { content: readonly PromptContentPart[] })

/**
 * 建对话并发首条消息。对话 id 与消息 id 都由客户端铸，同一份输入重试复用两者：建对话的回执丢了
 * 重发不会多一段，首条消息重发不会多起一次运行。首条消息成功后才交给 ``onCreated``。
 */
export const useStartConversation = (
  ownerUserId: string | null,
  onCreated: (conversationId: string) => void,
) => {
  const queryClient = useQueryClient()
  const attemptRef = useRef<{
    fingerprint: string
    conversationId: string
    promptId: string
    conversation?: Conversation
  } | null>(null)
  return useMutation({
    mutationFn: async (input: StartConversationInput) => {
      const { agentId, collectionId, taskId, title } = input
      const content = 'parts' in input ? partsContent(input.parts) : input.content
      // 不给与给 null 都是不挂，算同一份输入；请求体里不给的字段照旧不发。
      const fingerprint = JSON.stringify({
        agentId,
        collectionId: collectionId ?? null,
        content,
        ownerUserId,
        taskId: taskId ?? null,
        title: title ?? null,
      })
      if (attemptRef.current?.fingerprint !== fingerprint) {
        attemptRef.current = { fingerprint, conversationId: mintUuid(), promptId: mintPromptId() }
      }
      const current = attemptRef.current
      try {
        const conversation =
          current.conversation ??
          (await createConversation({
            agentId,
            collectionId,
            id: current.conversationId,
            taskId,
            title,
          }))
        current.conversation = conversation
        await submitPrompt(conversation.id, { content, promptId: current.promptId })
        return conversation
      } catch (error) {
        // 已删除的对话 ID 不能再使用；仅在明确 404 后允许下一次主动提交另建对话。
        if (error instanceof ApiError && error.status === 404) attemptRef.current = null
        throw error
      }
    },
    onSuccess: (conversation) => {
      attemptRef.current = null
      onCreated(conversation.id)
    },
    // 创建成功、首条消息失败时，侧栏也应能看到这段已存在的对话。
    onSettled: () => refreshConversationLists(queryClient),
  })
}

export const mintPromptId = (): string => mintUuid()

/** 保持文字与媒体相对顺序；空文字、未就绪附件和文件附件不进入消息。 */
export const partsContent = (parts: readonly ComposerPart[]): PromptContentPart[] =>
  parts.flatMap((part): PromptContentPart[] => {
    if (part.kind === 'text') return part.text === '' ? [] : [{ text: part.text, type: 'text' }]
    const { kind, url } = part.media
    return url !== undefined && (kind === 'image' || kind === 'video')
      ? [{ source: { kind: 'url', url }, type: kind }]
      : []
  })

/** 往一段对话里发一条消息。同一个 `promptId` 重发不会多起一次运行。 */
export const submitPrompt = async (
  conversationId: string,
  { content, promptId }: { promptId: string; content: readonly PromptContentPart[] },
): Promise<void> => {
  await apiFetch(`/conversations/${conversationId}/prompts`, zPrompt, {
    body: { content, prompt_id: promptId },
    fallbackErrorMessage: '发送失败',
    method: 'POST',
  })
}

/** 取消排队或运行中的消息；已结束状态视为成功，容忍与自然结束的竞态。 */
export const abortPrompt = async (conversationId: string, promptId: string): Promise<void> => {
  try {
    await apiFetch(`/conversations/${conversationId}/prompts/${promptId}:abort`, z.unknown(), {
      fallbackErrorMessage: '停止失败',
      method: 'POST',
    })
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 409)) return
    throw error
  }
}

/** 将排队消息追加到当前轮；消息已离开队列时视为成功，容忍自动出队的竞态。 */
export const steerPrompt = async (conversationId: string, promptId: string): Promise<void> => {
  try {
    await apiFetch(`/conversations/${conversationId}/prompts:steer`, z.unknown(), {
      body: { prompt_ids: [promptId] },
      fallbackErrorMessage: '追加失败',
      method: 'POST',
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return
    throw error
  }
}

/** 相同审批决定可重复提交；409 决定冲突和 404 交互失效均由调用方展示。 */
export const respondInteraction = async (
  conversationId: string,
  interactionId: string,
  approved: boolean,
): Promise<void> => {
  await apiFetch(
    `/conversations/${conversationId}/interactions/${interactionId}`,
    zApproveConversationsConversationIdInteractionsInteractionIdPostResponse,
    { body: { approved }, fallbackErrorMessage: '提交决定失败', method: 'POST' },
  )
}

/** 服务端替换末轮并重新运行；新轮经推送更新，409 与 404 原样交给调用方。 */
export const regeneratePrompt = async (
  conversationId: string,
  turnId: string,
  edit?: { promptId: string; content: readonly PromptContentPart[] },
): Promise<void> => {
  await apiFetch(`/conversations/${conversationId}/turns/${turnId}:regenerate`, zPrompt, {
    ...(edit === undefined ? {} : { body: { content: edit.content, prompt_id: edit.promptId } }),
    fallbackErrorMessage: '重新生成失败',
    method: 'POST',
  })
}

/** 只提取文字 part，忽略附件及无效条目。 */
export const promptText = (content: unknown): string => {
  const parsed = z.array(z.unknown()).safeParse(content)
  if (!parsed.success) return ''
  return parsed.data
    .flatMap((part) => {
      const text = zTextContent.safeParse(part)
      return text.success ? [text.data.text] : []
    })
    .join('')
}

/** 队列预览只提取 URL 来源的图片与视频。 */
export const promptMedia = (content: unknown): { kind: 'image' | 'video'; url: string }[] => {
  const parsed = z.array(z.unknown()).safeParse(content)
  if (!parsed.success) return []
  const out: { kind: 'image' | 'video'; url: string }[] = []
  for (const part of parsed.data) {
    const image = zImageContent.safeParse(part)
    const video = zVideoContent.safeParse(part)
    const media = image.success ? image.data : video.success ? video.data : undefined
    if (media === undefined || media.source.kind !== 'url' || !media.source.url) continue
    out.push({ kind: image.success ? 'image' : 'video', url: media.source.url })
  }
  return out
}

type Membership = {
  /** undefined 保持原归属，null 解除归属。 */
  collectionId?: string | null
  conversationId: string
  taskId?: string | null
}

/** 两处归属分别调用端点；结束后不论成败自己刷新对话列表，``onSaved`` 只管调用方的收尾。 */
export const useSetConversationMembership = (
  onSaved?: () => void,
  onUpdated?: (conversation: Conversation) => void,
) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ collectionId, conversationId, taskId }: Membership) => {
      if (collectionId !== undefined) {
        const updated = await apiFetch(
          `/conversations/${conversationId}/collection`,
          conversationEnvelopeSchema,
          {
            body: { collectionId },
            fallbackErrorMessage: '移动任务失败',
            method: 'PUT',
          },
        )
        conversationRowsOf(queryClient).mergeRows([updated])
        onUpdated?.(updated)
      }
      if (taskId !== undefined) {
        const updated = await apiFetch(
          `/conversations/${conversationId}/task`,
          conversationEnvelopeSchema,
          {
            body: { taskId },
            fallbackErrorMessage: '关联需求单失败',
            method: 'PUT',
          },
        )
        conversationRowsOf(queryClient).mergeRows([updated])
        onUpdated?.(updated)
      }
    },
    // 两个独立归属请求可能部分成功；失败也复核服务端实际状态。
    onSettled: () => refreshConversationLists(queryClient),
    onSuccess: () => onSaved?.(),
  })
}

/** 从某一轮岔出一段自己的对话。源对话不变，副本带着截到那一轮的历史、工作区与已出片的记录。
 *
 * 副本 id 由服务端铸、没有幂等键，重发就是第二段。成功之后不复位标记：那一刻请求已经回来、
 * 按钮又能点了，但页面还在跳去副本的路上，这个窗口里再点一下就是第二段。失败才放开重试。 */
export const useForkConversation = (onForked: (conversationId: string) => void) => {
  const queryClient = useQueryClient()
  const inFlightRef = useRef(false)
  const mutation = useMutation({
    mutationFn: ({ conversationId, turn }: { conversationId: string; turn: number }) =>
      apiFetch(`/conversations/${conversationId}:fork`, conversationEnvelopeSchema, {
        body: { turn },
        fallbackErrorMessage: '分叉失败',
        method: 'POST',
      }),
    onError: () => {
      inFlightRef.current = false
    },
    onSuccess: async (conversation) => {
      await refreshConversationLists(queryClient)
      onForked(conversation.id)
    },
  })
  const { mutateAsync } = mutation
  // 引用保持不变：会话页把它包进交给按轮 memo 的分叉回调，每次渲染换新会让历史轮跟着重渲。
  const start = useCallback(
    (input: { conversationId: string; turn: number }): Promise<void> => {
      if (inFlightRef.current) return Promise.resolve()
      inFlightRef.current = true
      return mutateAsync(input).then(() => undefined)
    },
    [mutateAsync],
  )
  return { isPending: mutation.isPending, start }
}

/** 改名；成功后自己刷新对话列表。 */
export const useRenameConversation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ conversationId, title }: { conversationId: string; title: string }) =>
      apiFetch(`/conversations/${conversationId}`, conversationEnvelopeSchema, {
        body: { title },
        fallbackErrorMessage: '重命名失败',
        method: 'PATCH',
      }),
    onSuccess: (renamed) => {
      conversationRowsOf(queryClient).mergeRows([renamed])
      return refreshConversationLists(queryClient)
    },
  })
}

/** 属主标记这段对话收尾了或取消；服务端不会自己标，属主再动手会自动取消。成功后自己刷新对话列表。 */
export const useSetConversationCompletion = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ completed, conversationId }: { completed: boolean; conversationId: string }) =>
      apiFetch(`/conversations/${conversationId}/completion`, conversationEnvelopeSchema, {
        body: { completed },
        fallbackErrorMessage: '标记完成失败',
        method: 'PUT',
      }),
    onSuccess: (updated) => {
      conversationRowsOf(queryClient).mergeRows([updated])
      return refreshConversationLists(queryClient)
    },
  })
}

/** 删除返回 204，无响应正文；成功后自己刷新对话列表。 */
export const useDeleteConversation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (conversationId: string) =>
      apiFetch(`/conversations/${conversationId}`, z.unknown(), {
        fallbackErrorMessage: '删除失败',
        method: 'DELETE',
      }),
    onSuccess: (_, conversationId) => {
      // 删除帧也会到，这里先记墓碑，不等帧。
      conversationRowsOf(queryClient).applyDeleted(conversationId)
      return refreshConversationLists(queryClient)
    },
  })
}
