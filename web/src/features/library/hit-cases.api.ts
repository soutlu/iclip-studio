import {
  queryOptions,
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch, ApiError } from '@/shared/api/client'
import {
  zHitCasesOut,
  zHitCaseStateOut,
  zRemoveHitCaseLibraryHitCasesJobIdDeleteResponse,
  type zHitCaseIn,
  type zHitCaseOut,
  type zHitCaseTagsIn,
} from '@/shared/api/generated/zod.gen'
import { dateRangeBounds } from '@/shared/lib/date-range'
import { libraryQueryKeys, useAuthorSource } from './library.api'
import {
  DEFAULT_LIBRARY_TAG_SCOPE,
  isDefaultLibraryTagScope,
  type LibraryTagScope,
} from './library-tag-scope'
import { libraryTagQueryKeys } from './library-tags.api'
import { isTaggingBusy } from './references.api'

export type HitCasesPage = z.output<typeof zHitCasesOut>
export type HitCase = z.output<typeof zHitCaseOut>
export type HitCaseState = z.output<typeof zHitCaseStateOut>
export type HitCaseEntry = NonNullable<HitCaseState['entry']>
export type HitCaseIneligible = NonNullable<HitCaseState['ineligibleReason']>

export type HitCaseScope = LibraryTagScope

export const DEFAULT_HIT_CASE_SCOPE: HitCaseScope = DEFAULT_LIBRARY_TAG_SCOPE

export const isDefaultHitCaseScope = isDefaultLibraryTagScope

const HIT_CASES_PAGE_SIZE = 24

const POLL_MS = 5000

export const hitCaseSearchParams = (
  scope: HitCaseScope,
  cursor: string | null,
  now: Date = new Date(),
): URLSearchParams => {
  const params = new URLSearchParams()
  const { since, until } = dateRangeBounds(scope, now)
  if (since !== null) params.set('since', since.toISOString())
  if (until !== null) params.set('until', until.toISOString())
  if (scope.userName !== null) params.set('userName', scope.userName)
  for (const id of scope.tags) params.append('tags', id)
  params.set('limit', String(HIT_CASES_PAGE_SIZE))
  if (cursor !== null) params.set('cursor', cursor)
  return params
}

export const useHitCaseAuthorSource = () => useAuthorSource('/library/hit-cases/authors')

export const hitCaseQueryKeys = {
  all: ['hit-cases'] as const,
  list: (scope: HitCaseScope) => ['hit-cases', 'list', scope] as const,
  state: (jobId: string) => ['hit-cases', 'state', jobId] as const,
}

export const useHitCases = (scope: HitCaseScope, enabled = true) =>
  useInfiniteQuery({
    enabled,
    gcTime: 30 * 60_000,
    queryFn: ({ pageParam, signal }) =>
      apiFetch(
        `/library/hit-cases?${hitCaseSearchParams(scope, pageParam).toString()}`,
        zHitCasesOut,
        { fallbackErrorMessage: '读取爆款素材失败', signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: HitCasesPage) => last.nextCursor,
    queryKey: hitCaseQueryKeys.list(scope),
    refetchInterval: ({ state }) =>
      state.data?.pages.some((page) => page.items.some((item) => isTaggingBusy(item.tagStatus)))
        ? POLL_MS
        : false,
  })

const hitCasePath = (jobId: string) => `/library/hit-cases/${encodeURIComponent(jobId)}`

export const hitCaseStateOptions = (jobId: string | null) =>
  queryOptions({
    queryFn:
      jobId === null
        ? skipToken
        : async ({ client, signal }) => {
            const previous = client.getQueryData<HitCaseState>(hitCaseQueryKeys.state(jobId))
            const next = await apiFetch(hitCasePath(jobId), zHitCaseStateOut, {
              fallbackErrorMessage: '读取爆款素材状态失败',
              signal,
            })
            if (
              isTaggingBusy(previous?.entry?.tagStatus ?? null) &&
              !isTaggingBusy(next.entry?.tagStatus ?? null)
            ) {
              void client.invalidateQueries({ queryKey: ['hit-cases', 'list'] })
              void client.invalidateQueries({ queryKey: libraryTagQueryKeys.tree })
            }
            return next
          },
    queryKey: hitCaseQueryKeys.state(jobId ?? ''),
    refetchInterval: ({ state }) =>
      !(state.error instanceof ApiError && state.error.status === 404) &&
      isTaggingBusy(state.data?.entry?.tagStatus ?? null)
        ? POLL_MS
        : false,
  })

export const useHitCaseState = (jobId: string | null) => useQuery(hitCaseStateOptions(jobId))

const useSettle = (jobId: string) => {
  const queryClient = useQueryClient()
  return (state: HitCaseState | null) => {
    if (state === null)
      void queryClient.invalidateQueries({ queryKey: hitCaseQueryKeys.state(jobId) })
    else queryClient.setQueryData(hitCaseQueryKeys.state(jobId), state)
    void queryClient.invalidateQueries({ queryKey: ['hit-cases', 'list'] })
    void queryClient.invalidateQueries({
      queryKey: libraryQueryKeys.authors('/library/hit-cases/authors'),
    })
    void queryClient.invalidateQueries({ queryKey: libraryTagQueryKeys.tree })
  }
}

export const useAddHitCase = (jobId: string) => {
  const settle = useSettle(jobId)
  return useMutation({
    mutationFn: (tagIds: readonly string[]) =>
      apiFetch(hitCasePath(jobId), zHitCaseStateOut, {
        body: { tagIds: [...tagIds] } satisfies z.input<typeof zHitCaseIn>,
        fallbackErrorMessage: '加入爆款素材库失败',
        method: 'PUT',
      }),
    onSuccess: (state) => settle(state),
  })
}

export const useReplaceHitCaseTags = (jobId: string) => {
  const settle = useSettle(jobId)
  return useMutation({
    mutationFn: (tagIds: readonly string[]) =>
      apiFetch(`${hitCasePath(jobId)}/tags`, zHitCaseStateOut, {
        body: { tagIds: [...tagIds] } satisfies z.input<typeof zHitCaseTagsIn>,
        fallbackErrorMessage: '标签保存失败',
        method: 'PUT',
      }),
    onSuccess: (state) => settle(state),
  })
}

export const useRetagHitCase = (jobId: string) => {
  const settle = useSettle(jobId)
  return useMutation({
    mutationFn: () =>
      apiFetch(`${hitCasePath(jobId)}/tagging`, zHitCaseStateOut, {
        fallbackErrorMessage: '重新打标提交失败',
        method: 'POST',
      }),
    onSuccess: (state) => settle(state),
  })
}

export const useRemoveHitCase = (jobId: string) => {
  const settle = useSettle(jobId)
  return useMutation({
    mutationFn: () =>
      apiFetch(hitCasePath(jobId), zRemoveHitCaseLibraryHitCasesJobIdDeleteResponse, {
        fallbackErrorMessage: '移出失败',
        method: 'DELETE',
      }),
    onSuccess: () => settle(null),
  })
}
