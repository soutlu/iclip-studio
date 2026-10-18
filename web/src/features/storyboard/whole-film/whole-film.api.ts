/** 整片编辑器读写的接口：草稿（合同 §6「整片草稿」）、音乐与字幕记录、生成背景音乐与识别字幕。 */

import { useQuery, type QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import type { MusicIn, SubtitleIn, WholeFilmDraftIn } from '@/shared/api/generated/types.gen'
import {
  zCancelWholeFilmExportConversationsConversationIdWholeFilmExportsExportIdDeleteResponse as zExportCancelled,
  zConversationEnvelope,
  zGenerationEnvelope,
  zWholeFilmDraftOut,
  zWholeFilmDraftSavedOut,
  zWholeFilmExportOut,
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
  music: (conversationId: string) =>
    [...storyboardQueryKeys.conversation(conversationId), 'audio'] as const,
  subtitles: (conversationId: string) =>
    [...storyboardQueryKeys.conversation(conversationId), 'subtitle'] as const,
  task: (conversationId: string) => ['whole-film', 'task', conversationId] as const,
}

export const readWholeFilmDraft = (conversationId: string, signal?: AbortSignal) =>
  apiFetch(draftPath(conversationId), zWholeFilmDraftOut, {
    fallbackErrorMessage: '整片草稿读取失败',
    ...(signal === undefined ? {} : { signal }),
  })

/** 还没存过时答复 `{ revision: 0, document: null }`；编辑期间不再重读，由编辑器自己持有最新的一版。 */
export const useWholeFilmDraftQuery = (conversationId: string) =>
  useQuery({
    queryKey: wholeFilmQueryKeys.draft(conversationId),
    queryFn: ({ signal }) => readWholeFilmDraft(conversationId, signal),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })

/** 整份保存；`revision` 对不上是 409（ApiError.status）。 */
export const saveWholeFilmDraft = (conversationId: string, body: WholeFilmDraftIn) =>
  apiFetch(draftPath(conversationId), zWholeFilmDraftSavedOut, {
    body,
    fallbackErrorMessage: '整片草稿保存失败',
    method: 'PUT',
  })

const exportsPath = (conversationId: string) =>
  `/conversations/${encodeURIComponent(conversationId)}/whole-film/exports`

/**
 * 按服务端存着的那一版草稿导出（合同 §6「整片导出」）；`revision` 不是存着的那一版是 409，
 * 没开通、草稿合成不了是 422，渲染服务不可用是 502（都带一句可以给人看的原因）。
 */
export const startWholeFilmExport = (conversationId: string, revision: number) =>
  apiFetch(exportsPath(conversationId), zWholeFilmExportStartedOut, {
    body: { revision },
    fallbackErrorMessage: '整片导出失败',
    method: 'POST',
  })

/** 导出现在的样子；查不到（渲染服务重启过、结束满 1 小时）是 404 */
export const readWholeFilmExport = (conversationId: string, exportId: string) =>
  apiFetch(`${exportsPath(conversationId)}/${encodeURIComponent(exportId)}`, zWholeFilmExportOut, {
    fallbackErrorMessage: '读取导出进度失败',
  })

export const cancelWholeFilmExport = (conversationId: string, exportId: string) =>
  apiFetch(`${exportsPath(conversationId)}/${encodeURIComponent(exportId)}`, zExportCancelled, {
    fallbackErrorMessage: '取消导出失败',
    method: 'DELETE',
  })

/** 这段对话的音乐：生成的与确认时挂到这段对话的上传，按创建时间倒序。 */
export const useConversationMusic = (conversationId: string) =>
  useQuery({
    queryKey: wholeFilmQueryKeys.music(conversationId),
    queryFn: ({ signal }) =>
      readAllGenerations({ conversationId, kind: 'audio' }, signal, '读取音乐失败'),
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data ?? []),
  })

/** 这段对话的字幕记录；自动卡点按它判断切点会不会切进口播。 */
export const useConversationSubtitles = (conversationId: string) =>
  useQuery({
    queryKey: wholeFilmQueryKeys.subtitles(conversationId),
    queryFn: ({ signal }) =>
      readAllGenerations({ conversationId, kind: 'subtitle' }, signal, '读取字幕记录失败'),
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data ?? []),
  })

/** 这段对话挂的需求单；生成的背景音乐跟对话一起归到它。 */
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

/** 新提交或新上传的音乐先放进列表，再重读一次拿到服务端的那一行。 */
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
