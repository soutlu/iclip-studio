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

const subtitlesKey = (conversationId: string) =>
  [...storyboardQueryKeys.conversation(conversationId), 'subtitles'] as const

const musicKey = (conversationId: string) =>
  [...storyboardQueryKeys.conversation(conversationId), 'music'] as const

export const useConversationSubtitles = (conversationId: string) =>
  useQuery({
    queryKey: subtitlesKey(conversationId),
    queryFn: ({ signal }) =>
      readAllGenerations({ conversationId, kind: 'subtitle' }, signal, '读取字幕记录失败'),
    staleTime: 0,
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data ?? []),
  })

export const useConversationMusic = (conversationId: string) =>
  useQuery({
    queryKey: musicKey(conversationId),
    queryFn: ({ signal }) =>
      readAllGenerations({ conversationId, kind: 'audio' }, signal, '读取音乐记录失败'),
    staleTime: 0,
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data ?? []),
  })

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
                throw new UserFacingError('当前账号无权使用该上传音乐，无法复用；请替换或删除', {
                  cause: error,
                })
              throw error
            }
          },
    staleTime: 0,
    retry: false,
  })

export const submitSubtitle = async (input: {
  conversationId: string
  sourceJobId: string
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

export const submitMusic = async (input: {
  conversationId: string
  prompt: string
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

export const musicPromptOf = (job: GenerationJob): string | undefined =>
  z.object({ prompt: z.string().min(1) }).safeParse(job.request).data?.prompt

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

export type MusicDescription =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string; onRetry: () => void }
  | { kind: 'ready'; text: string | null }

const isMissing = (error: unknown) => error instanceof ApiError && error.status === 404

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

export const submitWholeFilm = async (body: WholeFilmIn): Promise<GenerationJob> => {
  const result = await apiFetch('/generations/whole-films', zGenerationEnvelope, {
    method: 'POST',
    body,
    fallbackErrorMessage: '整片合成提交失败',
  })
  return result.generation
}

export const seedWholeFilmJob = (
  queryClient: QueryClient,
  conversationId: string,
  job: GenerationJob,
) => seedJob(queryClient, storyboardQueryKeys.videoJobs(conversationId), job)
