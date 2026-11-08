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
  all: [ROOT] as const,
  source: (sourceId: string) => [ROOT, sourceId] as const,
  submit: [ROOT, 'submit'] as const,
}

const isRunning = (status: EnhanceJob['status']): boolean =>
  status === 'pending' || status === 'submitting' || status === 'submitted'

export const enhanceNoticeId = (sourceId: string, resolution: EnhanceResolution) =>
  `video-enhance:${sourceId}:${resolution}`

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

export const readGeneration = async (jobId: string): Promise<EnhanceJob> => {
  const envelope = await apiFetch(`/generations/${jobId}`, zGenerationEnvelope, {
    fallbackErrorMessage: '读取生成记录失败',
  })
  return envelope.generation
}

export type SubmitEnhancementInput = { sourceJobId: string; resolution: EnhanceResolution }

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

export type EnhanceTierRow =
  | { state: 'none'; resolution: EnhanceResolution }
  | { state: 'running'; resolution: EnhanceResolution; since: string }
  | { state: 'done'; resolution: EnhanceResolution; url: string; jobId: string; mine: boolean }
  | { state: 'failed'; resolution: EnhanceResolution; jobId: string; mine: boolean }

type PendingSubmit = { resolution: EnhanceResolution; since: string }

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

export const settledOwnJobIds = (rows: readonly EnhanceTierRow[]): string[] =>
  rows.flatMap((row) =>
    (row.state === 'done' || row.state === 'failed') && row.mine ? [row.jobId] : [],
  )

export type EnhanceBadge = 'running' | 'failed' | 'done'

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
