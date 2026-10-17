import { useEffect } from 'react'

type PagedQuery = {
  fetchNextPage: (options?: { cancelRefetch: boolean }) => Promise<unknown>
  hasNextPage: boolean
  isError: boolean
  isFetching: boolean
}

export function useLoadNextPageWhen(
  { fetchNextPage, hasNextPage, isError, isFetching }: PagedQuery,
  needed: boolean,
) {
  useEffect(() => {
    if (needed && hasNextPage && !isFetching && !isError)
      void fetchNextPage({ cancelRefetch: false })
  }, [needed, hasNextPage, isFetching, isError, fetchNextPage])
}
