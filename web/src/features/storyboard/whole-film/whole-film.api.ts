/** 整片编辑器读写的服务端记录：本对话（含继承）的字幕记录，以及手动识别一条成片的字幕。 */

import { useQuery, type QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import type { SubtitleIn } from '@/shared/api/generated/types.gen'
import { zGenerationEnvelope } from '@/shared/api/generated/zod.gen'
import {
  generationsRefetchInterval,
  readAllGenerations,
  storyboardQueryKeys,
  type GenerationJob,
} from '../storyboard.api'

/** 挂在本对话生成记录的前缀下：状态跳转帧到了随视频记录一起失效重拉。 */
const subtitlesKey = (conversationId: string) =>
  [...storyboardQueryKeys.conversation(conversationId), 'subtitles'] as const

/** 本对话读得到的全部字幕记录（自己的与继承的），翻到底；有在识别的就轮询。 */
export const useConversationSubtitles = (conversationId: string) =>
  useQuery({
    queryKey: subtitlesKey(conversationId),
    queryFn: ({ signal }) =>
      readAllGenerations({ conversationId, kind: 'subtitle' }, signal, '读取字幕记录失败'),
    // 编辑器按需打开，打开就重拉，不吃全局的新鲜期。
    staleTime: 0,
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data ?? []),
  })

/** 另起一条字幕记录，识别一条成片的口播（补识别旧视频，或识别失败后重来）。不带 userName：浏览器会话由服务端认人。 */
export const submitSubtitle = async (input: {
  conversationId: string
  /** 要识别的成片。 */
  sourceJobId: string
  /** 归属的需求单，跟着那条成片。 */
  taskId: string | null
}): Promise<GenerationJob> => {
  const body: SubtitleIn = {
    conversationId: input.conversationId,
    sourceJobId: input.sourceJobId,
    taskId: input.taskId,
  }
  const result = await apiFetch('/generations/subtitles', zGenerationEnvelope, {
    method: 'POST',
    body,
    fallbackErrorMessage: '字幕识别提交失败',
  })
  return result.generation
}

/** 刚受理的字幕记录先放进缓存（成了这条成片最新的一条，立刻显示「识别中」），再失效等服务端结果。 */
export const seedSubtitleJob = (
  queryClient: QueryClient,
  conversationId: string,
  job: GenerationJob,
) => {
  queryClient.setQueryData<GenerationJob[]>(subtitlesKey(conversationId), (previous) => [
    job,
    ...(previous ?? []).filter((item) => item.id !== job.id),
  ])
  void queryClient.invalidateQueries({ queryKey: subtitlesKey(conversationId) })
}
