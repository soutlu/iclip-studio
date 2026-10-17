import {
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
import type { ConversationTask } from '@/shared/workbench'
import { mintUuid } from '@/shared/lib/uuid'
import {
  conversationRowsOf,
  useConversationRow,
  type ConversationRowStore,
} from './conversation-rows'
import type { ComposerPart } from '@/shared/ui/composer'
import {
  zApproveConversationsConversationIdInteractionsInteractionIdPostResponse,
  zConversationAgentsOut,
  zConversationEnvelope,
  type zConversationPageOut,
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
  /** 侧栏任务区与各合集从头读起的分页列表；刷新时整体失效，已读的页按新游标原位重拉。 */
  moreAll: MORE_KEY,
  /** 一个分区的分页列表：不给 collectionId 是任务区。 */
  more: ({
    collectionId,
    state,
  }: {
    collectionId?: string | undefined
    state: ConversationListState
  }) => [...MORE_KEY, collectionId ?? 'ungrouped', state] as const,
  /** 一段对话的整行。不在 all 前缀下：列表刷新不连带重读，行的变化由行池送达。 */
  row: (conversationId: string) => ['conversation-row', conversationId] as const,
  search: (keyword: string) => [...SEARCH_KEY, keyword] as const,
  /** 所有关键词的搜索结果；重连对账时整体失效。 */
  searchAll: SEARCH_KEY,
  /** 未传 state 时作为所有筛选的缓存键前缀。 */
  sidebar: (state?: ConversationListState): readonly string[] =>
    state === undefined ? SIDEBAR_KEY : [...SIDEBAR_KEY, state],
  /** 按 all 以外的状态筛选的侧栏拓扑或分页列表，对话状态一变它们的归属就可能不同。 */
  filteredLists: (list: 'more' | 'sidebar'): QueryFilters => ({
    queryKey: list === 'sidebar' ? SIDEBAR_KEY : MORE_KEY,
    predicate: ({ queryKey }) => queryKey.at(-1) !== 'all',
  }),
}

/**
 * 对话列表的刷新配方：失效列表，挂着的查询原位重拉。侧栏的分页列表从头按新游标逐页重拉、页数不变，
 * 重拉完才换上新数据，已展开的行不会收起。
 *
 * 缺省失效全部会话列表（侧栏拓扑与分页列表、搜索、需求单下的尝试、全部对话页），给改了对话的写操作用。
 * ``'sidebar'`` 只重拉侧栏拓扑与分页列表，给全局帧与合集变动用：全部对话页另有节流窗口，不跟着每帧重拉。
 * 等这些重拉都完成才 resolve。
 */
export const refreshConversationLists = async (
  queryClient: QueryClient,
  scope: 'all' | 'sidebar' = 'all',
): Promise<void> => {
  const queryKeys =
    scope === 'all'
      ? [conversationsQueryKeys.all]
      : [conversationsQueryKeys.sidebar(), conversationsQueryKeys.moreAll]
  await Promise.all(queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
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

const newestCachedCollectionOf = (
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
    newestCachedCollectionOf(
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
 * 取一段对话的整行并合进行池，跟上 `lastRunId`、`activity.videoGeneration` 等帧上没有的字段；404 按删除处理。
 * 新的一次中止在途那次，只有最后一次的结果进池；已记墓碑的对话照样读。读取失败只记警告，行保持原值。
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
    if (!current()) return
    if (error instanceof ApiError && error.status === 404) {
      store.applyDeleted(conversationId)
      return
    }
    console.warn('补读对话行失败', { conversationId })
  } finally {
    if (current()) reads.delete(conversationId)
  }
}

/** 这段对话此刻挂的需求单。整行只读一次，之后取行池里的当前值（对话已删时取读到的那一行）；
 * 在这段对话下另起的生成记录用它归属。读失败时交出重读的入口，由用到它的界面说明并给重试。 */
export const useConversationTask = (conversationId: string): ConversationTask => {
  const query = useQuery({
    queryKey: conversationsQueryKeys.row(conversationId),
    queryFn: async ({ client, signal }) => {
      const row = await apiFetch(`/conversations/${conversationId}`, conversationEnvelopeSchema, {
        fallbackErrorMessage: '读取任务失败',
        signal,
      })
      conversationRowsOf(client).mergeRows([row])
      return row
    },
  })
  const row = useConversationRow(query.data)
  if (query.data !== undefined) return { kind: 'ready', taskId: (row ?? query.data).taskId }
  if (query.isError) return { kind: 'failed', retry: () => void query.refetch() }
  return { kind: 'loading' }
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

/** 起一段对话的入参：正文给 composer 的 ``parts`` 或已拼好的 ``content``；归属、标题与做同款的源不给就不带。 */
export type StartConversationInput = {
  agentId: string
  collectionId?: string | null
  taskId?: string | null
  title?: string
  /** 做同款的源对话 id（资料库卡 id），建对话时由服务端拷制作文件与素材台账。 */
  sameAs?: string | null
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
      const { agentId, collectionId, sameAs, taskId, title } = input
      const content = 'parts' in input ? partsContent(input.parts) : input.content
      const fingerprint = JSON.stringify({
        agentId,
        collectionId: collectionId ?? null,
        content,
        ownerUserId,
        sameAs: sameAs ?? null,
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
            sameAs,
            taskId,
            title,
          }))
        current.conversation = conversation
        await submitPrompt(conversation.id, { content, promptId: current.promptId })
        return conversation
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) attemptRef.current = null
        throw error
      }
    },
    onSuccess: (conversation) => {
      attemptRef.current = null
      onCreated(conversation.id)
    },
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
    onSettled: () => refreshConversationLists(queryClient),
    onSuccess: () => onSaved?.(),
  })
}

/** 从某一轮岔出一段自己的对话。源对话不变，副本带着截到那一轮的历史、工作区与已出片的记录。
 * 副本 id 由服务端铸、没有幂等键：`start` 在成功后不再放行，只有失败后才能重试；返回的 `start` 引用不变。 */
export const useForkConversation = (onForked: (conversationId: string) => void) => {
  const queryClient = useQueryClient()
  const inFlightRef = useRef(false)
  const mutation = useMutation({
    mutationFn: ({ conversationId, turn }: { conversationId: string; turn: number }) =>
      apiFetch(`/conversations/${conversationId}:fork`, conversationEnvelopeSchema, {
        body: { turn },
        fallbackErrorMessage: '另开任务失败',
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
      conversationRowsOf(queryClient).applyDeleted(conversationId)
      return refreshConversationLists(queryClient)
    },
  })
}
