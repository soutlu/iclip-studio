import { z } from 'zod'
import {
  DEFAULT_HIT_CASE_SCOPE,
  DEFAULT_LIBRARY_SCOPE,
  DEFAULT_LIBRARY_TAB,
  DEFAULT_REFERENCE_SCOPE,
  DEFAULT_WHOLE_FILM_SCOPE,
  LIBRARY_TAB_VALUES,
  type HitCaseScope,
  type LibraryScope,
  type LibraryTab,
  type ReferenceScope,
  type WholeFilmScope,
} from '@/features/library'
import {
  dateRangeFromSearch,
  dateRangeSearchFields,
  dateRangeToSearch,
} from '@/shared/lib/date-range'

const zLibraryTab = z.enum(LIBRARY_TAB_VALUES)

export const librarySearchSchema = z.object({
  ...dateRangeSearchFields,
  tab: zLibraryTab.optional().catch(undefined),
  orientation: z.enum(['portrait', 'landscape']).optional().catch(undefined),
  q: z.string().max(100).optional().catch(undefined),
  userName: z.string().min(1).optional().catch(undefined),
  tags: z.array(z.uuid()).min(1).optional().catch(undefined),
  video: z.uuid().optional().catch(undefined),
  /** 与 `video` 一起用：打开那张卡时先选中这一版。 */
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
