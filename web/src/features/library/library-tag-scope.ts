import { useEffect, useMemo } from 'react'
import { UNBOUNDED_RANGE, type DateRange } from '@/shared/lib/date-range'
import { knownTagIds, type TagIndex } from './library-tags'

/** 两个标签资料库共用的筛选：人员、时间，以及按维度组合的标签。 */
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

/** 标签树读到后清理失效条件，并通过页面已有的 replace 导航同步到地址；其余筛选保持原值。 */
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
