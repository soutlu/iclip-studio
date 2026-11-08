import { queryOptions, useQuery } from '@tanstack/react-query'
import { type z } from 'zod'
import { ApiError, apiFetch } from '@/shared/api/client'
import { drainPages } from '@/shared/api/paging'
import type { VideoGenerationIn, VideoShotIn } from '@/shared/api/generated/types.gen'
import {
  zGenerationsPageOut,
  zVideoModelsOut,
  zVideoShotIn,
  zVideoSubmitOut,
} from '@/shared/api/generated/zod.gen'
import type { zGenerationOut } from '@/shared/api/generated/zod.gen'
import type { Shot } from './shot-document'
import { isRunningStatus } from './shots'
import type { VideoResolution } from './video-generation-options'

export type GenerationJob = z.infer<typeof zGenerationOut>

export type GenerationsPage = z.infer<typeof zGenerationsPageOut>

const PAGE_LIMIT = 100

const POLL_MS = 5000

const conversationGenerationsKey = (conversationId: string) =>
  ['generations', 'conversation', conversationId] as const

export const storyboardQueryKeys = {
  conversation: conversationGenerationsKey,
  videoJobs: (conversationId: string) =>
    [...conversationGenerationsKey(conversationId), 'video'] as const,
  imageModels: ['generations', 'image-models'] as const,
  videoModels: ['generations', 'video-models'] as const,
}

export const useVideoModels = () =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch('/generations/video-models', zVideoModelsOut, {
        fallbackErrorMessage: '读取视频模型失败',
        signal,
      }),
    queryKey: storyboardQueryKeys.videoModels,
    staleTime: Infinity,
  })

export type VideoGenerationInput = {
  conversationId: string
  aspectRatio: string
  model: string
  resolution: VideoResolution
  generateAudio: boolean
  shot: Shot
}

export const historyShotOf = (job: GenerationJob): Shot['prompt'] | undefined => {
  const parsed = zVideoShotIn.safeParse(job.request?.['shot'])
  return parsed.success ? parsed.data : undefined
}

export const submitVideoGeneration = async (input: VideoGenerationInput): Promise<string> => {
  const shot: VideoShotIn = input.shot.prompt
  const body: VideoGenerationIn = {
    aspect_ratio: input.aspectRatio,
    conversation_id: input.conversationId,
    generate_audio: input.generateAudio,
    model: input.model,
    reference_image_urls: [...input.shot.image_urls],
    resolution: input.resolution,
    seconds: input.shot.seconds,
    shot,
    shot_index: input.shot.index,
  }
  const receipt = await apiFetch('/generations/video', zVideoSubmitOut, {
    body,
    fallbackErrorMessage: '视频提交失败',
    method: 'POST',
  })
  return receipt.task_id
}

export const generationsRefetchInterval = (
  items: readonly { status: GenerationJob['status'] }[],
): number | false => (items.some((item) => isRunningStatus(item.status)) ? POLL_MS : false)

export const readAllGenerations = (
  filter: Readonly<Record<string, string>>,
  signal: AbortSignal,
  errorMessage: string,
) =>
  drainPages<GenerationJob, string>(async (before) => {
    const params = new URLSearchParams({ ...filter, limit: `${PAGE_LIMIT}` })
    if (before !== undefined) params.set('before', before)
    const page = await apiFetch(`/generations?${params}`, zGenerationsPageOut, {
      fallbackErrorMessage: errorMessage,
      signal,
    })
    if (page.items.length < PAGE_LIMIT) return { items: page.items, next: null }
    const last = page.items.at(-1)
    if (last === undefined || last.id === before) {
      throw new ApiError(0, `${errorMessage}：分页异常，请重试`)
    }
    return { items: page.items, next: last.id }
  })

export const readConversationVideoJobs = (conversationId: string, signal: AbortSignal) =>
  readAllGenerations({ conversationId, kind: 'video' }, signal, '读取视频记录失败')

export const conversationVideoJobsQuery = (conversationId: string) =>
  queryOptions({
    queryFn: ({ signal }) => readConversationVideoJobs(conversationId, signal),
    queryKey: storyboardQueryKeys.videoJobs(conversationId),
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data ?? []),
  })

export const useShotGenerations = (conversationId: string) =>
  useQuery(conversationVideoJobsQuery(conversationId))
