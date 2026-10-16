import { useEffect, useMemo } from 'react'
import {
  useConversationRows,
  useSidebarPages,
  type Conversation,
  type ConversationListState,
  type ConversationPage,
} from '@/features/conversations'

export type SidebarPageState = {
  items: readonly Conversation[]
  dataUpdatedAt: number
  error: unknown
  hasNextPage: boolean
  isError: boolean
  isFetching: boolean
  isFetchingNextPage: boolean
  isFetchNextPageError: boolean
  fetchNextPage: (options?: { cancelRefetch?: boolean }) => Promise<unknown>
  refetch: () => Promise<unknown>
}

/** 分页来源常驻，行滚出视口不影响自动续页；只向侧栏发布数据与加载状态。 */
export function SidebarPageSource({
  collectionId,
  enabled,
  firstPage,
  onChange,
  state,
}: {
  collectionId?: string | undefined
  enabled: boolean
  firstPage: ConversationPage
  onChange: (bucket: string, page: SidebarPageState | null) => void
  state: ConversationListState
}) {
  const bucket = `${state}:${collectionId ?? 'ungrouped'}`
  const pages = useSidebarPages({ collectionId, state }, { enabled, firstPage })
  const members = useMemo(() => {
    const seen = new Set<string>()
    return pages.data.pages.flatMap((page) =>
      page.items.filter((row) => {
        if (seen.has(row.id)) return false
        seen.add(row.id)
        return true
      }),
    )
  }, [pages.data.pages])
  const items = useConversationRows(members)
  const {
    dataUpdatedAt,
    error,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    refetch,
  } = pages
  useEffect(() => {
    onChange(bucket, {
      items,
      dataUpdatedAt,
      error,
      fetchNextPage,
      hasNextPage,
      isError,
      isFetching,
      isFetchingNextPage,
      isFetchNextPageError,
      refetch,
    })
  }, [
    bucket,
    onChange,
    items,
    dataUpdatedAt,
    error,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    refetch,
  ])
  useEffect(() => () => onChange(bucket, null), [bucket, onChange])
  // 合集保持原有全展开、自动读完行为；未分组仍由末尾哨兵驱动。
  useEffect(() => {
    if (collectionId !== undefined && enabled && hasNextPage && !isFetching && !isError) {
      void fetchNextPage({ cancelRefetch: false })
    }
  }, [collectionId, enabled, fetchNextPage, hasNextPage, isError, isFetching])
  return null
}
