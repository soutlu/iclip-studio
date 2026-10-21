/** 资料库「参考视频」的接口：筛选翻成查询串、列表与详情的读取和轮询、建行与改、改标签、重拆、重新打标、移除、试生成。
 * 合同见 contract/conventions.md §14、§15。 */

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
  zTestVideoIn,
  type zReferenceTagsIn,
  type zReferenceUpdateIn,
  type zReferenceVideoItemOut,
} from '@/shared/api/generated/zod.gen'
import { aspectValueOf } from '@/shared/lib/aspect-ratio'
import { dateRangeBounds, UNBOUNDED_RANGE, type DateRange } from '@/shared/lib/date-range'
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

/** 列表的筛选：属主、时间范围、拆解全文关键词，以及选中的标签（同一维度命中任一，不同维度都要命中）。 */
export interface ReferenceScope extends DateRange {
  userName: string | null
  q: string
  tags: readonly string[]
}

export const DEFAULT_REFERENCE_SCOPE: ReferenceScope = {
  ...UNBOUNDED_RANGE,
  q: '',
  tags: [],
  userName: null,
}

export const isDefaultReferenceScope = (scope: ReferenceScope): boolean =>
  scope.userName === null &&
  scope.q.trim() === '' &&
  scope.range === 'all' &&
  scope.tags.length === 0

/** 一页的卡数，与成片素材同一个量级。 */
const REFERENCES_PAGE_SIZE = 24

/** 有排队、拆解中或打标中的行时轮询的间隔，与出片记录的轮询一致。 */
const POLL_MS = 5000

/** 后台还没拆完：排队或拆解中。 */
export const isBreakdownBusy = (status: BreakdownStatus): boolean =>
  status === 'pending' || status === 'running'

/** 后台还没打完标：排队或打标中。 */
export const isTaggingBusy = (status: TagStatus): boolean =>
  status === 'pending' || status === 'running'

/** 这一行还有后台在跑，结果会自己变：拆解或打标还没结束。 */
export const isReferenceBusy = (item: Pick<ReferenceItem, 'breakdownStatus' | 'tagStatus'>) =>
  isBreakdownBusy(item.breakdownStatus) || isTaggingBusy(item.tagStatus)

/** 试生成可选的画幅，按合同的先后。 */
const TEST_ASPECT_RATIOS: readonly TestAspectRatio[] = zTestVideoIn.shape.aspectRatio.options

/** 取与原片宽高比最接近的画幅；按比值的对数比较，竖版与横版偏差同样计算。 */
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

/** now 可注入方便测试；预设范围按此刻往前数。标签是重复的同名参数。 */
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

/** 已读的页里有还没拆完或还没打完标的行就轮询，全部结束停下；缓存留 30 分钟，看完详情退回来不缩回第一页。
 * `enabled` 为假时先不读（筛选里的标签还没对过标签树）。 */
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

/** 按人筛选的候选（属主与条数）；标签的候选与条数在标签树里。 */
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

/** 一条连同拆解正文与最新的试生成；还没拆完、还没打完标或试生成还没结束时轮询，结果自动出现。`id` 为 null 时不读。 */
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
      state.data !== undefined &&
      (isReferenceBusy(state.data) || state.data.testVideo?.status === 'running')
        ? POLL_MS
        : false,
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

/** 改、改标签、重拆、重新打标、移除之后：详情换成服务端交回的那一行，列表、属主条数与标签条数重读。 */
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

/** 改拆解正文；版本对不上或正在拆是 409，调用方按 `ApiError.status` 提示。 */
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

/** 整份替换这条在所有维度上的标签；正在排队或打标是 409，调用方按 `ApiError.status` 提示。 */
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

/** 按当前拆解重新打标：回到排队，答复改完的整行。拆解没完成或正在打标是 409。 */
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

/** 试生成：只用当前拆解的文字按给定画幅生成一条视频，答复改完的整行，详情换成它。
 * 列表项不带试生成，列表与条数不用重读。拆解未完成或上一次还没结束是 409。 */
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
