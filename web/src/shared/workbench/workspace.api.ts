import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import { zConversationFileEnvelope, zConversationFilesOut } from '@/shared/api/generated/zod.gen'

const workspaceRoot = (conversationId: string) => ['workspace', conversationId] as const

export const workspaceQueryKeys = {
  all: workspaceRoot,
  file: (conversationId: string, path: string) =>
    [...workspaceRoot(conversationId), 'file', path] as const,
  files: (conversationId: string) => [...workspaceRoot(conversationId), 'files'] as const,
}

export const useWorkspaceFiles = (conversationId: string) =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch(`/conversations/${conversationId}/workspace/files`, zConversationFilesOut, {
        fallbackErrorMessage: '读取工作区文件失败',
        signal,
      }),
    queryKey: workspaceQueryKeys.files(conversationId),
  })

export const writeWorkspaceFile = (
  conversationId: string,
  body: { path: string; content: string; expectedVersion: number },
  failureMessage: string,
) =>
  apiFetch(`/conversations/${conversationId}/workspace/file`, zConversationFileEnvelope, {
    body,
    fallbackErrorMessage: failureMessage,
    method: 'PUT',
  })

export const readWorkspaceFile = (conversationId: string, path: string, signal?: AbortSignal) =>
  apiFetch(
    `/conversations/${conversationId}/workspace/file?path=${encodeURIComponent(path)}`,
    zConversationFileEnvelope,
    { fallbackErrorMessage: '读取工作区文件失败', ...(signal === undefined ? {} : { signal }) },
  )

export const useWorkspaceFile = (conversationId: string, path: string) =>
  useQuery({
    queryFn: ({ signal }) => readWorkspaceFile(conversationId, path, signal),
    queryKey: workspaceQueryKeys.file(conversationId, path),
  })
