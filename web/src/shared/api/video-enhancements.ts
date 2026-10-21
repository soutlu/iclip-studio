/** 高清版（超分）：读一条成片或导出的整片各档的超分记录、提交一档。约定见 contract/conventions.md「高清版」。
 *
 * 各处下载按钮、整片顶栏与全局提示读同一份查询，键以 `['video-enhancements']` 打头、按来源区分；
 * 超分记录的状态跳转帧到了由 app 层失效整个前缀，在跑的时候另按 5 秒轮询兜底。 */

import {
  queryOptions,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch, errorMessageOf } from '@/shared/api/client'
import type { VideoEnhanceIn } from '@/shared/api/generated/types.gen'
import { zGenerationEnvelope, zVideoEnhancementsOut } from '@/shared/api/generated/zod.gen'
import { toast } from '@/shared/ui/toast'

export type VideoEnhancements = z.output<typeof zVideoEnhancementsOut>
export type EnhanceResolution = VideoEnhanceIn['resolution']
type EnhanceJob = z.output<typeof zGenerationEnvelope>['generation']

const POLL_MS = 5000

const ROOT = 'video-enhancements'

export const videoEnhancementsKeys = {
  /** 全部来源的高清版查询；超分帧到了或重连后失效它。 */
  all: [ROOT] as const,
  source: (sourceId: string) => [ROOT, sourceId] as const,
  submit: [ROOT, 'submit'] as const,
}

const isRunning = (status: EnhanceJob['status']): boolean =>
  status === 'pending' || status === 'submitting' || status === 'submitted'

/** 某个来源某一档的完成或失败提示条；用户在别处下载或重做了这一档时按它收起。 */
export const enhanceNoticeId = (sourceId: string, resolution: EnhanceResolution) =>
  `video-enhance:${sourceId}:${resolution}`

/** 一条来源各档的高清版；有档在跑时每 5 秒重拉，全部落定后停。 */
export const videoEnhancementsQuery = (sourceId: string) =>
  queryOptions({
    queryFn: ({ signal }) =>
      apiFetch(`/generations/${sourceId}/enhancements`, zVideoEnhancementsOut, {
        fallbackErrorMessage: '读取高清版失败',
        signal,
      }),
    queryKey: videoEnhancementsKeys.source(sourceId),
    refetchInterval: ({ state }) =>
      state.data?.tiers.some((tier) => tier.job !== null && isRunning(tier.job.status))
        ? POLL_MS
        : false,
  })

/** 读一条生成记录；只读得到自己的。 */
export const readGeneration = async (jobId: string): Promise<EnhanceJob> => {
  const envelope = await apiFetch(`/generations/${jobId}`, zGenerationEnvelope, {
    fallbackErrorMessage: '读取生成记录失败',
  })
  return envelope.generation
}

export type SubmitEnhancementInput = { sourceJobId: string; resolution: EnhanceResolution }

/**
 * 提交一档高清版。同一来源同一档已有没失败的记录时服务端直接给那一条，所以连点不会重复做。
 * 提交即收起这一档的提示条；成功后先把回来的记录写进这条来源的查询，免得那一行在重拉前闪回旧状态。
 * 不带 userName：浏览器会话由服务端填登录用户名。
 */
export const useSubmitVideoEnhancement = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: SubmitEnhancementInput) => {
      const body: VideoEnhanceIn = input
      const envelope = await apiFetch('/generations/video-enhancements', zGenerationEnvelope, {
        body,
        fallbackErrorMessage: `高清版 ${input.resolution} 提交失败，请重试`,
        method: 'POST',
      })
      return envelope.generation
    },
    mutationKey: videoEnhancementsKeys.submit,
    onMutate: (input) => {
      toast.dismiss(enhanceNoticeId(input.sourceJobId, input.resolution))
    },
    onError: (error, input) => {
      toast.error(errorMessageOf(error, `高清版 ${input.resolution} 提交失败，请重试`))
    },
    onSuccess: (job, input) => {
      const key = videoEnhancementsQuery(input.sourceJobId).queryKey
      queryClient.setQueryData(key, (data) =>
        data === undefined
          ? data
          : {
              ...data,
              tiers: data.tiers.map((tier) =>
                tier.resolution === input.resolution ? { ...tier, job } : tier,
              ),
            },
      )
      void queryClient.invalidateQueries({ queryKey: key })
    },
  })
}

/**
 * 菜单里一档的样子：还没做、在做（从 `since` 起计时）、做好（`url` 是高清原片）、没做成。
 * 有了结果的两种带上那条超分记录的 `jobId`，`mine` 是它是不是自己的。
 */
export type EnhanceTierRow =
  | { state: 'none'; resolution: EnhanceResolution }
  | { state: 'running'; resolution: EnhanceResolution; since: string }
  | { state: 'done'; resolution: EnhanceResolution; url: string; jobId: string; mine: boolean }
  | { state: 'failed'; resolution: EnhanceResolution; jobId: string; mine: boolean }

type PendingSubmit = { resolution: EnhanceResolution; since: string }

/**
 * 各档按服务端给的先后（从高到低）换成菜单行。提交请求还在路上的那一档按「在做」算，防止连点；
 * 完成却没有地址的记录下载不了，按没做成算。
 */
export const enhanceTierRows = (
  tiers: VideoEnhancements['tiers'],
  pending: readonly PendingSubmit[],
): EnhanceTierRow[] =>
  tiers.map(({ job, mine, resolution }): EnhanceTierRow => {
    const submitting = pending.find((item) => item.resolution === resolution)
    if (submitting !== undefined) return { resolution, since: submitting.since, state: 'running' }
    if (job === null) return { resolution, state: 'none' }
    if (isRunning(job.status)) return { resolution, since: job.createdAt, state: 'running' }
    if (job.status === 'completed' && job.outputUrl !== null)
      return { jobId: job.id, mine, resolution, state: 'done', url: job.outputUrl }
    return { jobId: job.id, mine, resolution, state: 'failed' }
  })

/** 自己的、有了结果的那几档的超分记录 id；打开下载菜单时把它们记成看过。 */
export const settledOwnJobIds = (rows: readonly EnhanceTierRow[]): string[] =>
  rows.flatMap((row) =>
    (row.state === 'done' || row.state === 'failed') && row.mine ? [row.jobId] : [],
  )

export type EnhanceBadge = 'running' | 'failed' | 'done'

/**
 * 下载按钮上的高清版状态，只出一种：有一档在做（谁的都算）为 running；否则有自己的、没看过的
 * 没做成为 failed；再否则有自己的、没看过的做好为 done；都没有为 null。
 */
export const enhanceBadge = (
  rows: readonly EnhanceTierRow[],
  seen: ReadonlySet<string>,
): EnhanceBadge | null => {
  if (rows.some((row) => row.state === 'running')) return 'running'
  const unseen = new Set(settledOwnJobIds(rows).filter((id) => !seen.has(id)))
  const has = (state: 'done' | 'failed') =>
    rows.some((row) => row.state === state && unseen.has(row.jobId))
  if (has('failed')) return 'failed'
  if (has('done')) return 'done'
  return null
}

/**
 * 一条来源的高清版各档（菜单行），连同正在提交的那几档；`sourceId` 不给就不发请求、没有档。
 * 读不出来时同样没有档，下载照旧可用。
 */
export const useEnhanceTiers = (sourceId: string | undefined) => {
  const query = useQuery({
    ...videoEnhancementsQuery(sourceId ?? ''),
    enabled: sourceId !== undefined,
  })
  const pending = useMutationState({
    filters: {
      mutationKey: videoEnhancementsKeys.submit,
      predicate: (mutation) =>
        (mutation.state.variables as SubmitEnhancementInput | undefined)?.sourceJobId === sourceId,
      status: 'pending',
    },
    select: (mutation): PendingSubmit => ({
      resolution: (mutation.state.variables as SubmitEnhancementInput).resolution,
      since: new Date(mutation.state.submittedAt).toISOString(),
    }),
  })
  return sourceId === undefined ? [] : enhanceTierRows(query.data?.tiers ?? [], pending)
}
