import { useQueries, useQueryClient } from '@tanstack/react-query'
import { useCallback, useSyncExternalStore } from 'react'
import { ApiError } from '@/shared/api/client'
import { hitCaseStateOptions, type HitCaseState } from './hit-cases.api'
import {
  isReferenceBusy,
  isTaggingBusy,
  referenceDetailOptions,
  type ReferenceDetail,
} from './references.api'

export function useLibraryTaggingRefresh() {
  const client = useQueryClient()
  const subscribe = useCallback(
    (onChange: () => void) => client.getQueryCache().subscribe(onChange),
    [client],
  )
  const referenceIds = useSyncExternalStore(subscribe, () =>
    client
      .getQueriesData<ReferenceDetail>({ queryKey: ['references', 'detail'] })
      .flatMap(([key, data]) => {
        const error = client.getQueryState(key)?.error
        return typeof key[2] === 'string' &&
          data !== undefined &&
          isReferenceBusy(data) &&
          !(error instanceof ApiError && error.status === 404)
          ? [key[2]]
          : []
      })
      .sort()
      .join(','),
  )
  const hitCaseIds = useSyncExternalStore(subscribe, () =>
    client
      .getQueriesData<HitCaseState>({ queryKey: ['hit-cases', 'state'] })
      .flatMap(([key, data]) => {
        const error = client.getQueryState(key)?.error
        return typeof key[2] === 'string' &&
          isTaggingBusy(data?.entry?.tagStatus ?? null) &&
          !(error instanceof ApiError && error.status === 404)
          ? [key[2]]
          : []
      })
      .sort()
      .join(','),
  )
  useQueries({
    queries: referenceIds === '' ? [] : referenceIds.split(',').map(referenceDetailOptions),
  })
  useQueries({ queries: hitCaseIds === '' ? [] : hitCaseIds.split(',').map(hitCaseStateOptions) })
}
