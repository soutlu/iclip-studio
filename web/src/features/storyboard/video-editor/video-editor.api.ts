/** 视频编辑的两次提交与链查询。切参考片段由服务端做，编辑段只给基底与区间；合成给基底与片段列表，
 * 地址由服务端按各段出处填。 */

import { useQuery, type QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import type { VideoComposeIn, VideoEditIn } from '@/shared/api/generated/types.gen'
import { zGenerationEnvelope, zGenerationsPageOut } from '@/shared/api/generated/zod.gen'
import {
  generationsRefetchInterval,
  storyboardQueryKeys,
  type GenerationJob,
  type GenerationsPage,
} from '../storyboard.api'

/** 本对话全部编辑链的查询前缀，挂在本对话生成记录的前缀下；按根的键挂在它下面，一次失效全部。 */
export const videoEditConversationKey = (conversationId: string) =>
  [...storyboardQueryKeys.conversation(conversationId), 'video-edits'] as const

export const videoEditChainKey = (conversationId: string, rootJobId: string) =>
  [...videoEditConversationKey(conversationId), rootJobId] as const

/** 一条根名下的衍生记录：编辑段与合成一次拿回，按原作号筛。
 *
 * 根自己的原作号是空的，不在结果里，由打开编辑器的那条记录传进来。 */
export const useVideoEditChain = (conversationId: string, rootJobId: string) =>
  useQuery({
    queryKey: videoEditChainKey(conversationId, rootJobId),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ conversationId, rootJobId, limit: '100' })
      return apiFetch(`/generations?${params}`, zGenerationsPageOut, {
        signal,
        fallbackErrorMessage: '读取编辑记录失败',
      })
    },
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
export type EditTrigger = {
  promptPrefix?: string
  providerOptions?: Record<string, string>
}

/** 哪个模型能做视频编辑、怎么触发。上游没有接口交代这件事，服务端也不管，按模型名认。
 * 按片段匹配：同一个模型在网关上可能带不同的供应商前缀。 */
const EDIT_TRIGGERS: readonly { matches: RegExp; trigger: EditTrigger }[] = [
  // Seedance 2.5 靠 provider_options 显式声明编辑子任务，不认正文里的意图词。
  { matches: /seedance-2-5/, trigger: { providerOptions: { omni_reference_task_type: 'edit' } } },
  // 万相 3.0 没有开关参数，靠正文开头的意图词路由到编辑。
  { matches: /wan3/, trigger: { promptPrefix: '编辑视频，' } },
]

export const editTriggerOf = (model: string): EditTrigger | undefined =>
  EDIT_TRIGGERS.find((entry) => entry.matches.test(model))?.trigger

/** 允许表里前端认得怎么触发编辑的那几个；别的做不了编辑，下拉里不列。 */
export const editableModels = (models: readonly string[]): string[] =>
  models.filter((model) => editTriggerOf(model) !== undefined)

/** 编辑器用哪个模型：选过的不在允许表里（配置改了）就退回默认；默认模型不支持编辑就取第一个支持的。 */
export const pickEditModel = (
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

/** 在一版成片上改一段：服务端按区间切参考片段交给模型。怎么触发编辑照模型名认：前缀拼进正文、
 * 选项并进 provider_options。
 *
 * `seconds: -1` 让结果跟着参考片段的时长走；不显式给，网关按默认 5 秒截断。不带 user_name：
 * 浏览器会话由服务端填登录用户名。 */
export const submitVideoEdit = async (
  input: Origin & {
    /** 基底那一版的记录 id。 */
    sourceJobId: string
    rangeStartMs: number
    rangeEndMs: number
    model: string
    prompt: string
    referenceImageUrls: readonly string[]
  },
): Promise<GenerationJob> => {
  const edit = editTriggerOf(input.model)
  if (edit === undefined) throw new Error(`模型 ${input.model} 不支持视频编辑`)
  const body: VideoEditIn = {
    conversation_id: input.conversationId,
    task_id: input.taskId,
    source_job_id: input.sourceJobId,
    range_start_ms: input.rangeStartMs,
    range_end_ms: input.rangeEndMs,
    model: input.model,
    prompt: `${edit.promptPrefix ?? ''}${input.prompt}`,
    reference_image_urls: [...input.referenceImageUrls],
    seconds: -1,
    ...(edit.providerOptions === undefined ? {} : { provider_options: edit.providerOptions }),
  }
  const result = await apiFetch('/generations/video-edits', zGenerationEnvelope, {
    method: 'POST',
    body,
    fallbackErrorMessage: '视频编辑提交失败',
  })
  return result.generation
}

/** 合成里的一段：出自哪条记录、取它自己媒体时间里的哪一截（秒）；没有 `end` 就取到结尾。 */
export type CompositeSegment = { sourceJobId: string; start: number; end?: number }

/** 把一条编辑段夹回它的基底的那几段：基底 `[0, 起点)`（起点为 0 时没有）、编辑段整条、
 * 基底 `[终点, 结尾)`。区间用编辑段上记的实际值，毫秒换成秒。 */
export const spliceSegments = (edit: {
  baseJobId: string
  editJobId: string
  rangeStartMs: number
  rangeEndMs: number
}): CompositeSegment[] => [
  ...(edit.rangeStartMs > 0
    ? [{ sourceJobId: edit.baseJobId, start: 0, end: edit.rangeStartMs / 1000 }]
    : []),
  { sourceJobId: edit.editJobId, start: 0 },
  { sourceJobId: edit.baseJobId, start: edit.rangeEndMs / 1000 },
]

/** 在基底那一版上按片段列表拼成新的一版。服务端核对各段出处、换成地址再拼。 */
export const submitVideoComposite = async (
  input: Origin & { baseJobId: string; segments: readonly CompositeSegment[] },
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
