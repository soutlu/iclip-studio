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
  AUDIO_KIND_FILTERS,
  latestReferenceAudiosQuery,
  referenceAudioKeys,
  referenceAudiosQuery,
  traitQuery,
  type AudioKind,
  type AudioTraitFilter,
  type ReferenceAudio,
} from '@/shared/api/reference-audios'

/** 「音频库」页签：某个子类，或「全部」（分三段各列最新几条）。 */
export type ReferenceAudioTab = AudioKind | 'all'

/** 「音频库」页签的筛选：页签、关键词和属性（只用得上当前子类的那几项）。 */
export type ReferenceAudioScope = { kind: ReferenceAudioTab; q: string; traits: AudioTraitFilter }

export const DEFAULT_REFERENCE_AUDIO_SCOPE: ReferenceAudioScope = {
  kind: 'voice',
  q: '',
  traits: {},
}

/** 只留 `kind` 用得上的属性筛选，去掉没选的；「全部」不按属性筛。 */
export const traitsFor = (kind: ReferenceAudioTab, traits: AudioTraitFilter): AudioTraitFilter => {
  if (kind === 'all') return {}
  const kept: AudioTraitFilter = {}
  for (const key of AUDIO_KIND_FILTERS[kind]) {
    const value = traits[key]
    if (value !== undefined) Object.assign(kept, { [key]: value })
  }
  return kept
}

/** 「全部」里每段只列最新几条。 */
export const LATEST_PER_KIND = 5

export type ReferenceAudioDraft = Omit<z.input<typeof zReferenceAudioCreateIn>, 'uploadId'>
export type ReferenceAudioChange = z.input<typeof zReferenceAudioUpdateIn>

/** 某个子类的列表，按关键词和属性筛，往下滚接着读。 */
export const useReferenceAudios = (kind: AudioKind, q: string, traits: AudioTraitFilter) =>
  useInfiniteQuery({
    ...referenceAudiosQuery({
      audioKind: kind,
      q,
      ...traitQuery(AUDIO_KIND_FILTERS[kind], traits),
    }),
    gcTime: 30 * 60_000,
  })

/** 「全部」的三段：各子类按关键词匹配的最新几条和总条数，按音色、配乐、音效的先后。 */
export const useLatestReferenceAudios = (q: string) => {
  const voice = useQuery(latestReferenceAudiosQuery({ audioKind: 'voice', q }, LATEST_PER_KIND))
  const bgm = useQuery(latestReferenceAudiosQuery({ audioKind: 'bgm', q }, LATEST_PER_KIND))
  const sfx = useQuery(latestReferenceAudiosQuery({ audioKind: 'sfx', q }, LATEST_PER_KIND))
  return [
    { kind: 'voice', query: voice },
    { kind: 'bgm', query: bgm },
    { kind: 'sfx', query: sfx },
  ] as const
}

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

/** 改名称、描述、台词和属性：只发改了的，清空的发 null（场景发 []）。 */
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
