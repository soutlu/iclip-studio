import { useQuery, type QueryClient } from '@tanstack/react-query'
import { apiFetch, UserFacingError } from '@/shared/api/client'
import type {
  VideoClipModelOut,
  VideoComposeIn,
  VideoEditIn,
} from '@/shared/api/generated/types.gen'
import { zGenerationEnvelope } from '@/shared/api/generated/zod.gen'
import { uploadMediaFile } from '@/shared/api/media-upload'
import {
  generationsRefetchInterval,
  readAllGenerations,
  storyboardQueryKeys,
  type GenerationJob,
  type GenerationsPage,
} from '../storyboard.api'
import type { Clip, SecondsRange } from '../editing/clip'
import type { PlaySegment } from '../editing/play-layout'
import { clipGenerationBlock } from './clip-generation'

export const videoEditConversationKey = (conversationId: string) =>
  [...storyboardQueryKeys.conversation(conversationId), 'video-edits'] as const

export const videoEditChainKey = (conversationId: string, rootJobId: string) =>
  [...videoEditConversationKey(conversationId), rootJobId] as const

export const useVideoEditChain = (conversationId: string, rootJobId: string) =>
  useQuery({
    queryKey: videoEditChainKey(conversationId, rootJobId),
    queryFn: async ({ signal }): Promise<GenerationsPage> => ({
      items: await readAllGenerations({ conversationId, rootJobId }, signal, '读取编辑记录失败'),
    }),
    staleTime: 0,
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data?.items ?? []),
  })

export const seedVideoEditJob = (
  queryClient: QueryClient,
  conversationId: string,
  rootJobId: string,
  job: GenerationJob,
) => {
  queryClient.setQueryData<GenerationsPage>(
    videoEditChainKey(conversationId, rootJobId),
    (previous) => ({
      items: [job, ...(previous?.items ?? []).filter((item) => item.id !== job.id)],
    }),
  )
  void queryClient.invalidateQueries({ queryKey: videoEditConversationKey(conversationId) })
}

export const pickGenerationModel = (
  models: readonly string[],
  wanted: string | undefined,
  fallback: string | undefined,
): string | undefined =>
  models.find((item) => item === wanted) ?? models.find((item) => item === fallback) ?? models[0]

type Origin = {
  conversationId: string
  taskId: string | null
}

type ClipGeneration =
  { mode: 'image'; seconds: number } | { mode: 'edit'; referenceClips: readonly PlaySegment[] }

export const submitClipGeneration = async (
  input: Origin & {
    sourceJobId: string
    range: SecondsRange
    model: VideoClipModelOut
    prompt: string
    referenceImageUrls: readonly string[]
    generation: ClipGeneration
  },
): Promise<GenerationJob> => {
  const { generation, model } = input
  const block = clipGenerationBlock(model, {
    mode: generation.mode,
    seconds:
      generation.mode === 'image'
        ? generation.seconds
        : generation.referenceClips.reduce((sum, clip) => sum + clip.end - clip.start, 0),
    referenceImageCount: input.referenceImageUrls.length,
  })
  if (block !== undefined) throw new UserFacingError(block.message)
  let referenceVideoUrls: string[] = []
  if (generation.mode === 'edit') {
    const { concatenateReferenceClips } = await import('./reference-clip')
    const file = await concatenateReferenceClips(generation.referenceClips)
    const { url } = await uploadMediaFile(file, 'video')
    referenceVideoUrls = [url]
  }
  const body: VideoEditIn = {
    conversation_id: input.conversationId,
    task_id: input.taskId,
    source_job_id: input.sourceJobId,
    range_start_ms: Math.round(input.range.start * 1000),
    range_end_ms: Math.round(input.range.end * 1000),
    reference_video_urls: referenceVideoUrls,
    model: model.id,
    prompt: input.prompt,
    reference_image_urls: [...input.referenceImageUrls],
    seconds: generation.mode === 'image' ? generation.seconds : -1,
  }
  const result = await apiFetch('/generations/video-edits', zGenerationEnvelope, {
    method: 'POST',
    body,
    fallbackErrorMessage: '片段生成提交失败',
  })
  return result.generation
}

export const submitVideoComposite = async (
  input: Origin & { baseJobId: string; segments: readonly Clip[] },
): Promise<GenerationJob> => {
  const body: VideoComposeIn = {
    conversationId: input.conversationId,
    taskId: input.taskId,
    baseJobId: input.baseJobId,
    segments: [...input.segments],
  }
  const result = await apiFetch('/generations/video-composites', zGenerationEnvelope, {
    method: 'POST',
    body,
    fallbackErrorMessage: '合成任务提交失败',
  })
  return result.generation
}
