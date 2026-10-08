/** 资料库「参考视频」的接口：筛选翻成查询串、列表与详情的读取和轮询、建行与改、重拆、移除。合同见 contract/conventions.md §14。 */

import {
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch, apiFetchWithResponse } from '@/shared/api/client'
import {
  zReferenceFiltersOut,
  zRemoveReferenceReferencesReferenceIdDeleteResponse,
  zReferenceVideoOut,
  zReferenceVideosOut,
  type zReferenceUpdateIn,
  type zReferenceVideoItemOut,
} from '@/shared/api/generated/zod.gen'
import { dateRangeBounds, UNBOUNDED_RANGE, type DateRange } from '@/shared/lib/date-range'

export type ReferencesPage = z.output<typeof zReferenceVideosOut>
export type ReferenceItem = z.output<typeof zReferenceVideoItemOut>
export type ReferenceDetail = z.output<typeof zReferenceVideoOut>
export type ReferenceFilters = z.output<typeof zReferenceFiltersOut>
export type ReferenceUpdate = z.input<typeof zReferenceUpdateIn>
export type VideoType = ReferenceItem['videoTypes'][number]
export type Category = ReferenceItem['categories'][number]
export type BreakdownStatus = ReferenceItem['breakdownStatus']
export type BreakdownError = NonNullable<ReferenceItem['errorCode']>

/** 合同里的两份清单：片子类型的取值（名称与说明另由 /references/filters 给）与全部品类，都按合同的先后。 */
export const zVideoType = zReferenceVideoOut.shape.videoTypes.element
export const zCategory = zReferenceVideoOut.shape.categories.element
export const VIDEO_TYPE_VALUES: readonly VideoType[] = zVideoType.options
export const CATEGORY_VALUES: readonly Category[] = zCategory.options

/** 列表的筛选：属主、时间范围、拆解全文关键词，以及两组标签（组内命中任一，两组都给时都要命中）。 */
export interface ReferenceScope extends DateRange {
  userName: string | null
  q: string
  videoTypes: readonly VideoType[]
  categories: readonly Category[]
}

export const DEFAULT_REFERENCE_SCOPE: ReferenceScope = {
  ...UNBOUNDED_RANGE,
  categories: [],
  q: '',
  userName: null,
  videoTypes: [],
}

export const isDefaultReferenceScope = (scope: ReferenceScope): boolean =>
  scope.userName === null &&
  scope.q.trim() === '' &&
  scope.range === 'all' &&
  scope.videoTypes.length === 0 &&
  scope.categories.length === 0

/** 一页的卡数，与成片同一个量级。 */
const REFERENCES_PAGE_SIZE = 24

/** 有排队或拆解中的行时轮询的间隔，与出片记录的轮询一致。 */
const POLL_MS = 5000

/** 后台还没拆完：排队或拆解中。 */
export const isBreakdownBusy = (status: BreakdownStatus): boolean =>
  status === 'pending' || status === 'running'

/** now 可注入方便测试；预设范围按此刻往前数。两组标签是重复的同名参数。 */
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
  for (const value of scope.videoTypes) params.append('videoTypes', value)
  for (const value of scope.categories) params.append('categories', value)
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

/** 已读的页里有还没拆完的行就轮询，全部拆完停下；缓存留 30 分钟，看完详情退回来不缩回第一页。 */
export const useReferences = (scope: ReferenceScope) =>
  useInfiniteQuery({
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
      state.data?.pages.some((page) =>
        page.items.some((item) => isBreakdownBusy(item.breakdownStatus)),
      )
        ? POLL_MS
        : false,
  })

/** 两组筛选的候选与条数；`poll` 为真时跟着列表一起轮询，拆完自动打的标签会改条数。 */
export const useReferenceFilters = (poll: boolean) =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch('/references/filters', zReferenceFiltersOut, {
        fallbackErrorMessage: '读取筛选项失败',
        signal,
      }),
    queryKey: referenceQueryKeys.filters,
    refetchInterval: poll ? POLL_MS : false,
  })

const referencePath = (id: string) => `/references/${encodeURIComponent(id)}`

/** 一条连同拆解正文；还没拆完时轮询，拆完的结果自动出现。`id` 为 null 时不读。 */
export const useReference = (id: string | null) =>
  useQuery({
    queryFn:
      id === null
        ? skipToken
        : ({ signal }) =>
            apiFetch(referencePath(id), zReferenceVideoOut, {
              fallbackErrorMessage: '读取该参考视频失败',
              signal,
            }),
    queryKey: referenceQueryKeys.detail(id ?? ''),
    refetchInterval: ({ state }) =>
      state.data !== undefined && isBreakdownBusy(state.data.breakdownStatus) ? POLL_MS : false,
  })

/** 用一次确认过的视频上传建行。`created` 为假表示这条视频已经在资料库里（200），交回的是原来那一行。 */
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

/** 改、重拆、移除之后：详情换成服务端交回的那一行，列表与条数重读。 */
const useSettle = () => {
  const queryClient = useQueryClient()
  return (reference: ReferenceDetail | null, id: string) => {
    if (reference === null) queryClient.removeQueries({ queryKey: referenceQueryKeys.detail(id) })
    else queryClient.setQueryData(referenceQueryKeys.detail(id), reference)
    void queryClient.invalidateQueries({ queryKey: ['references', 'list'] })
    void queryClient.invalidateQueries({ queryKey: referenceQueryKeys.filters })
  }
}

/** 整份改拆解与两组标签；版本对不上或正在拆是 409，调用方按 `ApiError.status` 提示。 */
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

/** 重新拆解：回到排队，答复改完的整行。 */
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

/** 从资料库移除；之后对这一行的读写都是 404。 */
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
