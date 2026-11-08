import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zCollectionEnvelope, zCollectionsPageOut } from '@/shared/api/generated/zod.gen'

const noContentSchema = z.unknown()

const collectionEnvelopeSchema = zCollectionEnvelope.transform((payload) => payload.collection)
const collectionsPageSchema = zCollectionsPageOut.transform((payload) => payload.items)
export type Collection = z.output<typeof collectionEnvelopeSchema>

const LIST_LIMIT = 100

const collectionsQueryKeys = {
  all: ['collections'] as const,
  list: () => ['collections', 'list'] as const,
}

export const useCollections = (enabled: boolean) =>
  useQuery({
    enabled,
    queryFn: ({ signal }) =>
      apiFetch(`/collections?limit=${LIST_LIMIT}`, collectionsPageSchema, {
        signal,
        cache: 'no-store',
        fallbackErrorMessage: '读取合集失败',
      }),
    queryKey: collectionsQueryKeys.list(),
  })

export const useSaveCollection = (onSaved: (collection: Collection) => void | Promise<void>) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ collectionId, name }: { collectionId?: string | undefined; name: string }) =>
      apiFetch(
        collectionId ? `/collections/${collectionId}` : '/collections',
        collectionEnvelopeSchema,
        {
          body: { name },
          fallbackErrorMessage: collectionId ? '重命名合集失败' : '新建合集失败',
          method: collectionId ? 'PATCH' : 'POST',
        },
      ),
    onSuccess: async (collection) => {
      await queryClient.invalidateQueries({ queryKey: collectionsQueryKeys.all })
      await onSaved(collection)
    },
  })
}

export const useDeleteCollection = (onSaved: () => void) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (collectionId: string) =>
      apiFetch(`/collections/${collectionId}`, noContentSchema, {
        fallbackErrorMessage: '删除合集失败',
        method: 'DELETE',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: collectionsQueryKeys.all })
      onSaved()
    },
  })
}
