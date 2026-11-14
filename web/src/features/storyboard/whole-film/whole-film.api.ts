import { useQuery, type QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import type { MusicIn, WholeFilmDraftIn } from '@/shared/api/generated/types.gen'
import {
  zCancelWholeFilmExportConversationsConversationIdWholeFilmExportsExportIdDeleteResponse as zExportCancelled,
  zConversationEnvelope,
  zGenerationEnvelope,
  zLatestWholeFilmExportConversationsConversationIdWholeFilmExportsLatestGetResponse as zLatestExport,
  zWholeFilmDraftOut,
  zWholeFilmDraftSavedOut,
  zWholeFilmExportStartedOut,
  zWholeFilmPreviewOut,
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
  // 挂在对话的生成记录下面：生成记录有变化时跟着刷新
  music: (conversationId: string) =>
    [...storyboardQueryKeys.conversation(conversationId), 'audio'] as const,
  preview: (conversationId: string) => ['whole-film', 'preview', conversationId] as const,
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

/**
 * 编辑器打开时取一次预览令牌：预览页在预览域名 `origin` 下，凭 `token` 运行。
 * 编辑器开着时不再重取，换了令牌预览页就要重新加载。
 */
export const useWholeFilmPreviewQuery = (conversationId: string) =>
  useQuery({
    queryKey: wholeFilmQueryKeys.preview(conversationId),
    queryFn: ({ signal }) =>
      apiFetch(
        `/conversations/${encodeURIComponent(conversationId)}/whole-film/preview`,
        zWholeFilmPreviewOut,
        { fallbackErrorMessage: '预览加载失败', method: 'POST', signal },
      ),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
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

/** 这段对话的音频记录（生成的音乐和上传的音频），新的在前；有没生成完的就隔一会儿再读。 */
export const useConversationMusic = (conversationId: string) =>
  useQuery({
    queryKey: wholeFilmQueryKeys.music(conversationId),
    queryFn: ({ signal }) =>
      readAllGenerations({ conversationId, kind: 'audio' }, signal, '读取音频失败'),
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

/** 重新读这段对话的音频；给了 `job` 先把它放到列表最前面，不用等读回来就看得到。 */
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
