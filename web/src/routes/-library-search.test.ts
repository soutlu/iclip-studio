import { describe, expect, it } from 'vitest'
import { DEFAULT_REFERENCE_SCOPE } from '@/features/library'
import {
  librarySearchSchema,
  referenceScopeFromSearch,
  searchFromReferenceScope,
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
