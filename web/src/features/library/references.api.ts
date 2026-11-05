import {
  queryOptions,
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch, apiFetchWithResponse, ApiError } from '@/shared/api/client'
import {
  zReferenceFiltersOut,
  zRemoveReferenceReferencesReferenceIdDeleteResponse,
  zReferenceVideoOut,
  zReferenceVideosOut,
  zTestVideoIn,
  type zReferenceTagsIn,
  type zReferenceUpdateIn,
  type zReferenceVideoItemOut,
} from '@/shared/api/generated/zod.gen'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import { dateRangeBounds } from '@/shared/lib/date-range'
import {
  DEFAULT_LIBRARY_TAG_SCOPE,
  isDefaultLibraryTagScope,
  type LibraryTagScope,
} from './library-tag-scope'
import { libraryTagQueryKeys } from './library-tags.api'

export type ReferencesPage = z.output<typeof zReferenceVideosOut>
export type ReferenceItem = z.output<typeof zReferenceVideoItemOut>
export type ReferenceDetail = z.output<typeof zReferenceVideoOut>
export type ReferenceUpdate = z.input<typeof zReferenceUpdateIn>
type ReferenceTagsIn = z.input<typeof zReferenceTagsIn>
export type BreakdownStatus = ReferenceItem['breakdownStatus']
export type BreakdownError = NonNullable<ReferenceItem['errorCode']>
export type TagStatus = ReferenceItem['tagStatus']
export type TagError = NonNullable<ReferenceItem['tagError']>
export type TestVideo = NonNullable<ReferenceDetail['testVideo']>
export type TestAspectRatio = z.input<typeof zTestVideoIn>['aspectRatio']

export interface ReferenceScope extends LibraryTagScope {
  q: string
}

export const DEFAULT_REFERENCE_SCOPE: ReferenceScope = {
  ...DEFAULT_LIBRARY_TAG_SCOPE,
  q: '',
}

export const isDefaultReferenceScope = (scope: ReferenceScope): boolean =>
  isDefaultLibraryTagScope(scope) && scope.q.trim() === ''

const REFERENCES_PAGE_SIZE = 24

const POLL_MS = 5000

export const isBreakdownBusy = (status: BreakdownStatus): boolean =>
  status === 'pending' || status === 'running'

export const isTaggingBusy = (status: TagStatus): boolean =>
  status === 'pending' || status === 'running'

export const isReferenceBusy = (item: Pick<ReferenceItem, 'breakdownStatus' | 'tagStatus'>) =>
  isBreakdownBusy(item.breakdownStatus) || isTaggingBusy(item.tagStatus)

const TEST_ASPECT_RATIOS: readonly TestAspectRatio[] = zTestVideoIn.shape.aspectRatio.options

export const nearestTestAspectRatio = (ratio: number): TestAspectRatio => {
  let best: TestAspectRatio = '9:16'
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of TEST_ASPECT_RATIOS) {
    const distance = Math.abs(Math.log(ratio / aspectValueOf(candidate)))
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

export const referenceSearchParams = (
  scope: ReferenceScope,
  cursor: string | null,
  now: Date = new Date(),
): URLSearchParams => {
  const params = new URLSearchParams()
  const { since, until } = dateRangeBounds(scope, now)
  if (since !== null) params.set('since', since.toISOString())
  if (until !== null) params.set('until', until.toISOString())
  if (scope.userName !== null) params.set('userName', scope.userName)
  for (const id of scope.tags) params.append('tags', id)
  const keyword = scope.q.trim()
  if (keyword !== '') params.set('q', keyword)
  params.set('limit', String(REFERENCES_PAGE_SIZE))
  if (cursor !== null) params.set('cursor', cursor)
  return params
}

export const referenceQueryKeys = {
  all: ['references'] as const,
  list: (scope: ReferenceScope) => ['references', 'list', scope] as const,
  detail: (id: string) => ['references', 'detail', id] as const,
  filters: ['references', 'filters'] as const,
}

const READ_LIST_FAILED = '读取参考视频失败'

export const useReferences = (scope: ReferenceScope, enabled = true) =>
  useInfiniteQuery({
    enabled,
    gcTime: 30 * 60_000,
    queryFn: ({ pageParam, signal }) =>
      apiFetch(
        `/references?${referenceSearchParams(scope, pageParam).toString()}`,
        zReferenceVideosOut,
        { fallbackErrorMessage: READ_LIST_FAILED, signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ReferencesPage) => last.nextCursor,
    queryKey: referenceQueryKeys.list(scope),
    refetchInterval: ({ state }) =>
      state.data?.pages.some((page) => page.items.some(isReferenceBusy)) ? POLL_MS : false,
  })

export const useReferenceFilters = () =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch('/references/filters', zReferenceFiltersOut, {
        fallbackErrorMessage: '读取筛选项失败',
        signal,
      }),
    queryKey: referenceQueryKeys.filters,
  })

const referencePath = (id: string) => `/references/${encodeURIComponent(id)}`

export const referenceDetailOptions = (id: string | null) =>
  queryOptions({
    queryFn:
      id === null
        ? skipToken
        : async ({ client, signal }) => {
            const previous = client.getQueryData<ReferenceDetail>(referenceQueryKeys.detail(id))
            const reference = await apiFetch(referencePath(id), zReferenceVideoOut, {
              fallbackErrorMessage: '读取该参考视频失败',
              signal,
            })
            if (
              previous !== undefined &&
              isReferenceBusy(previous) &&
              !isReferenceBusy(reference)
            ) {
              void client.invalidateQueries({ queryKey: ['references', 'list'] })
              void client.invalidateQueries({ queryKey: referenceQueryKeys.filters })
              void client.invalidateQueries({ queryKey: libraryTagQueryKeys.tree })
            }
            return reference
          },
    queryKey: referenceQueryKeys.detail(id ?? ''),
    refetchInterval: ({ state }) =>
      !(state.error instanceof ApiError && state.error.status === 404) &&
      state.data !== undefined &&
      (isReferenceBusy(state.data) || state.data.testVideo?.status === 'running')
        ? POLL_MS
        : false,
  })

export const useReference = (id: string | null) => useQuery(referenceDetailOptions(id))

export const createReference = async (
  uploadId: string,
): Promise<{ reference: ReferenceDetail; created: boolean }> => {
  const { data, response } = await apiFetchWithResponse('/references', zReferenceVideoOut, {
    body: { uploadId },
    fallbackErrorMessage: '添加到资料库失败',
    method: 'POST',
  })
  return { created: response.status === 201, reference: data }
}

const useSettle = () => {
  const queryClient = useQueryClient()
  return (reference: ReferenceDetail | null, id: string) => {
    if (reference === null) queryClient.removeQueries({ queryKey: referenceQueryKeys.detail(id) })
    else queryClient.setQueryData(referenceQueryKeys.detail(id), reference)
    void queryClient.invalidateQueries({ queryKey: ['references', 'list'] })
    void queryClient.invalidateQueries({ queryKey: referenceQueryKeys.filters })
    void queryClient.invalidateQueries({ queryKey: libraryTagQueryKeys.tree })
  }
}

export const useUpdateReference = (id: string) => {
  const settle = useSettle()
  return useMutation({
    mutationFn: (body: ReferenceUpdate) =>
      apiFetch(referencePath(id), zReferenceVideoOut, {
        body,
        fallbackErrorMessage: '保存失败',
        method: 'PATCH',
      }),
    onSuccess: (reference) => settle(reference, id),
  })
}

export const useRerunReference = (id: string) => {
  const settle = useSettle()
  return useMutation({
    mutationFn: () =>
      apiFetch(`${referencePath(id)}/breakdowns`, zReferenceVideoOut, {
        fallbackErrorMessage: '重新拆解提交失败',
        method: 'POST',
      }),
    onSuccess: (reference) => settle(reference, id),
  })
}

export const useReplaceReferenceTags = (id: string) => {
  const settle = useSettle()
  return useMutation({
    mutationFn: (tagIds: readonly string[]) =>
      apiFetch(`${referencePath(id)}/tags`, zReferenceVideoOut, {
        body: { tagIds: [...tagIds] } satisfies ReferenceTagsIn,
        fallbackErrorMessage: '标签保存失败',
        method: 'PUT',
      }),
    onSuccess: (reference) => settle(reference, id),
  })
}

export const useRetagReference = (id: string) => {
  const settle = useSettle()
  return useMutation({
    mutationFn: () =>
      apiFetch(`${referencePath(id)}/tagging`, zReferenceVideoOut, {
        fallbackErrorMessage: '重新打标提交失败',
        method: 'POST',
      }),
    onSuccess: (reference) => settle(reference, id),
  })
}

export const useStartTestVideo = (id: string) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (aspectRatio: TestAspectRatio) =>
      apiFetch(`${referencePath(id)}/test-generations`, zReferenceVideoOut, {
        body: { aspectRatio },
        fallbackErrorMessage: '试生成失败',
        method: 'POST',
      }),
    onSuccess: (reference) => queryClient.setQueryData(referenceQueryKeys.detail(id), reference),
  })
}

export const useRemoveReference = (id: string) => {
  const settle = useSettle()
  return useMutation({
    mutationFn: () =>
      apiFetch(referencePath(id), zRemoveReferenceReferencesReferenceIdDeleteResponse, {
        fallbackErrorMessage: '移除失败',
        method: 'DELETE',
      }),
    onSuccess: () => settle(null, id),
  })
}
