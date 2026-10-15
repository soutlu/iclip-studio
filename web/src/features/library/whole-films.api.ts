/** 整片资料库：每段对话一张卡，列表直接带全部版本，不另读详情。 */
import { useInfiniteQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zWholeFilmCardsOut } from '@/shared/api/generated/zod.gen'
import { DEFAULT_LIBRARY_SCOPE, librarySearchParams, type LibraryScope } from './library.api'

export type WholeFilmScope = Omit<LibraryScope, 'orientation'>
export type WholeFilmsPage = z.output<typeof zWholeFilmCardsOut>
export type WholeFilmCard = WholeFilmsPage['items'][number]
export const DEFAULT_WHOLE_FILM_SCOPE: WholeFilmScope = {
  q: '',
  userName: null,
  range: DEFAULT_LIBRARY_SCOPE.range,
  since: null,
  until: null,
}

export const wholeFilmSearchParams = (scope: WholeFilmScope, cursor: string | null, now?: Date) =>
  librarySearchParams({ ...scope, orientation: null }, cursor, now)

export const useLibraryWholeFilms = (scope: WholeFilmScope) =>
  useInfiniteQuery({
    gcTime: 30 * 60_000,
    // 从编辑器回来时重读最新合成的版本，已展开的分页仍保留。
    staleTime: 0,
    queryKey: ['library', 'whole-films', scope],
    queryFn: ({ pageParam, signal }) =>
      apiFetch(
        `/library/whole-films?${wholeFilmSearchParams(scope, pageParam).toString()}`,
        zWholeFilmCardsOut,
        {
          signal,
          fallbackErrorMessage: '读取整片资料库失败',
        },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: WholeFilmsPage) => last.nextCursor,
  })
