import { skipToken, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch, errorMessageOf } from '@/shared/api/client'
import {
  zLibraryAuthorsOut,
  zLibraryVideoDetailOut,
  zLibraryVideosOut,
  type zVideosLibraryVideosGetQuery,
} from '@/shared/api/generated/zod.gen'
import { dateRangeBounds, UNBOUNDED_RANGE, type DateRange } from '@/shared/lib/date-range'
import type { PickerSource } from '@/shared/ui/search-picker'

export type LibraryVideosPage = z.output<typeof zLibraryVideosOut>
export type LibraryVideo = LibraryVideosPage['items'][number]
export type LibraryTake = LibraryVideo['take']
export type LibraryScript = NonNullable<LibraryTake['script']>
export type LibraryVideoDetail = z.output<typeof zLibraryVideoDetailOut>
export type LibraryShotGroup = LibraryVideoDetail['groups'][number]
export type LibraryVersionOut = LibraryShotGroup['versions'][number]
export type Orientation = NonNullable<z.output<typeof zVideosLibraryVideosGetQuery>['orientation']>

export interface LibraryBaseScope extends DateRange {
  userName: string | null
  q: string
}

export interface LibraryScope extends LibraryBaseScope {
  orientation: Orientation | null
}

export type FilterScope = LibraryBaseScope & { orientation?: Orientation | null }

export const DEFAULT_LIBRARY_SCOPE: LibraryScope = {
  ...UNBOUNDED_RANGE,
  orientation: null,
  q: '',
  userName: null,
}

export const LIBRARY_PAGE_SIZE = 24

export const isDefaultScope = (scope: FilterScope): boolean =>
  scope.userName === null &&
  (scope.orientation ?? null) === null &&
  scope.q.trim() === '' &&
  scope.range === 'all'

export const librarySearchParams = (
  scope: FilterScope,
  cursor: string | null,
  now: Date = new Date(),
): URLSearchParams => {
  const params = new URLSearchParams()
  const { since, until } = dateRangeBounds(scope, now)
  if (since !== null) params.set('since', since.toISOString())
  if (until !== null) params.set('until', until.toISOString())
  if (scope.userName !== null) params.set('userName', scope.userName)
  if (scope.orientation != null) params.set('orientation', scope.orientation)
  const keyword = scope.q.trim()
  if (keyword !== '') params.set('q', keyword)
  params.set('limit', String(LIBRARY_PAGE_SIZE))
  if (cursor !== null) params.set('cursor', cursor)
  return params
}

export const libraryQueryKeys = {
  all: ['library'] as const,
  videos: (scope: LibraryScope) => ['library', 'videos', scope] as const,
  video: (id: string) => ['library', 'video', id] as const,
  authors: (path: AuthorsPath) => ['library', 'authors', path] as const,
}

type AuthorsPath = '/library/authors' | '/library/whole-films/authors'

export const useLibraryVideos = (scope: LibraryScope) =>
  useInfiniteQuery({
    gcTime: 30 * 60_000,
    queryFn: ({ pageParam, signal }) =>
      apiFetch(
        `/library/videos?${librarySearchParams(scope, pageParam).toString()}`,
        zLibraryVideosOut,
        { fallbackErrorMessage: '读取资料库失败', signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: LibraryVideosPage) => last.nextCursor,
    queryKey: libraryQueryKeys.videos(scope),
  })

export const useLibraryVideo = (id: string | null) =>
  useQuery({
    queryFn:
      id === null
        ? skipToken
        : ({ signal }) =>
            apiFetch(`/library/videos/${encodeURIComponent(id)}`, zLibraryVideoDetailOut, {
              fallbackErrorMessage: '读取该视频失败',
              signal,
            }),
    queryKey: libraryQueryKeys.video(id ?? ''),
  })

export const useAuthorSource = (path: AuthorsPath): PickerSource => {
  const query = useQuery({
    queryFn: ({ signal }) =>
      apiFetch(path, zLibraryAuthorsOut, {
        fallbackErrorMessage: '读取作者名单失败',
        signal,
      }),
    queryKey: libraryQueryKeys.authors(path),
    staleTime: 5 * 60_000,
  })
  return {
    error: query.isError ? errorMessageOf(query.error, '读取作者名单失败') : undefined,
    isPending: query.isPending,
    onRetry: () => void query.refetch(),
    options: (query.data?.items ?? []).map((author) => ({
      id: author.userName,
      label: author.userName,
    })),
  }
}

export const useLibraryAuthorSource = (): PickerSource => useAuthorSource('/library/authors')
