import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import {
  zReferenceAudioFiltersOut,
  zReferenceAudioOut,
  zRemoveReferenceAudioReferencesAudiosReferenceIdDeleteResponse,
  type zReferenceAudioCreateIn,
  type zReferenceAudioUpdateIn,
} from '@/shared/api/generated/zod.gen'
import { uploadMediaFile } from '@/shared/api/media-upload'
import {
  referenceAudioKeys,
  referenceAudiosQuery,
  type ReferenceAudio,
  type ReferenceAudioFilter,
} from '@/shared/api/reference-audios'

/** 「音频库」页签的筛选：子类（null 是全部）和关键词。 */
export type ReferenceAudioScope = ReferenceAudioFilter

export const DEFAULT_REFERENCE_AUDIO_SCOPE: ReferenceAudioScope = { audioKind: null, q: '' }

export type ReferenceAudioDraft = Omit<z.input<typeof zReferenceAudioCreateIn>, 'uploadId'>
export type ReferenceAudioChange = z.input<typeof zReferenceAudioUpdateIn>

export const useReferenceAudios = (scope: ReferenceAudioScope) =>
  useInfiniteQuery({ ...referenceAudiosQuery(scope), gcTime: 30 * 60_000 })

/** 各子类有几条（没有的是 0）。 */
export const useReferenceAudioFilters = () =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch('/references/audios/filters', zReferenceAudioFiltersOut, {
        fallbackErrorMessage: '读取筛选项失败',
        signal,
      }),
    queryKey: referenceAudioKeys.filters,
  })

const audioPath = (id: string) => `/references/audios/${encodeURIComponent(id)}`

const useInvalidate = () => {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: referenceAudioKeys.all })
}

/** 添加一条：先照音频上传的流程把文件传上去，再用这次上传和填的内容入库。 */
export const useAddReferenceAudio = () => {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async ({ file, draft }: { file: File; draft: ReferenceAudioDraft }) => {
      const { uploadId } = await uploadMediaFile(file, 'audio')
      return apiFetch('/references/audios', zReferenceAudioOut, {
        body: { ...draft, uploadId },
        fallbackErrorMessage: '添加失败',
        method: 'POST',
      })
    },
    onSuccess: invalidate,
  })
}

/** 改标题、备注、语种、台词：只发改了的，清空的发 null。 */
export const useUpdateReferenceAudio = () => {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ audio, change }: { audio: ReferenceAudio; change: ReferenceAudioChange }) =>
      apiFetch(audioPath(audio.id), zReferenceAudioOut, {
        body: change,
        fallbackErrorMessage: '保存失败',
        method: 'PATCH',
      }),
    onSuccess: invalidate,
  })
}

export const useRemoveReferenceAudio = () => {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (audio: ReferenceAudio) =>
      apiFetch(
        audioPath(audio.id),
        zRemoveReferenceAudioReferencesAudiosReferenceIdDeleteResponse,
        { fallbackErrorMessage: '移除失败', method: 'DELETE' },
      ),
    onSuccess: invalidate,
  })
}
