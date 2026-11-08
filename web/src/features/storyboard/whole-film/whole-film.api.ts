import { useQuery, type QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import type { MusicIn, SubtitleIn, WholeFilmDraftIn } from '@/shared/api/generated/types.gen'
import {
  zCancelWholeFilmExportConversationsConversationIdWholeFilmExportsExportIdDeleteResponse as zExportCancelled,
  zConversationEnvelope,
  zGenerationEnvelope,
  zLatestWholeFilmExportConversationsConversationIdWholeFilmExportsLatestGetResponse as zLatestExport,
  zWholeFilmDraftOut,
  zWholeFilmDraftSavedOut,
  zWholeFilmExportStartedOut,
} from '@/shared/api/generated/zod.gen'
import {
  generationsRefetchInterval,
  readAllGenerations,
  storyboardQueryKeys,
  type GenerationJob,
} from '../storyboard.api'

const draftPath = (conversationId: string) =>
  `/conversations/${encodeURIComponent(conversationId)}/whole-film/draft`

export const wholeFilmQueryKeys = {
  draft: (conversationId: string) => ['whole-film', 'draft', conversationId] as const,
  latestExport: (conversationId: string) =>
    ['whole-film', 'export', 'latest', conversationId] as const,
  music: (conversationId: string) =>
    [...storyboardQueryKeys.conversation(conversationId), 'audio'] as const,
  subtitles: (conversationId: string) =>
    [...storyboardQueryKeys.conversation(conversationId), 'subtitle'] as const,
  task: (conversationId: string) => ['whole-film', 'task', conversationId] as const,
}

export const readWholeFilmDraft = (conversationId: string, signal?: AbortSignal) =>
  apiFetch(draftPath(conversationId), zWholeFilmDraftOut, {
    fallbackErrorMessage: '成片草稿读取失败',
    ...(signal === undefined ? {} : { signal }),
  })

export const useWholeFilmDraftQuery = (conversationId: string) =>
  useQuery({
    queryKey: wholeFilmQueryKeys.draft(conversationId),
    queryFn: ({ signal }) => readWholeFilmDraft(conversationId, signal),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })

export const saveWholeFilmDraft = (conversationId: string, body: WholeFilmDraftIn) =>
  apiFetch(draftPath(conversationId), zWholeFilmDraftSavedOut, {
    body,
    fallbackErrorMessage: '成片草稿保存失败',
    method: 'PUT',
  })

const exportsPath = (conversationId: string) =>
  `/conversations/${encodeURIComponent(conversationId)}/whole-film/exports`

export const startWholeFilmExport = (conversationId: string, revision: number) =>
  apiFetch(exportsPath(conversationId), zWholeFilmExportStartedOut, {
    body: { revision },
    fallbackErrorMessage: '成片导出失败',
    method: 'POST',
  })

export const readLatestWholeFilmExport = async (conversationId: string, signal: AbortSignal) =>
  (
    await apiFetch(`${exportsPath(conversationId)}/latest`, zLatestExport, {
      fallbackErrorMessage: '读取导出进度失败',
      signal,
    })
  ).export

export const cancelWholeFilmExport = (conversationId: string, exportId: string) =>
  apiFetch(`${exportsPath(conversationId)}/${encodeURIComponent(exportId)}`, zExportCancelled, {
    fallbackErrorMessage: '取消导出失败',
    method: 'DELETE',
  })

export const useConversationMusic = (conversationId: string) =>
  useQuery({
    queryKey: wholeFilmQueryKeys.music(conversationId),
    queryFn: ({ signal }) =>
      readAllGenerations({ conversationId, kind: 'audio' }, signal, '读取音乐失败'),
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data ?? []),
  })

export const useConversationSubtitles = (conversationId: string) =>
  useQuery({
    queryKey: wholeFilmQueryKeys.subtitles(conversationId),
    queryFn: ({ signal }) =>
      readAllGenerations({ conversationId, kind: 'subtitle' }, signal, '读取字幕记录失败'),
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data ?? []),
  })

export const useConversationTaskId = (conversationId: string) =>
  useQuery({
    queryKey: wholeFilmQueryKeys.task(conversationId),
    queryFn: async ({ signal }) =>
      (
        await apiFetch(
          `/conversations/${encodeURIComponent(conversationId)}`,
          zConversationEnvelope,
          { fallbackErrorMessage: '读取对话失败', signal },
        )
      ).conversation.taskId,
    staleTime: Infinity,
  })

export const submitMusic = async (body: MusicIn): Promise<GenerationJob> =>
  (
    await apiFetch('/generations/music', zGenerationEnvelope, {
      body,
      fallbackErrorMessage: '音乐生成提交失败',
      method: 'POST',
    })
  ).generation

export const submitSubtitle = async (body: SubtitleIn): Promise<GenerationJob> =>
  (
    await apiFetch('/generations/subtitles', zGenerationEnvelope, {
      body,
      fallbackErrorMessage: '字幕识别提交失败',
      method: 'POST',
    })
  ).generation

export const refreshConversationMusic = (
  queryClient: QueryClient,
  conversationId: string,
  job?: GenerationJob,
) => {
  const key = wholeFilmQueryKeys.music(conversationId)
  if (job !== undefined)
    queryClient.setQueryData<GenerationJob[]>(key, (previous) => [
      job,
      ...(previous ?? []).filter((item) => item.id !== job.id),
    ])
  return queryClient.invalidateQueries({ queryKey: key })
}
