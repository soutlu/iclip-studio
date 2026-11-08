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
import { mintUuid } from '@/shared/lib/uuid'
import { conversationRowsOf, type ConversationRowStore, type RowBook } from './conversation-rows'
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

export type SidebarCollection = z.output<typeof zSidebarOut>['collections'][number]

export type SidebarTopology = z.output<typeof zSidebarOut>

const conversationsPageSchema = zConversationsPageOut.transform((payload) => payload.items)
const conversationEnvelopeSchema = zConversationEnvelope.transform(
  (payload) => payload.conversation,
)

const SEARCH_LIMIT = 50

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
  audit: (filters: object) => [...AUDIT_KEY, filters] as const,
  auditAll: AUDIT_KEY,
  moreAll: MORE_KEY,
  more: ({
    collectionId,
    state,
  }: {
    collectionId?: string | undefined
    state: ConversationListState
  }) => [...MORE_KEY, collectionId ?? 'ungrouped', state] as const,
  row: (conversationId: string) => ['conversation-row', conversationId] as const,
  videoProgress: ['conversation-video-progress'] as const,
  search: (keyword: string) => [...SEARCH_KEY, keyword] as const,
  searchAll: SEARCH_KEY,
  sidebar: (state?: ConversationListState): readonly string[] =>
    state === undefined ? SIDEBAR_KEY : [...SIDEBAR_KEY, state],
  filteredLists: (list: 'more' | 'sidebar'): QueryFilters => ({
    queryKey: list === 'sidebar' ? SIDEBAR_KEY : MORE_KEY,
    predicate: ({ queryKey }) => queryKey.at(-1) !== 'all',
  }),
}

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
  book: RowBook,
): SidebarTopology => ({
  ...topology,
  collections: topology.collections.map((collection) => ({
    ...collection,
    page: { ...collection.page, items: store.mergeRows(collection.page.items, book) },
  })),
  ungrouped: { ...topology.ungrouped, items: store.mergeRows(topology.ungrouped.items, book) },
})

export const useSidebarTopology = (enabled: boolean, state: ConversationListState) =>
  useQuery({
    enabled,
    queryFn: ({ client, signal }) => {
      const store = conversationRowsOf(client)
      return store.track(
        () =>
          apiFetch(`/conversations?state=${state}`, zSidebarOut, {
            signal,
            cache: 'no-store',
            fallbackErrorMessage: '读取任务列表失败',
          }),
        (topology, book) => mergeTopology(store, topology, book),
      )
    },
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

export const useCachedConversationCollection = (
  conversationId: string,
): SidebarCollection | undefined => {
  const queryClient = useQueryClient()
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  )
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
    await store.track(
      () =>
        apiFetch(`/conversations/${conversationId}`, conversationEnvelopeSchema, {
          cache: 'no-store',
          fallbackErrorMessage: '读取任务失败',
          signal: controller.signal,
        }),
      (row, book) => {
        if (current()) store.mergeRows([row], book)
      },
    )
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

export const createConversation = async (
  body: z.input<typeof zConversationIn>,
): Promise<Conversation> =>
  apiFetch('/conversations', conversationEnvelopeSchema, {
    body,
    fallbackErrorMessage: '新建任务失败',
    method: 'POST',
  })

export type StartConversationInput = {
  agentId: string
  collectionId?: string | null
  taskId?: string | null
  title?: string
  sameAs?: string | null
} & ({ parts: readonly ComposerPart[] } | { content: readonly PromptContentPart[] })

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

export const partsContent = (parts: readonly ComposerPart[]): PromptContentPart[] =>
  parts.flatMap((part): PromptContentPart[] => {
    if (part.kind === 'text') return part.text === '' ? [] : [{ text: part.text, type: 'text' }]
    const { kind, url } = part.media
    return url !== undefined && (kind === 'image' || kind === 'video')
      ? [{ source: { kind: 'url', url }, type: kind }]
      : []
  })

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
  collectionId?: string | null
  conversationId: string
  taskId?: string | null
}

export const useSetConversationMembership = (
  onSaved?: () => void,
  onUpdated?: (conversation: Conversation) => void,
) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ collectionId, conversationId, taskId }: Membership) => {
      const rows = conversationRowsOf(queryClient)
      if (collectionId !== undefined) {
        const updated = await rows.track(
          () =>
            apiFetch(`/conversations/${conversationId}/collection`, conversationEnvelopeSchema, {
              body: { collectionId },
              fallbackErrorMessage: '移动任务失败',
              method: 'PUT',
            }),
          (row, book) => {
            rows.mergeRows([row], book)
            return row
          },
        )
        onUpdated?.(updated)
      }
      if (taskId !== undefined) {
        const updated = await rows.track(
          () =>
            apiFetch(`/conversations/${conversationId}/task`, conversationEnvelopeSchema, {
              body: { taskId },
              fallbackErrorMessage: '关联需求单失败',
              method: 'PUT',
            }),
          (row, book) => {
            rows.mergeRows([row], book)
            return row
          },
        )
        onUpdated?.(updated)
      }
    },
    onSettled: () => refreshConversationLists(queryClient),
    onSuccess: () => onSaved?.(),
  })
}

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

export const useRenameConversation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ conversationId, title }: { conversationId: string; title: string }) => {
      const rows = conversationRowsOf(queryClient)
      return rows.track(
        () =>
          apiFetch(`/conversations/${conversationId}`, conversationEnvelopeSchema, {
            body: { title },
            fallbackErrorMessage: '重命名失败',
            method: 'PATCH',
          }),
        (renamed, book) => {
          rows.mergeRows([renamed], book)
        },
      )
    },
    onSuccess: () => refreshConversationLists(queryClient),
  })
}

export const useSetConversationCompletion = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ completed, conversationId }: { completed: boolean; conversationId: string }) => {
      const rows = conversationRowsOf(queryClient)
      return rows.track(
        () =>
          apiFetch(`/conversations/${conversationId}/completion`, conversationEnvelopeSchema, {
            body: { completed },
            fallbackErrorMessage: '标记完成失败',
            method: 'PUT',
          }),
        (updated, book) => {
          rows.mergeRows([updated], book)
        },
      )
    },
    onSuccess: () => refreshConversationLists(queryClient),
  })
}

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
