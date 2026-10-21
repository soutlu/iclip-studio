import { describe, expect, it } from 'vitest'
import { librarySearchParams } from './library.api'
import { DEFAULT_WHOLE_FILM_SCOPE } from './whole-films.api'

describe('成片列表的查询串', () => {
  it('按作者、时间与标题发送合同筛选，游标保持不透明，不含画幅', () => {
    const query = librarySearchParams(
      { ...DEFAULT_WHOLE_FILM_SCOPE, userName: 'A&B', q: ' 成片 ', range: '7d' },
      'time|id',
      new Date('2026-10-14T12:00:00Z'),
    )
    expect(Object.fromEntries(query)).toEqual({
      limit: '24',
      userName: 'A&B',
      q: '成片',
      since: '2026-10-07T12:00:00.000Z',
      cursor: 'time|id',
    })
  })
})
