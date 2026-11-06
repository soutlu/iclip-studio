import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import type { LibraryTagCreateIn, LibraryTagUpdateIn } from '@/shared/api/generated/types.gen'
import {
  zDeleteLibraryTagLibraryTagsTagIdDeleteResponse,
  zLibraryTagOut,
} from '@/shared/api/generated/zod.gen'
import { hitCaseQueryKeys } from './hit-cases.api'
import { libraryTagQueryKeys } from './library-tags.api'
import { referenceQueryKeys } from './references.api'

const tagPath = (id: string) => `/library-tags/${encodeURIComponent(id)}`

const useRefresh = () => {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: referenceQueryKeys.all })
    void queryClient.invalidateQueries({ queryKey: hitCaseQueryKeys.all })
    return queryClient.invalidateQueries({ queryKey: libraryTagQueryKeys.tree })
  }
}

export const useCreateLibraryTag = () => {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (body: LibraryTagCreateIn) =>
      apiFetch('/library-tags', zLibraryTagOut, {
        body,
        fallbackErrorMessage: '添加失败',
        method: 'POST',
      }),
    onSuccess: refresh,
  })
}

export const useUpdateLibraryTag = () => {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: LibraryTagUpdateIn }) =>
      apiFetch(tagPath(id), zLibraryTagOut, {
        body: changes,
        fallbackErrorMessage: '保存失败',
        method: 'PATCH',
      }),
    onSuccess: refresh,
  })
}

export const useDeleteLibraryTag = () => {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(tagPath(id), zDeleteLibraryTagLibraryTagsTagIdDeleteResponse, {
        fallbackErrorMessage: '删除失败',
        method: 'DELETE',
      }),
    onSuccess: refresh,
  })
}
