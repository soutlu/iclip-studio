/** 治理者改标签树：加、改、删一个标签。合同见 contract/conventions.md §15「改树」。
 * 成功后标签树重读；删标签会去掉条目上的标签、改名会改卡面上的标签名，参考视频的列表与详情一并重读。 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import type { LibraryTagCreateIn, LibraryTagUpdateIn } from '@/shared/api/generated/types.gen'
import {
  zDeleteLibraryTagLibraryTagsTagIdDeleteResponse,
  zLibraryTagOut,
} from '@/shared/api/generated/zod.gen'
import { libraryTagQueryKeys } from './library-tags.api'
import { referenceQueryKeys } from './references.api'

const tagPath = (id: string) => `/library-tags/${encodeURIComponent(id)}`

/** 交回标签树重读的 Promise：变更等树读回来才算完成，面板里马上看得到新的一行。 */
const useRefresh = () => {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: referenceQueryKeys.all })
    return queryClient.invalidateQueries({ queryKey: libraryTagQueryKeys.tree })
  }
}

/** 加一个维度（不给 `parentId`）或取值；不合格是 422，消息给人看。 */
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

/** 改名、判断说明、AI 打标或同级里的先后；`changes` 里没有的项不动。 */
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

/** 删掉一个标签连同它的下级，两库条目上的这些标签一起去掉。 */
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
