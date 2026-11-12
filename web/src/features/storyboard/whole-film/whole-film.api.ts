import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import type { WholeFilmDraftIn } from '@/shared/api/generated/types.gen'
import {
  zCancelWholeFilmExportConversationsConversationIdWholeFilmExportsExportIdDeleteResponse as zExportCancelled,
  zLatestWholeFilmExportConversationsConversationIdWholeFilmExportsLatestGetResponse as zLatestExport,
  zWholeFilmDraftOut,
  zWholeFilmDraftSavedOut,
  zWholeFilmExportStartedOut,
} from '@/shared/api/generated/zod.gen'

const draftPath = (conversationId: string) =>
  `/conversations/${encodeURIComponent(conversationId)}/whole-film/draft`

export const wholeFilmQueryKeys = {
  draft: (conversationId: string) => ['whole-film', 'draft', conversationId] as const,
  latestExport: (conversationId: string) =>
    ['whole-film', 'export', 'latest', conversationId] as const,
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
