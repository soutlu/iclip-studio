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

/** 按格编辑记录一页取几条；取满一页才可能还有更早的，不满就是翻到底了。 */
const EDIT_JOBS_PAGE_LIMIT = 20

/** 本对话全部参考帧编辑记录的查询前缀，挂在本对话生成记录的前缀下；按格的键挂在它下面，失效前缀即失效全部。 */
export const imageEditConversationKey = (conversationId: string) =>
  [...storyboardQueryKeys.conversation(conversationId), 'frame-edits'] as const

export const imageEditQueryKey = (target: FrameEditTarget) =>
  [...imageEditConversationKey(target.conversationId), ...editTargetKeyParts(target)] as const

/** 本对话最近的图片任务，给分镜页在帧上挂状态用。
 *
 * 键就是按格查询的前缀，一次失效两边一起重拉；倒序取 100 条够用，在跑的任务一定是最近的。
 * 只取调模型的：切图记录不带坐标、不上角标，排除掉免得挤窗口。
 * 状态跳转帧到了由 useLiveGenerations 立刻失效；有任务在跑时仍每 5 秒轮询兜底。 */
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

/** 按格编辑记录的轮询兜底：已翻开的各页并起来，与生成列表同一口径。 */
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
    // 编辑器按需打开，页面上的角标可能已经知道任务落定了；打开就重拉，不吃全局 30 秒的新鲜期。
    staleTime: 0,
    // 状态跳转帧到了由 useLiveGenerations 立刻失效；有任务在跑时仍轮询兜底。
    refetchInterval: ({ state }) => imageEditJobsRefetchInterval(state.data),
  })
}

/** 刚受理的任务先放进这一格已翻开的第一页最前面，再失效本对话前缀：分镜页帧上的角标也读它，新任务立刻冒出来。 */
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

/** 提交过的那一批图片，用来把历史记录装回编辑器。 */
export const readSubmittedImages = (job: GenerationJob) => {
  const urls = job.request?.['referenceImageUrls']
  return Array.isArray(urls) ? urls.filter((url) => typeof url === 'string') : []
}

export const readSubmittedPrompt = (job: GenerationJob) => {
  const prompt = job.request?.['prompt']
  return typeof prompt === 'string' ? prompt : ''
}

/** 不说这句，模型会把圈和编号一起画进结果里。 */
const ANNOTATION_NOTICE = '图中的编号和圈选只表示位置，输出干净的图片，不保留标注。'
const IMAGE_MARK = /@图片(\d+)/g

/** 正文里有没有引用标注：引用了就要导出一张标注图代替干净底图。 */
export const referencesAnnotation = (parts: readonly EditDraftPart[]): boolean =>
  parts.some((part) => part.kind === 'annotation')

/** 一次编辑请求的正文与图片，与合同 `prompt` / `referenceImageUrls` 同义。 */
export type EditRequest = { prompt: string; referenceImageUrls: string[] }

/** 把修改要求编成请求：chip 落成 `@图片N` / `@标注N`，N 是图片在 `referenceImageUrls` 里的位置、标注在画布上的编号。
 *
 * 底图只发一张，固定是 `@图片1`：引用了标注时发导出的标注图（干净底图不再发）并在末尾补一句说明，否则发干净底图。
 * 正文里指向底图的图片（「编辑底图」、帧 @N 恰好是底图）同样落成 `@图片1`；其余图片按地址去重，按首次出现的顺序排在后面。
 * `numberOf` 取画布上标注的当前编号；查不到说明调用方漏了终校（editDraftError），直接抛错。 */
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

/** 把提交过的请求拆回修改要求：`@图片N` 装回图片 chip（底图叫「编辑底图」，其余取文件名），其余原样留成文字。
 *
 * `@标注N` 只能留成文字：标注 chip 要指向画布上那个圈，而圈的形状没有随请求存下来。
 * 正文没提到的图片也装回来、接在末尾，免得丢掉（早先的请求可以带不在正文里的参考图）；
 * 底图本身，以及引用标注时排第一的标注图，都是隐式提交的，不装成 chip。 */
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

/** 接入了哪几家图片模型、各家支持什么档位。可选项与受理层照同一份声明，不在前端复制一份。 */
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

/** 这家支持这个画幅吗。画幅由分镜决定，用户在编辑器里改不了。 */
export const modelSupportsAspect = (model: ImageModel, aspectRatio: string) =>
  model.aspectRatios.includes(aspectRatio)

export type ImageResolution = NonNullable<ImageGenerationIn['resolution']>
export type ImageChannel = NonNullable<ImageGenerationIn['channel']>

export type ResolvedImageOptions = {
  model: ImageModel | undefined
  resolution: ImageResolution | undefined
  channel: ImageChannel | undefined
  /** 一家都出不了这个画幅：不是选错了，是这个画幅没人支持。 */
  aspectUnsupported: boolean
}

/** 把「用户想要的」收敛成「这次真能提交的」。
 *
 * 各家支持的档位不同，切模型后旧的选择可能落在新模型的范围外；在这里收敛而不是用副作用
 * 改 state，切回去时用户原来的选择还在。画幅是分镜给的，改不了，所以它反过来筛模型。 */
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
    // 空数组即这家没有渠道这个轴，提交时不带这个字段。
    channel: channels.includes(wanted.channel) ? wanted.channel : channels[0],
    aspectUnsupported: false,
  }
}

const RESOLUTIONS: readonly string[] = zImageGenerationIn.shape.resolution.unwrap().unwrap().options
const CHANNELS: readonly string[] = zImageGenerationIn.shape.channel.unwrap().unwrap().options

/** 按合同枚举收窄：模型清单与下拉给的都是字符串。 */
export const isResolution = (value: string): value is ImageResolution => RESOLUTIONS.includes(value)
export const isChannel = (value: string): value is ImageChannel => CHANNELS.includes(value)

export async function submitImageEdit(
  target: FrameEditTarget,
  request: EditRequest,
  /** 这次改的是哪张图，作为请求字段 `sourceUrl` 发给服务端；引用了标注时它不在 `referenceImageUrls` 里，所以单独传。 */
  baseUrl: string,
  options: {
    model: string
    channel?: ImageChannel
    resolution: ImageResolution
    aspectRatio: string
  },
) {
  // 不带 userName：浏览器会话由服务端填登录用户名。
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
