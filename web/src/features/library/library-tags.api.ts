import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import { zLibraryTagsOut } from '@/shared/api/generated/zod.gen'
import { tagIndexOf, type LibraryTagTree } from './library-tags'

export const libraryTagQueryKeys = {
  tree: ['library-tags'] as const,
}

const withIndex = (tree: LibraryTagTree) => ({ index: tagIndexOf(tree), tree })

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
