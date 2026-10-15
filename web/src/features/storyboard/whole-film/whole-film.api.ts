/** 整片编辑器读写的服务端记录：本对话（含继承）的字幕记录与手动识别一条成片的字幕，本对话生成的背景音乐与生成一首，
 * 读一首音乐（解码、量拍子，按需加载），以及合成整片。整片本身与成片同在本对话的视频记录里（useShotGenerations）。 */

import { skipToken, useQuery, type QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { ApiError, apiFetch, errorMessageOf, UserFacingError } from '@/shared/api/client'
import type { MusicIn, SubtitleIn, WholeFilmIn } from '@/shared/api/generated/types.gen'
import { zGenerationEnvelope } from '@/shared/api/generated/zod.gen'
import { filmViewQuery } from '../film/film.api'
import {
  generationsRefetchInterval,
  readAllGenerations,
  storyboardQueryKeys,
  type GenerationJob,
} from '../storyboard.api'

/** 挂在本对话生成记录的前缀下：状态跳转帧到了随视频记录一起失效重拉。 */
const subtitlesKey = (conversationId: string) =>
  [...storyboardQueryKeys.conversation(conversationId), 'subtitles'] as const

const musicKey = (conversationId: string) =>
  [...storyboardQueryKeys.conversation(conversationId), 'music'] as const

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

/** 本对话生成的背景音乐（音频记录），翻到底；有在生成的就轮询。上传的音乐不挂对话，不在这里。 */
export const useConversationMusic = (conversationId: string) =>
  useQuery({
    queryKey: musicKey(conversationId),
    queryFn: ({ signal }) =>
      readAllGenerations({ conversationId, kind: 'audio' }, signal, '读取音乐记录失败'),
    staleTime: 0,
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data ?? []),
  })

/** 从旧版本恢复时确认上传音乐仍可读。治理者也能读取别人的记录，因此这不证明属主身份或再次合成权限。 */
export const useUploadedMusicAccess = (jobId: string | undefined) =>
  useQuery({
    queryKey: ['whole-film', 'uploaded-music-access', jobId],
    queryFn:
      jobId === undefined
        ? skipToken
        : async ({ signal }) => {
            try {
              return (
                await apiFetch(`/generations/${encodeURIComponent(jobId)}`, zGenerationEnvelope, {
                  signal,
                })
              ).generation
            } catch (error) {
              if (error instanceof ApiError && error.status === 404)
                throw new UserFacingError('当前账号不能复用这首上传音乐，请替换或删除', {
                  cause: error,
                })
              throw error
            }
          },
    staleTime: 0,
    retry: false,
  })

/** 另起一条字幕记录，识别一条成片的口播（补识别旧视频，或识别失败后重来）。不带 userName：浏览器会话由服务端认人。 */
export const submitSubtitle = async (input: {
  conversationId: string
  /** 要识别的成片。 */
  sourceJobId: string
  /** 本对话此刻挂的需求单。 */
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

/** 生成一首背景音乐：`prompt` 原样发给音乐模型，这里不加任何文字。不带 userName，理由同上。 */
export const submitMusic = async (input: {
  conversationId: string
  prompt: string
  /** 本对话此刻挂的需求单。 */
  taskId: string | null
}): Promise<GenerationJob> => {
  const body: MusicIn = {
    conversationId: input.conversationId,
    prompt: input.prompt,
    taskId: input.taskId,
  }
  const result = await apiFetch('/generations/music', zGenerationEnvelope, {
    method: 'POST',
    body,
    fallbackErrorMessage: '音乐生成提交失败',
  })
  return result.generation
}

/** 一条生成的音乐当初发给模型的提示词：重新生成、失败重试时原样再发；读不出来时没有。 */
export const musicPromptOf = (job: GenerationJob): string | undefined =>
  z.object({ prompt: z.string().min(1) }).safeParse(job.request).data?.prompt

/** 刚受理的记录先放进缓存（立刻显示「识别中」「生成中」），再失效等服务端结果。 */
const seedJob = (queryClient: QueryClient, key: readonly unknown[], job: GenerationJob) => {
  queryClient.setQueryData<GenerationJob[]>(key, (previous) => [
    job,
    ...(previous ?? []).filter((item) => item.id !== job.id),
  ])
  void queryClient.invalidateQueries({ queryKey: key })
}

export const seedSubtitleJob = (
  queryClient: QueryClient,
  conversationId: string,
  job: GenerationJob,
) => seedJob(queryClient, subtitlesKey(conversationId), job)

export const seedMusicJob = (
  queryClient: QueryClient,
  conversationId: string,
  job: GenerationJob,
) => seedJob(queryClient, musicKey(conversationId), job)

/** 生成音乐的提示词从哪来：还在读工程、读失败、读到了（`text` 为 null 是对话没有工程文件或工程里没写配乐）。 */
export type MusicDescription =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string; onRetry: () => void }
  | { kind: 'ready'; text: string | null }

const isMissing = (error: unknown) => error instanceof ApiError && error.status === 404

/** 工程文件里「配乐」那段原文，生成音乐时原样当提示词。打开生成面板（`enabled`）才读，与制作页共用一份缓存；
 * 没有工程文件（404）是正常结果，不重试。 */
export const useMusicDescription = (conversationId: string, enabled: boolean): MusicDescription => {
  const query = useQuery({
    ...filmViewQuery(conversationId),
    enabled,
    retry: (count, error) => !isMissing(error) && count < 1,
  })
  if (query.data !== undefined) return { kind: 'ready', text: query.data.film.musicDescription }
  if (isMissing(query.error)) return { kind: 'ready', text: null }
  if (query.isError)
    return {
      kind: 'failed',
      message: errorMessageOf(query.error, '工程文件读取失败'),
      onRetry: () => void query.refetch(),
    }
  return { kind: 'loading' }
}

/** 读一首音乐：解码、量拍子与波形。读这件事连同拍点检测库只在用到音乐时才加载；读不出不自动重试，界面上给重试。
 *
 * 解码出的整首按采样存在内存里（三分钟的立体声约 70 MB）：编辑器开着时不重读，关掉编辑器、换了音乐，没人再用它就
 * 立刻从缓存里丢掉（`gcTime: 0`），不按默认留 5 分钟；放它的 Web Audio 上下文由 useMusicPlayback 在卸载时关掉。 */
export const useMusicAnalysis = (url: string | undefined) =>
  useQuery({
    queryKey: ['whole-film', 'music-analysis', url],
    queryFn:
      url === undefined
        ? skipToken
        : async ({ signal }) => (await import('./music-analysis')).analyzeMusic(url, signal),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })

/** 合成一条整片：时间线由 film-submit 排好，地址由服务端按各段与音乐的出处填。 */
export const submitWholeFilm = async (body: WholeFilmIn): Promise<GenerationJob> => {
  const result = await apiFetch('/generations/whole-films', zGenerationEnvelope, {
    method: 'POST',
    body,
    fallbackErrorMessage: '整片合成提交失败',
  })
  return result.generation
}

/** 刚受理的整片先放进本对话视频记录的缓存（版本条立刻出现「合成中」），再失效等服务端结果；整片与成片同一份列表。 */
export const seedWholeFilmJob = (
  queryClient: QueryClient,
  conversationId: string,
  job: GenerationJob,
) => seedJob(queryClient, storyboardQueryKeys.videoJobs(conversationId), job)
