import { z } from 'zod'
import {
  DEFAULT_HIT_CASE_SCOPE,
  DEFAULT_LIBRARY_SCOPE,
  DEFAULT_LIBRARY_TAB,
  DEFAULT_REFERENCE_AUDIO_SCOPE,
  DEFAULT_REFERENCE_SCOPE,
  DEFAULT_WHOLE_FILM_SCOPE,
  LIBRARY_TAB_VALUES,
  type HitCaseScope,
  type LibraryScope,
  type LibraryTab,
  type ReferenceAudioScope,
  traitsFor,
  type ReferenceScope,
  type WholeFilmScope,
} from '@/features/library'
import {
  zListReferenceAudiosReferencesAudiosGetQuery,
  zReferenceAudioOut,
} from '@/shared/api/generated/zod.gen'
import {
  dateRangeFromSearch,
  dateRangeSearchFields,
  dateRangeToSearch,
} from '@/shared/lib/date-range'

const zLibraryTab = z.enum(LIBRARY_TAB_VALUES)

const audioQuery = zListReferenceAudiosReferencesAudiosGetQuery.shape

/** 音频库的属性筛选：每项一个值，取值同列表接口；认不出的（含重复给了几个）当没筛。 */
const audioTraitParams = {
  locale: audioQuery.locale.unwrap().unwrap().element.optional().catch(undefined),
  gender: audioQuery.gender.unwrap().unwrap().element.optional().catch(undefined),
  age: audioQuery.age.unwrap().unwrap().element.optional().catch(undefined),
  scenario: audioQuery.scenario.unwrap().unwrap().element.optional().catch(undefined),
  mood: audioQuery.mood.unwrap().unwrap().element.optional().catch(undefined),
  genre: audioQuery.genre.unwrap().unwrap().element.optional().catch(undefined),
  tempo: audioQuery.tempo.unwrap().unwrap().element.optional().catch(undefined),
  sfxCategory: audioQuery.sfxCategory.unwrap().unwrap().element.optional().catch(undefined),
}

export const librarySearchSchema = z.object({
  ...dateRangeSearchFields,
  tab: zLibraryTab.optional().catch(undefined),
  orientation: z.enum(['portrait', 'landscape']).optional().catch(undefined),
  q: z.string().max(100).optional().catch(undefined),
  userName: z.string().min(1).optional().catch(undefined),
  tags: z.array(z.uuid()).min(1).optional().catch(undefined),
  // 音频库页签：不写是音色，「全部」写成 all
  audioKind: z
    .union([zReferenceAudioOut.shape.audioKind, z.literal('all')])
    .optional()
    .catch(undefined),
  ...audioTraitParams,
  video: z.uuid().optional().catch(undefined),
  version: z.uuid().optional().catch(undefined),
  reference: z.uuid().optional().catch(undefined),
  film: z.uuid().optional().catch(undefined),
})

export type LibrarySearch = z.output<typeof librarySearchSchema>

export const tabFromSearch = (search: LibrarySearch): LibraryTab =>
  search.tab ?? DEFAULT_LIBRARY_TAB

export function searchFromTab(value: string): LibrarySearch {
  const tab = zLibraryTab.safeParse(value)
  return tab.success && tab.data !== DEFAULT_LIBRARY_TAB ? { tab: tab.data } : {}
}

export function scopeFromSearch(search: LibrarySearch): LibraryScope {
  return {
    ...dateRangeFromSearch(search, DEFAULT_LIBRARY_SCOPE),
    orientation: search.orientation ?? null,
    q: search.q ?? '',
    userName: search.userName ?? null,
  }
}

export function searchFromScope(scope: LibraryScope): LibrarySearch {
  const q = scope.q.trim()
  return {
    ...dateRangeToSearch(scope, DEFAULT_LIBRARY_SCOPE),
    orientation: scope.orientation ?? undefined,
    q: q === '' ? undefined : q,
    userName: scope.userName ?? undefined,
  }
}

export function referenceScopeFromSearch(search: LibrarySearch): ReferenceScope {
  return {
    ...dateRangeFromSearch(search, DEFAULT_REFERENCE_SCOPE),
    q: search.q ?? '',
    tags: search.tags ?? [],
    userName: search.userName ?? null,
  }
}

export function searchFromReferenceScope(scope: ReferenceScope): LibrarySearch {
  const q = scope.q.trim()
  return {
    ...dateRangeToSearch(scope, DEFAULT_REFERENCE_SCOPE),
    q: q === '' ? undefined : q,
    tab: 'references',
    tags: scope.tags.length === 0 ? undefined : [...scope.tags],
    userName: scope.userName ?? undefined,
  }
}

export function referenceAudioScopeFromSearch(search: LibrarySearch): ReferenceAudioScope {
  const kind = search.audioKind ?? DEFAULT_REFERENCE_AUDIO_SCOPE.kind
  const { locale, gender, age, scenario, mood, genre, tempo, sfxCategory } = search
  return {
    kind,
    q: search.q ?? DEFAULT_REFERENCE_AUDIO_SCOPE.q,
    traits: traitsFor(kind, { locale, gender, age, scenario, mood, genre, tempo, sfxCategory }),
  }
}

export function searchFromReferenceAudioScope(scope: ReferenceAudioScope): LibrarySearch {
  const q = scope.q.trim()
  const traits = traitsFor(scope.kind, scope.traits)
  return {
    age: traits.age,
    audioKind: scope.kind === DEFAULT_REFERENCE_AUDIO_SCOPE.kind ? undefined : scope.kind,
    gender: traits.gender,
    genre: traits.genre,
    locale: traits.locale,
    mood: traits.mood,
    q: q === '' ? undefined : q,
    scenario: traits.scenario,
    sfxCategory: traits.sfxCategory,
    tab: 'audios',
    tempo: traits.tempo,
  }
}

export const hitCaseScopeFromSearch = (search: LibrarySearch): HitCaseScope => ({
  ...dateRangeFromSearch(search, DEFAULT_HIT_CASE_SCOPE),
  tags: search.tags ?? [],
  userName: search.userName ?? null,
})

export const searchFromHitCaseScope = (scope: HitCaseScope): LibrarySearch => ({
  ...dateRangeToSearch(scope, DEFAULT_HIT_CASE_SCOPE),
  tab: 'hit-cases',
  tags: scope.tags.length === 0 ? undefined : [...scope.tags],
  userName: scope.userName ?? undefined,
})

export function wholeFilmScopeFromSearch(search: LibrarySearch): WholeFilmScope {
  return {
    ...dateRangeFromSearch(search, DEFAULT_WHOLE_FILM_SCOPE),
    q: search.q ?? '',
    userName: search.userName ?? null,
  }
}

export function searchFromWholeFilmScope(scope: WholeFilmScope): LibrarySearch {
  const q = scope.q.trim()
  return {
    ...dateRangeToSearch(scope, DEFAULT_WHOLE_FILM_SCOPE),
    tab: 'whole-films',
    q: q === '' ? undefined : q,
    userName: scope.userName ?? undefined,
  }
}
