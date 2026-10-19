/** 资料库「成片」的接口：导出的整片，一段对话一张卡。合同见 contract/conventions.md §13。 */

import { useInfiniteQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zWholeFilmCardsOut } from '@/shared/api/generated/zod.gen'
import { UNBOUNDED_RANGE } from '@/shared/lib/date-range'
import type { PickerSource } from '@/shared/ui/search-picker'
import { librarySearchParams, useAuthorSource, type LibraryBaseScope } from './library.api'

export type WholeFilmScope = LibraryBaseScope
export type WholeFilmsPage = z.output<typeof zWholeFilmCardsOut>
export type WholeFilmCard = WholeFilmsPage['items'][number]
export const DEFAULT_WHOLE_FILM_SCOPE: WholeFilmScope = {
  ...UNBOUNDED_RANGE,
  q: '',
  userName: null,
}

export const useLibraryWholeFilms = (scope: WholeFilmScope) =>
  useInfiniteQuery({
    gcTime: 30 * 60_000,
    queryKey: ['library', 'whole-films', scope],
    queryFn: ({ pageParam, signal }) =>
      apiFetch(
        `/library/whole-films?${librarySearchParams(scope, pageParam).toString()}`,
        zWholeFilmCardsOut,
        { fallbackErrorMessage: '读取整片失败', signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: WholeFilmsPage) => last.nextCursor,
  })

export const useWholeFilmAuthorSource = (): PickerSource =>
  useAuthorSource('/library/whole-films/authors')
