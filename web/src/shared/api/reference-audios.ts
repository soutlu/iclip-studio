import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from './client'
import {
  zListReferenceAudiosReferencesAudiosGetQuery,
  zReferenceAudioOut,
  zReferenceAudiosOut,
} from './generated/zod.gen'
import { drainPages } from './paging'

/** 参考音频库里的一条：音色、配乐或音效。资料库「音频库」和 final-cut 都读它。 */
export type ReferenceAudio = z.output<typeof zReferenceAudioOut>
export type ReferenceAudiosPage = z.output<typeof zReferenceAudiosOut>
export type AudioKind = ReferenceAudio['audioKind']
export type AudioLocale = NonNullable<ReferenceAudio['locale']>

export const AUDIO_KINDS = zReferenceAudioOut.shape.audioKind.options

const query = zListReferenceAudiosReferencesAudiosGetQuery.shape

/** 列表能按哪些属性筛、各有哪些取值（语种多一个 `none`：没设语种）。同一项任一命中，不同项同时满足。 */
export const AUDIO_FILTER_VALUES = {
  locale: query.locale.unwrap().unwrap().element.options,
  gender: query.gender.unwrap().unwrap().element.options,
  age: query.age.unwrap().unwrap().element.options,
  scenario: query.scenario.unwrap().unwrap().element.options,
  mood: query.mood.unwrap().unwrap().element.options,
  genre: query.genre.unwrap().unwrap().element.options,
  tempo: query.tempo.unwrap().unwrap().element.options,
  sfxCategory: query.sfxCategory.unwrap().unwrap().element.options,
}

export type AudioFilterKey = keyof typeof AUDIO_FILTER_VALUES
export type AudioFilterValue<K extends AudioFilterKey> = (typeof AUDIO_FILTER_VALUES)[K][number]

/** 各子类能按哪几项属性筛，按筛选行上的先后。 */
export const AUDIO_KIND_FILTERS = {
  voice: ['locale', 'scenario', 'gender', 'age'],
  bgm: ['mood', 'genre', 'tempo'],
  sfx: ['sfxCategory'],
} as const satisfies Record<AudioKind, readonly AudioFilterKey[]>

/** 各属性筛选选中的取值；没给或空数组是不按它筛。 */
export type AudioTraitFilter = {
  [K in AudioFilterKey]?: readonly AudioFilterValue<K>[] | undefined
}

/** 列表的筛选：子类（null 是全部）、关键词（匹配标题、备注与台词）和属性。 */
export type ReferenceAudioFilter = { audioKind: AudioKind | null; q: string } & AudioTraitFilter

const ROOT = 'reference-audios'

/** 各处读参考音频库都挂在 `all` 下面：入库、改、删以后让它整个失效。 */
export const referenceAudioKeys = {
  all: [ROOT] as const,
  list: (filter: ReferenceAudioFilter) => [ROOT, 'list', filter] as const,
  latest: (filter: ReferenceAudioFilter, limit: number) => [ROOT, 'latest', filter, limit] as const,
  filters: [ROOT, 'filters'] as const,
  voices: [ROOT, 'voices'] as const,
}

const READ_FAILED = '读取音频库失败'

const PAGE_SIZE = 20

const VOICE_PAGE_SIZE = 100

const FILTER_KEYS = Object.keys(AUDIO_FILTER_VALUES) as AudioFilterKey[]

const readPage = (
  filter: ReferenceAudioFilter,
  cursor: string | null,
  limit: number,
  signal: AbortSignal,
): Promise<ReferenceAudiosPage> => {
  const params = new URLSearchParams()
  if (filter.audioKind !== null) params.set('audioKind', filter.audioKind)
  for (const key of FILTER_KEYS) for (const value of filter[key] ?? []) params.append(key, value)
  const keyword = filter.q.trim()
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

/** 按 `filter` 只读最新的 `limit` 条（一页），`total` 是符合筛选的总条数。 */
export const latestReferenceAudiosQuery = (filter: ReferenceAudioFilter, limit: number) =>
  queryOptions({
    queryKey: referenceAudioKeys.latest(filter, limit),
    queryFn: ({ signal }) => readPage(filter, null, limit, signal),
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
