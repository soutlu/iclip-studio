import type { ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { ListError, NextPageFooter } from '@/shared/ui/list-state'
import { LibraryGrid, LibraryGridSkeleton } from './library-grid'

type LibraryListQuery = {
  dataUpdatedAt: number
  error: unknown
  hasNextPage: boolean
  isError: boolean
  isFetching: boolean
  isFetchingNextPage: boolean
  isFetchNextPageError: boolean
  isPending: boolean
  fetchNextPage: (options?: { cancelRefetch: boolean }) => Promise<unknown>
  refetch: () => Promise<unknown>
}

type LibraryListProps<T> = {
  query: LibraryListQuery
  getScrollElement: () => HTMLElement | null
  skeletonLabel: string
  errorMessage: string
  pending?: boolean
  blocker?: ReactNode
  empty: ReactNode
  items: readonly T[]
  keyOf: (item: T) => string
  estimateHeight: (item: T, columnWidth: number) => number
  renderItem: (item: T, columnWidth: number) => ReactNode
  shown: number
  total: number | undefined
}

export function LibraryList<T>({
  query,
  getScrollElement,
  skeletonLabel,
  errorMessage,
  pending = false,
  blocker,
  empty,
  items,
  keyOf,
  estimateHeight,
  renderItem,
  shown,
  total,
}: LibraryListProps<T>) {
  const listError = query.isError && !query.isFetchNextPageError
  return (
    <>
      {query.isPending || (pending && !listError) ? (
        <LibraryGridSkeleton label={skeletonLabel} />
      ) : listError ? (
        <ListError
          message={errorMessageOf(query.error, errorMessage)}
          onRetry={() => void query.refetch()}
        />
      ) : blocker !== undefined ? (
        blocker
      ) : items.length === 0 ? (
        empty
      ) : (
        <LibraryGrid
          estimateHeight={estimateHeight}
          getScrollElement={getScrollElement}
          items={items}
          keyOf={keyOf}
          renderItem={renderItem}
        />
      )}

      {query.hasNextPage ? (
        query.isFetchNextPageError && !query.isFetchingNextPage ? (
          <ListError
            message={errorMessageOf(query.error, errorMessage)}
            onRetry={() => void query.fetchNextPage()}
          />
        ) : (
          <NextPageFooter
            getScrollElement={getScrollElement}
            query={query}
            shown={shown}
            total={total}
          />
        )
      ) : null}
    </>
  )
}
