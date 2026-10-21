import { describe, expect, it } from 'vitest'
import { DEFAULT_HIT_CASE_SCOPE, DEFAULT_REFERENCE_SCOPE } from '@/features/library'
import {
  hitCaseScopeFromSearch,
  librarySearchSchema,
  referenceScopeFromSearch,
  searchFromHitCaseScope,
  searchFromReferenceScope,
  searchFromTab,
  tabFromSearch,
} from './-library-search'

const TAG_A = '5a900000-0000-4000-8000-000000000001'
const TAG_B = '5a900000-0000-4000-8000-000000000002'

describe('灵感库的标签筛选与地址', () => {
  it('选中的标签写成 tags[]，读回来是同一份', () => {
    const search = searchFromReferenceScope({ ...DEFAULT_REFERENCE_SCOPE, tags: [TAG_A, TAG_B] })
    expect(search).toMatchObject({ tab: 'references', tags: [TAG_A, TAG_B] })
    expect(referenceScopeFromSearch(librarySearchSchema.parse(search)).tags).toEqual([TAG_A, TAG_B])
  })

  it('没选标签时地址里不带 tags', () => {
    expect(searchFromReferenceScope(DEFAULT_REFERENCE_SCOPE).tags).toBeUndefined()
  })

  it.each([
    ['不是 id 的', { tags: ['拖鞋'] }],
    ['空数组', { tags: [] }],
  ])('%s tags 丢掉，当没选', (_name, raw) => {
    expect(
      referenceScopeFromSearch(librarySearchSchema.parse({ tab: 'references', ...raw })).tags,
    ).toEqual([])
  })
})

const CARD = '7a1e0000-0000-4000-8000-000000000003'
const VERSION = '7a1c0000-0000-4000-8000-000000000301'

describe('爆款素材库的页签、标签筛选与按版本打开', () => {
  it('页签是 hit-cases，切过去时地址里只留页签', () => {
    expect(searchFromTab('hit-cases')).toEqual({ tab: 'hit-cases' })
    expect(tabFromSearch(librarySearchSchema.parse({ tab: 'hit-cases' }))).toBe('hit-cases')
  })

  it('选中的标签写成 tags[] 并留在爆款素材库页签，读回来是同一份；没选时不带', () => {
    const search = searchFromHitCaseScope({ ...DEFAULT_HIT_CASE_SCOPE, tags: [TAG_A, TAG_B] })
    expect(search).toEqual({ tab: 'hit-cases', tags: [TAG_A, TAG_B] })
    expect(hitCaseScopeFromSearch(librarySearchSchema.parse(search))).toEqual({
      ...DEFAULT_HIT_CASE_SCOPE,
      tags: [TAG_A, TAG_B],
    })
    expect(searchFromHitCaseScope(DEFAULT_HIT_CASE_SCOPE)).toEqual({ tab: 'hit-cases' })
  })

  it('人员、自定义时间和标签一起保存在地址中，重新打开可完整还原', () => {
    const scope = {
      ...DEFAULT_HIT_CASE_SCOPE,
      range: 'custom' as const,
      since: '2026-09-01',
      tags: [TAG_A],
      until: '2026-09-23',
      userName: 'Nora.Ho',
    }
    const search = searchFromHitCaseScope(scope)
    expect(search).toMatchObject({
      range: 'custom',
      since: '2026-09-01',
      tab: 'hit-cases',
      tags: [TAG_A],
      until: '2026-09-23',
      userName: 'Nora.Ho',
    })
    expect(hitCaseScopeFromSearch(librarySearchSchema.parse(search))).toEqual(scope)
  })

  it('version 与 video 一起读出来；不是 id 的 version 丢掉', () => {
    expect(librarySearchSchema.parse({ version: VERSION, video: CARD })).toMatchObject({
      version: VERSION,
      video: CARD,
    })
    expect(librarySearchSchema.parse({ version: '第二版', video: CARD }).version).toBeUndefined()
  })
})
