import { z } from 'zod'
import {
  DEFAULT_LIBRARY_SCOPE,
  DEFAULT_LIBRARY_TAB,
  DEFAULT_REFERENCE_SCOPE,
  LIBRARY_TAB_VALUES,
  type BrandTemplateScope,
  type LibraryScope,
  type LibraryTab,
  type ReferenceScope,
  zCategory,
  zVideoType,
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
  videoTypes: z.array(zVideoType).min(1).optional().catch(undefined),
  categories: z.array(zCategory).min(1).optional().catch(undefined),
  video: z.uuid().optional().catch(undefined),
  reference: z.uuid().optional().catch(undefined),
  brand: z.string().trim().min(1).max(100).optional().catch(undefined),
  includeDisabled: z.literal(true).optional().catch(undefined),
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
    categories: search.categories ?? [],
    q: search.q ?? '',
    userName: search.userName ?? null,
    videoTypes: search.videoTypes ?? [],
  }
}

export function searchFromReferenceScope(scope: ReferenceScope): LibrarySearch {
  const q = scope.q.trim()
  return {
    ...dateRangeToSearch(scope, DEFAULT_REFERENCE_SCOPE),
    categories: scope.categories.length === 0 ? undefined : [...scope.categories],
    q: q === '' ? undefined : q,
    tab: 'references',
    userName: scope.userName ?? undefined,
    videoTypes: scope.videoTypes.length === 0 ? undefined : [...scope.videoTypes],
  }
}

export function brandTemplateScopeFromSearch(search: LibrarySearch): BrandTemplateScope {
  return {
    q: search.q ?? '',
    brand: search.brand,
    includeDisabled: search.includeDisabled === true,
  }
}

export function searchFromBrandTemplateScope(scope: BrandTemplateScope): LibrarySearch {
  return {
    tab: 'brand-templates',
    q: scope.q.trim() || undefined,
    brand: scope.brand,
    includeDisabled: scope.includeDisabled ? true : undefined,
  }
}
