import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from './client'
import { zReferenceAudioOut, zReferenceAudiosOut } from './generated/zod.gen'
import { drainPages } from './paging'

/** 参考音频库里的一条：音色、配乐或音效。资料库「音频库」和 final-cut 都读它。 */
export type ReferenceAudio = z.output<typeof zReferenceAudioOut>
export type ReferenceAudiosPage = z.output<typeof zReferenceAudiosOut>
export type AudioKind = ReferenceAudio['audioKind']
export type AudioLocale = NonNullable<ReferenceAudio['locale']>

export const AUDIO_KINDS = zReferenceAudioOut.shape.audioKind.options

export const AUDIO_LOCALES = zReferenceAudioOut.shape.locale.unwrap().options

/** 列表的筛选：子类（null 是全部）和关键词（匹配标题、备注与台词）。 */
export type ReferenceAudioFilter = { audioKind: AudioKind | null; q: string }

const ROOT = 'reference-audios'

/** 各处读参考音频库都挂在 `all` 下面：入库、改、删以后让它整个失效。 */
export const referenceAudioKeys = {
  all: [ROOT] as const,
  list: (filter: ReferenceAudioFilter) => [ROOT, 'list', filter] as const,
  filters: [ROOT, 'filters'] as const,
  voices: [ROOT, 'voices'] as const,
}

const READ_FAILED = '读取音频库失败'

const PAGE_SIZE = 20

const VOICE_PAGE_SIZE = 100

const readPage = (
  { audioKind, q }: ReferenceAudioFilter,
  cursor: string | null,
  limit: number,
  signal: AbortSignal,
): Promise<ReferenceAudiosPage> => {
  const params = new URLSearchParams()
  if (audioKind !== null) params.set('audioKind', audioKind)
  const keyword = q.trim()
  if (keyword !== '') params.set('q', keyword)
  params.set('limit', String(limit))
  if (cursor !== null) params.set('cursor', cursor)
  return apiFetch(`/references/audios?${params.toString()}`, zReferenceAudiosOut, {
    fallbackErrorMessage: READ_FAILED,
    signal,
  })
}

/** 按 `filter` 一页一页读参考音频库，建立晚的在前；`total` 只在第一页有。 */
export const referenceAudiosQuery = (filter: ReferenceAudioFilter) =>
  infiniteQueryOptions({
    queryKey: referenceAudioKeys.list(filter),
    queryFn: ({ pageParam, signal }) => readPage(filter, pageParam, PAGE_SIZE, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })

/** 资料库里的全部音色，建立晚的在前。 */
export const voicesQuery = () =>
  queryOptions({
    queryKey: referenceAudioKeys.voices,
    queryFn: ({ signal }) =>
      drainPages<ReferenceAudio, string>(async (cursor) => {
        const page = await readPage(
          { audioKind: 'voice', q: '' },
          cursor ?? null,
          VOICE_PAGE_SIZE,
          signal,
        )
        return { items: page.items, next: page.nextCursor }
      }),
  })
