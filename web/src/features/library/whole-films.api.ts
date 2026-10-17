import { useInfiniteQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zWholeFilmCardsOut } from '@/shared/api/generated/zod.gen'
import type { PickerSource } from '@/shared/ui/search-picker'
import {
  DEFAULT_LIBRARY_SCOPE,
  librarySearchParams,
  useAuthorSource,
  type LibraryBaseScope,
} from './library.api'

export type WholeFilmScope = LibraryBaseScope
export type WholeFilmsPage = z.output<typeof zWholeFilmCardsOut>
export type WholeFilmCard = WholeFilmsPage['items'][number]
export const DEFAULT_WHOLE_FILM_SCOPE: WholeFilmScope = {
  q: '',
  userName: null,
  range: DEFAULT_LIBRARY_SCOPE.range,
  since: null,
  until: null,
}

export const useLibraryWholeFilms = (scope: WholeFilmScope) =>
  useInfiniteQuery({
    gcTime: 30 * 60_000,
    staleTime: 0,
    queryKey: ['library', 'whole-films', scope],
    queryFn: ({ pageParam, signal }) =>
      apiFetch(
        `/library/whole-films?${librarySearchParams(scope, pageParam).toString()}`,
        zWholeFilmCardsOut,
        {
          signal,
          fallbackErrorMessage: '读取整片资料库失败',
        },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: WholeFilmsPage) => last.nextCursor,
  })

export const useWholeFilmAuthorSource = (): PickerSource =>
  useAuthorSource('/library/whole-films/authors')
