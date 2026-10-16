/** 视频编辑页的片段生成、合成与链查询。编辑模式在浏览器里准备参考视频，图生直接提交引用图片；
 * 合成给基底与片段列表，地址由服务端按各段出处填。 */

import { useQuery, type QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
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
import type { Clip } from './draft'
import { clipDurationError } from './clip-generation'
import type { SecondsRange } from './reference-clip'
import type { PlaySegment } from './play-layout'

/** 本对话全部编辑链的查询前缀，挂在本对话生成记录的前缀下；按根的键挂在它下面，一次失效全部。 */
export const videoEditConversationKey = (conversationId: string) =>
  [...storyboardQueryKeys.conversation(conversationId), 'video-edits'] as const

export const videoEditChainKey = (conversationId: string, rootJobId: string) =>
  [...videoEditConversationKey(conversationId), rootJobId] as const

/** 一条根名下的衍生记录：编辑段与合成按原作号筛，翻到底全部拿回。缓存照列表接口的 `{ items }` 形状存。
 *
 * 只读第一页时更早的合成与草稿用着的编辑段会被挤掉：版本条少了那一版，草稿也会被当成读不出来而重建。
 * 根自己的原作号是空的，不在结果里，由打开编辑器的那条记录传进来。 */
export const useVideoEditChain = (conversationId: string, rootJobId: string) =>
  useQuery({
    queryKey: videoEditChainKey(conversationId, rootJobId),
    queryFn: async ({ signal }): Promise<GenerationsPage> => ({
      items: await readAllGenerations({ conversationId, rootJobId }, signal, '读取编辑记录失败'),
    }),
    // 编辑器按需打开，打开就重拉，不吃全局 30 秒的新鲜期。
    staleTime: 0,
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data?.items ?? []),
  })

/** 刚受理的记录先放进这条链的缓存最前面，再失效本对话全部编辑链，等服务端结果覆盖。 */
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

/** 编辑时请求里要多带的东西：正文前缀，或并进 `provider_options` 的键值。 */
export /** 编辑器用哪个模型：选过的不在允许表里（配置改了）就退回默认；默认模型不支持编辑就取第一个支持的。 */
const pickGenerationModel = (
  models: readonly string[],
  wanted: string | undefined,
  fallback: string | undefined,
): string | undefined =>
  models.find((item) => item === wanted) ?? models.find((item) => item === fallback) ?? models[0]

type Origin = {
  conversationId: string
  /** 根记录归属的需求单，编辑段与合成跟着它。 */
  taskId: string | null
}

/** 图生直接提交正文图片；编辑先将当前选用素材拼接、上传。两者都绑定同一基底时间区间。 */
export const submitClipGeneration = async (
  input: Origin & {
    sourceJobId: string
    range: SecondsRange
    model: VideoClipModelOut
    prompt: string
    referenceImageUrls: readonly string[]
    generation:
      { mode: 'image'; seconds: number } | { mode: 'edit'; referenceClips: readonly PlaySegment[] }
  },
): Promise<GenerationJob> => {
  const { generation, model } = input
  const seconds =
    generation.mode === 'image'
      ? generation.seconds
      : generation.referenceClips.reduce((sum, clip) => sum + clip.end - clip.start, 0)
  const durationError = clipDurationError(model, generation.mode, seconds)
  if (durationError !== undefined) throw new Error(durationError)
  let referenceVideoUrls: string[] = []
  if (generation.mode === 'edit') {
    const { concatenateReferenceClips } = await import('./reference-clip')
    const file = await concatenateReferenceClips(generation.referenceClips)
    const { url } = await uploadMediaFile(file, 'video')
    referenceVideoUrls = [url]
  } else {
    if (input.referenceImageUrls.length === 0) throw new Error('请在描述中引用至少一张图片')
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

/** 在基底那一版上按片段列表拼成新的一版：片段就是剪辑草稿。服务端核对各段出处、换成地址再拼。 */
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
