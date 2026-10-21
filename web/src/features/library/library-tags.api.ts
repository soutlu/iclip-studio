/** 资料库标签树的读取：灵感库与以后的爆款素材库共用一份缓存。合同见 contract/conventions.md §15。 */

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import { zLibraryTagsOut } from '@/shared/api/generated/zod.gen'
import { tagIndexOf, type LibraryTagTree } from './library-tags'

export const libraryTagQueryKeys = {
  tree: ['library-tags'] as const,
}

// 放在模块级：select 引用不变，树没变时不重建查找表。
const withIndex = (tree: LibraryTagTree) => ({ index: tagIndexOf(tree), tree })

/** 整棵树连同各标签的条数与查找表。条数随打标变：改标签后由改的一方失效重读，打完标由列表的一方重读。 */
export const useLibraryTags = () =>
  useQuery({
    queryFn: async ({ signal }): Promise<LibraryTagTree> =>
      apiFetch('/library-tags', zLibraryTagsOut, {
        fallbackErrorMessage: '读取标签失败',
        signal,
      }),
    queryKey: libraryTagQueryKeys.tree,
    select: withIndex,
  })
