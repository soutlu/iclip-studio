import { queryOptions, useQueries, useQuery, type QueryClient } from '@tanstack/react-query'
import { apiFetch, UserFacingError } from '@/shared/api/client'
import type {
  ComposeSegmentIn,
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
import { loadCrossOriginImage } from '../cross-origin-image'
import type { SecondsRange } from '../editing/clip'
import type { PlaySegment } from '../editing/play-layout'
import { clipGenerationBlock } from './clip-generation'
import type { PixelRect, Size } from './first-frames'

const CROPPED_JPEG_QUALITY = 0.92

/** 一张图的原图尺寸；同一地址只读一次。 */
export const imageSizeQuery = (url: string) =>
  queryOptions({
    queryKey: ['image-size', url] as const,
    queryFn: async (): Promise<Size> => {
      const image = await loadCrossOriginImage(url)
      return { width: image.naturalWidth, height: image.naturalHeight }
    },
    staleTime: Infinity,
  })

/** 一条视频的像素尺寸，只读元数据；同一地址只读一次。 */
export const videoSizeQuery = (url: string) =>
  queryOptions({
    queryKey: ['video-size', url] as const,
    queryFn: () =>
      new Promise<Size>((resolve, reject) => {
        const video = document.createElement('video')
        const release = () => {
          video.onloadedmetadata = null
          video.onerror = null
          video.removeAttribute('src')
          video.load()
        }
        video.preload = 'metadata'
        video.crossOrigin = 'anonymous'
        video.onloadedmetadata = () => {
          const size = { width: video.videoWidth, height: video.videoHeight }
          release()
          resolve(size)
        }
        video.onerror = () => {
          release()
          reject(new UserFacingError('原片尺寸读取失败，请重试'))
        }
        video.src = url
      }),
    staleTime: Infinity,
  })

/** 各图的原图尺寸，按地址查；还没读到或读不到的不在里面。 */
export const useImageSizes = (urls: readonly string[]): ReadonlyMap<string, Size> =>
  useQueries({
    queries: urls.map(imageSizeQuery),
    combine: (results) =>
      new Map(
        urls.flatMap((url, index) => {
          const size = results[index]?.data
          return size === undefined ? [] : [[url, size] as const]
        }),
      ),
  })

/** 从原图上裁下 `rect`，导成 JPEG。 */
const cropImage = async (url: string, rect: PixelRect): Promise<File> => {
  const image = await loadCrossOriginImage(url)
  const canvas = document.createElement('canvas')
  canvas.width = rect.width
  canvas.height = rect.height
  const context = canvas.getContext('2d')
  if (context === null) throw new UserFacingError('当前浏览器不支持裁切图片')
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', CROPPED_JPEG_QUALITY),
  )
  if (blob === null) throw new UserFacingError('图片裁切失败，请重试')
  return new File([blob], 'frame.jpg', { type: 'image/jpeg' })
}

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
    /** 要先裁的图：原地址到原图上的像素框。裁好上传，新地址代替原地址发送。 */
    frameCrops?: ReadonlyMap<string, PixelRect> | undefined
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
  const referenceImageUrls = await Promise.all(
    input.referenceImageUrls.map(async (url) => {
      const rect = input.frameCrops?.get(url)
      if (rect === undefined) return url
      return (await uploadMediaFile(await cropImage(url, rect), 'image')).url
    }),
  )
  const body: VideoEditIn = {
    conversation_id: input.conversationId,
    task_id: input.taskId,
    source_job_id: input.sourceJobId,
    range_start_ms: Math.round(input.range.start * 1000),
    range_end_ms: Math.round(input.range.end * 1000),
    reference_video_urls: referenceVideoUrls,
    model: model.id,
    prompt: input.prompt,
    reference_image_urls: referenceImageUrls,
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
  input: Origin & { baseJobId: string; segments: readonly ComposeSegmentIn[] },
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
