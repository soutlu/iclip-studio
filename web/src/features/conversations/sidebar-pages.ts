import {
  hashKey,
  InfiniteQueryObserver,
  infiniteQueryOptions,
  notifyManager,
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type InfiniteQueryObserverResult,
  type QueryClient,
} from '@tanstack/react-query'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { apiFetch } from '@/shared/api/client'
import { zConversationPageOut } from '@/shared/api/generated/zod.gen'
import { conversationRowsOf, useConversationRows } from './conversation-rows'
import {
  conversationsQueryKeys,
  type Conversation,
  type ConversationListState,
  type ConversationPage,
} from './conversations.api'

export type SidebarPagesQuery = InfiniteQueryObserverResult<InfiniteData<ConversationPage>>

/** 一个侧栏分区的行（取行池里的当前值）与它的分页查询；查询还没挂上时 `query` 为 undefined，行取拓扑首页。 */
export type SidebarPages = {
  items: readonly Conversation[]
  query: SidebarPagesQuery | undefined
}

type Partition = { collectionId?: string | undefined; state: ConversationListState }

const sidebarPagesOptions = (
  { collectionId, state }: Partition,
  firstPage: ConversationPage | undefined,
  enabled: boolean,
) =>
  infiniteQueryOptions({
    queryKey: conversationsQueryKeys.more({ collectionId, state }),
    queryFn: async ({ client, pageParam, signal }) => {
      const query = new URLSearchParams({ state })
      // 服务端解析不了空游标：从头读时不带 cursor 参数。
      if (pageParam !== null) query.set('cursor', pageParam)
      const rows = conversationRowsOf(client)
      return rows.track(
        () =>
          apiFetch(
            `${
              collectionId
                ? `/conversations/by-collection/${collectionId}`
                : '/conversations/ungrouped'
            }?${query.toString()}`,
            zConversationPageOut,
            { signal, cache: 'no-store', fallbackErrorMessage: '加载更多任务失败' },
          ),
        (page, book) => ({ ...page, items: rows.mergeRows(page.items, book) }),
      )
    },
    initialPageParam: null as string | null,
    initialData: () =>
      firstPage === undefined ? undefined : { pageParams: [null], pages: [firstPage] },
    getNextPageParam: (last: ConversationPage) => last.nextCursor,
    enabled: enabled && firstPage !== undefined,
    staleTime: Infinity,
  })

const uniqueMembers = new WeakMap<readonly ConversationPage[], readonly Conversation[]>()

const membersOf = (pages: readonly ConversationPage[]): readonly Conversation[] => {
  const cached = uniqueMembers.get(pages)
  if (cached !== undefined) return cached
  const seen = new Set<string>()
  const members = pages.flatMap((page) =>
    page.items.filter((row) => {
      if (seen.has(row.id)) return false
      seen.add(row.id)
      return true
    }),
  )
  uniqueMembers.set(pages, members)
  return members
}

/**
 * 侧栏任务区的分页列表。首页取同一筛选下拓扑里的那一页，`firstPage` 给出之前不发请求；
 * 往后由调用方 `fetchNextPage`。只在 {@link refreshConversationLists} 失效时从头逐页原位重拉。
 */
export const useSidebarPages = (
  state: ConversationListState,
  firstPage: ConversationPage | undefined,
): SidebarPages & { query: SidebarPagesQuery } => {
  const query = useInfiniteQuery(sidebarPagesOptions({ state }, firstPage, true))
  const pages = query.data?.pages ?? (firstPage === undefined ? [] : [firstPage])
  return { items: useConversationRows(membersOf(pages)), query }
}

export type SidebarCollectionSource = {
  collectionId: string
  firstPage: ConversationPage
  open: boolean
}

/**
 * 侧栏各合集的分页列表，按 collectionId 给出。展开的合集自动读到最后一页，收着的不发请求；
 * 失效后的重拉与任务区相同。不再出现在 `collections` 里的合集停止订阅。
 */
export const useSidebarCollectionPages = (
  collections: readonly SidebarCollectionSource[],
  state: ConversationListState,
): ReadonlyMap<string, SidebarPages> => {
  const queryClient = useQueryClient()
  const [observers] = useState(() => new CollectionPagesObservers(queryClient))
  const results = useSyncExternalStore(observers.subscribe, observers.getSnapshot)
  useEffect(() => observers.sync(collections, state))
  const rows = conversationRowsOf(queryClient)
  useSyncExternalStore(
    (onChange) => rows.subscribe(onChange),
    () => rows.snapshotVersion(),
  )
  return new Map(
    collections.map(({ collectionId, firstPage }) => {
      const query = results.get(hashKey(conversationsQueryKeys.more({ collectionId, state })))
      const pages = query?.data?.pages ?? [firstPage]
      return [collectionId, { items: rows.resolveAll(membersOf(pages), false), query }]
    }),
  )
}

type SidebarPagesObserver = InfiniteQueryObserver<
  ConversationPage,
  Error,
  InfiniteData<ConversationPage>,
  ReturnType<typeof conversationsQueryKeys.more>,
  string | null
>

class CollectionPagesObservers {
  readonly #client: QueryClient
  #observers = new Map<string, SidebarPagesObserver>()
  readonly #unsubscribes = new Map<string, () => void>()
  #notify: (() => void) | undefined
  #results: ReadonlyMap<string, SidebarPagesQuery> = new Map()

  constructor(client: QueryClient) {
    this.#client = client
  }

  readonly subscribe = (notify: () => void): (() => void) => {
    this.#notify = notify
    for (const [hash, observer] of this.#observers) this.#watch(hash, observer)
    return () => {
      for (const unsubscribe of this.#unsubscribes.values()) unsubscribe()
      this.#unsubscribes.clear()
      this.#notify = undefined
    }
  }

  readonly getSnapshot = (): ReadonlyMap<string, SidebarPagesQuery> => this.#results

  sync(collections: readonly SidebarCollectionSource[], state: ConversationListState): void {
    const next = new Map<string, SidebarPagesObserver>()
    for (const { collectionId, firstPage, open } of collections) {
      const options = sidebarPagesOptions({ collectionId, state }, firstPage, open)
      const hash = hashKey(options.queryKey)
      const existing = this.#observers.get(hash)
      if (existing === undefined) {
        const observer: SidebarPagesObserver = new InfiniteQueryObserver(this.#client, options)
        next.set(hash, observer)
        if (this.#notify !== undefined) this.#watch(hash, observer)
      } else {
        existing.setOptions(options)
        next.set(hash, existing)
      }
    }
    for (const hash of this.#observers.keys()) {
      if (next.has(hash)) continue
      this.#unsubscribes.get(hash)?.()
      this.#unsubscribes.delete(hash)
    }
    this.#observers = next
    this.#update()
  }

  #watch(hash: string, observer: SidebarPagesObserver): void {
    this.#unsubscribes.set(hash, observer.subscribe(notifyManager.batchCalls(() => this.#update())))
  }

  #update(): void {
    const results = new Map<string, SidebarPagesQuery>()
    for (const [hash, observer] of this.#observers) {
      const result = observer.getCurrentResult()
      results.set(hash, result)
      if (
        this.#notify !== undefined &&
        result.isEnabled &&
        result.hasNextPage &&
        !result.isFetching &&
        !result.isError
      )
        void observer.fetchNextPage({ cancelRefetch: false })
    }
    const previous = this.#results
    if (
      results.size === previous.size &&
      [...results].every(([hash, result]) => previous.get(hash) === result)
    )
      return
    this.#results = results
    this.#notify?.()
  }
}
