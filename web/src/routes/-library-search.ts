/** 资料库的查询串：选中的页签、这个页签的筛选范围与打开着的那条详情。等于默认值的条件不落地址栏，非法取值退回默认。
 *
 * 两个页签各用各的筛选，换页签时筛选清空；人、时间与关键词两边同名。 */

import { z } from 'zod'
import {
  DEFAULT_LIBRARY_SCOPE,
  DEFAULT_REFERENCE_SCOPE,
  type LibraryScope,
  type ReferenceScope,
  zCategory,
  zVideoType,
} from '@/features/library'
import {
  dateRangeFromSearch,
  dateRangeSearchFields,
  dateRangeToSearch,
} from '@/shared/lib/date-range'

export const librarySearchSchema = z.object({
  ...dateRangeSearchFields,
  /** 「参考视频」页签；成片是默认页签，不写进地址。 */
  tab: z.enum(['references']).optional().catch(undefined),
  orientation: z.enum(['portrait', 'landscape']).optional().catch(undefined),
  q: z.string().max(100).optional().catch(undefined),
  userName: z.string().min(1).optional().catch(undefined),
  /** 参考视频的两组标签筛选；混进非法取值时整组作废。 */
  videoTypes: z.array(zVideoType).min(1).optional().catch(undefined),
  categories: z.array(zCategory).min(1).optional().catch(undefined),
  /** 打开着详情的那张成片卡；分享出去的链接也靠它直达。 */
  video: z.uuid().optional().catch(undefined),
  /** 打开着详情的那条参考视频。 */
  reference: z.uuid().optional().catch(undefined),
})

export type LibrarySearch = z.output<typeof librarySearchSchema>

export function scopeFromSearch(search: LibrarySearch): LibraryScope {
  return {
    ...dateRangeFromSearch(search, DEFAULT_LIBRARY_SCOPE),
    orientation: search.orientation ?? null,
    q: search.q ?? '',
    userName: search.userName ?? null,
  }
}

/** 只写筛选范围；改筛选时详情随之关掉。 */
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

/** 参考视频页签的筛选范围连同页签本身；改筛选时详情随之关掉。 */
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
