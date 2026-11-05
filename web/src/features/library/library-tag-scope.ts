import { useEffect, useMemo } from 'react'
import { UNBOUNDED_RANGE, type DateRange } from '@/shared/lib/date-range'
import { knownTagIds, type TagIndex } from './library-tags'

export interface LibraryTagScope extends DateRange {
  userName: string | null
  tags: readonly string[]
}

export const DEFAULT_LIBRARY_TAG_SCOPE: LibraryTagScope = {
  ...UNBOUNDED_RANGE,
  tags: [],
  userName: null,
}

export const isDefaultLibraryTagScope = (scope: LibraryTagScope): boolean =>
  scope.userName === null && scope.range === 'all' && scope.tags.length === 0

export function useLibraryTagScope<S extends LibraryTagScope>(
  requested: S,
  index: TagIndex | undefined,
  onChange: (next: S) => void,
): S {
  const scope = useMemo(() => {
    if (index === undefined) return requested
    const tags = knownTagIds(index, requested.tags)
    return tags.length === requested.tags.length &&
      tags.every((id, position) => id === requested.tags[position])
      ? requested
      : { ...requested, tags }
  }, [index, requested])

  useEffect(() => {
    if (scope !== requested) onChange(scope)
  }, [onChange, requested, scope])

  return scope
}
