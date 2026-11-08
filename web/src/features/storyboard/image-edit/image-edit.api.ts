import {
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import type { ImageGenerationIn, ImageModelOut } from '@/shared/api/generated/types.gen'
import {
  zGenerationEnvelope,
  zGenerationsPageOut,
  zImageGenerationIn,
  zImageModelsOut,
} from '@/shared/api/generated/zod.gen'
import { metadataFilterParam } from '../generation-metadata'
import {
  generationsRefetchInterval,
  storyboardQueryKeys,
  type GenerationJob,
  type GenerationsPage,
} from '../storyboard.api'
import { fileNameOfUrl } from '@/shared/lib/media-url'
import { editTargetKeyParts, editTargetMetadata } from './edit-target'
import { MAX_PART_NAME } from './image-edit-draft'
import type { EditDraftPart, FrameEditTarget } from './image-edit-types'

const EDIT_JOBS_PAGE_LIMIT = 20

export const imageEditConversationKey = (conversationId: string) =>
  [...storyboardQueryKeys.conversation(conversationId), 'frame-edits'] as const

export const imageEditQueryKey = (target: FrameEditTarget) =>
  [...imageEditConversationKey(target.conversationId), ...editTargetKeyParts(target)] as const

export const useFrameImageJobs = (conversationId: string) =>
  useQuery({
    queryKey: imageEditConversationKey(conversationId),
    queryFn: ({ signal }) =>
      apiFetch(
        `/generations?conversationId=${conversationId}&kind=image&operation=generate&limit=100`,
        zGenerationsPageOut,
        { signal, fallbackErrorMessage: '读取图片任务失败' },
      ),
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data?.items ?? []),
  })

export const imageEditJobsRefetchInterval = (
  data: { pages: readonly { items: readonly GenerationJob[] }[] } | undefined,
): number | false => generationsRefetchInterval(data?.pages.flatMap((page) => page.items) ?? [])

export function useImageEditJobs(target: FrameEditTarget) {
  return useInfiniteQuery({
    queryKey: imageEditQueryKey(target),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({
        conversationId: target.conversationId,
        kind: 'image',
        metadata: metadataFilterParam(editTargetMetadata(target)),
        limit: `${EDIT_JOBS_PAGE_LIMIT}`,
      })
      if (pageParam !== undefined) params.set('before', pageParam)
      return apiFetch(`/generations?${params}`, zGenerationsPageOut, {
        signal,
        fallbackErrorMessage: '读取图片编辑记录失败',
      })
    },
    getNextPageParam: (page) =>
      page.items.length >= EDIT_JOBS_PAGE_LIMIT ? page.items.at(-1)?.id : undefined,
    staleTime: 0,
    refetchInterval: ({ state }) => imageEditJobsRefetchInterval(state.data),
  })
}

export const seedImageEditJob = (
  queryClient: QueryClient,
  target: FrameEditTarget,
  job: GenerationJob,
) => {
  queryClient.setQueryData<InfiniteData<GenerationsPage>>(imageEditQueryKey(target), (previous) => {
    if (previous === undefined) return { pages: [{ items: [job] }], pageParams: [undefined] }
    return {
      ...previous,
      pages: previous.pages.map((page, index) =>
        index === 0 ? { items: [job, ...page.items.filter((item) => item.id !== job.id)] } : page,
      ),
    }
  })
  void queryClient.invalidateQueries({ queryKey: imageEditConversationKey(target.conversationId) })
}

export const readSubmittedImages = (job: GenerationJob) => {
  const urls = job.request?.['referenceImageUrls']
  return Array.isArray(urls) ? urls.filter((url) => typeof url === 'string') : []
}

export const readSubmittedPrompt = (job: GenerationJob) => {
  const prompt = job.request?.['prompt']
  return typeof prompt === 'string' ? prompt : ''
}

const ANNOTATION_NOTICE = '图中的编号和圈选只表示位置，输出干净的图片，不保留标注。'
const IMAGE_MARK = /@图片(\d+)/g

export const referencesAnnotation = (parts: readonly EditDraftPart[]): boolean =>
  parts.some((part) => part.kind === 'annotation')

export type EditRequest = { prompt: string; referenceImageUrls: string[] }

export function compileEditRequest(
  parts: readonly EditDraftPart[],
  ctx: {
    baseUrl: string
    annotatedUrl: string | undefined
    numberOf: (id: string) => number | undefined
  },
): EditRequest {
  const annotated = referencesAnnotation(parts)
  const first = annotated ? ctx.annotatedUrl : ctx.baseUrl
  if (first === undefined) throw new Error('引用了标注却没有标注图')
  const referenceImageUrls = [first]
  const positionOf = (url: string) => {
    if (url === ctx.baseUrl) return 1
    const at = referenceImageUrls.indexOf(url, 1)
    if (at > 0) return at + 1
    referenceImageUrls.push(url)
    return referenceImageUrls.length
  }
  const body = parts
    .map((part) => {
      if (part.kind === 'text') return part.text
      if (part.kind === 'image') return `@图片${positionOf(part.url)}`
      const number = ctx.numberOf(part.id)
      if (number === undefined) throw new Error(`标注 ${part.id} 已不在画布上`)
      return `@标注${number}`
    })
    .join('')
  return { prompt: annotated ? `${body}\n${ANNOTATION_NOTICE}` : body, referenceImageUrls }
}

export function restoreEditParts(
  request: { prompt: string; referenceImageUrls: readonly string[] },
  baseUrl: string,
): EditDraftPart[] {
  const { prompt, referenceImageUrls: urls } = request
  const notice = `\n${ANNOTATION_NOTICE}`
  const annotated = prompt.endsWith(notice)
  const body = annotated ? prompt.slice(0, -notice.length) : prompt
  const nameOf = (url: string) => {
    if (url === baseUrl) return '编辑底图'
    const fileName = fileNameOfUrl(url).slice(0, MAX_PART_NAME)
    return fileName === '' ? '图片' : fileName
  }
  const imageOf = (url: string): EditDraftPart => ({ kind: 'image', name: nameOf(url), url })
  const parts: EditDraftPart[] = []
  const mentioned = new Set<number>()
  const pushText = (text: string) => {
    if (text.length > 0) parts.push({ kind: 'text', text })
  }
  let at = 0
  for (const match of body.matchAll(IMAGE_MARK)) {
    const index = Number(match[1]) - 1
    const url = urls[index]
    if (url === undefined) continue
    pushText(body.slice(at, match.index))
    parts.push(imageOf(url))
    mentioned.add(index)
    at = match.index + match[0].length
  }
  pushText(body.slice(at))
  urls.forEach((url, index) => {
    const implicit = url === baseUrl || (index === 0 && annotated)
    if (!implicit && !mentioned.has(index)) parts.push(imageOf(url))
  })
  return parts
}

export type ImageModel = ImageModelOut

export function useImageModels() {
  return useQuery({
    queryKey: storyboardQueryKeys.imageModels,
    queryFn: ({ signal }) =>
      apiFetch('/generations/image-models', zImageModelsOut, {
        signal,
        fallbackErrorMessage: '读取图片模型失败',
      }),
    staleTime: Infinity,
  })
}

export const modelSupportsAspect = (model: ImageModel, aspectRatio: string) =>
  model.aspectRatios.includes(aspectRatio)

export type ImageResolution = NonNullable<ImageGenerationIn['resolution']>
export type ImageChannel = NonNullable<ImageGenerationIn['channel']>

export type ResolvedImageOptions = {
  model: ImageModel | undefined
  resolution: ImageResolution | undefined
  channel: ImageChannel | undefined
  aspectUnsupported: boolean
}

export function resolveImageOptions(
  models: readonly ImageModel[],
  aspectRatio: string,
  wanted: { model?: string | undefined; resolution: ImageResolution; channel: ImageChannel },
): ResolvedImageOptions {
  const usable = models.filter((model) => modelSupportsAspect(model, aspectRatio))
  const model = usable.find((item) => item.model === wanted.model) ?? usable[0]
  if (model === undefined) {
    return {
      model: undefined,
      resolution: undefined,
      channel: undefined,
      aspectUnsupported: models.length > 0,
    }
  }
  const resolutions = model.resolutions.filter(isResolution)
  const channels = model.channels.filter(isChannel)
  return {
    model,
    resolution: resolutions.includes(wanted.resolution) ? wanted.resolution : resolutions.at(-1),
    channel: channels.includes(wanted.channel) ? wanted.channel : channels[0],
    aspectUnsupported: false,
  }
}

const RESOLUTIONS: readonly string[] = zImageGenerationIn.shape.resolution.unwrap().unwrap().options
const CHANNELS: readonly string[] = zImageGenerationIn.shape.channel.unwrap().unwrap().options

export const isResolution = (value: string): value is ImageResolution => RESOLUTIONS.includes(value)
export const isChannel = (value: string): value is ImageChannel => CHANNELS.includes(value)

export async function submitImageEdit(
  target: FrameEditTarget,
  request: EditRequest,
  baseUrl: string,
  options: {
    model: string
    channel?: ImageChannel
    resolution: ImageResolution
    aspectRatio: string
  },
) {
  const body = zImageGenerationIn.parse({
    conversationId: target.conversationId,
    metadata: editTargetMetadata(target),
    sourceUrl: baseUrl,
    ...options,
    ...request,
  })
  const result = await apiFetch('/generations/image', zGenerationEnvelope, {
    method: 'POST',
    body,
    fallbackErrorMessage: '图片编辑任务提交失败',
  })
  return result.generation
}
