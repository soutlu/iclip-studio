import { describe, expect, it } from 'vitest'
import { DEFAULT_WHOLE_FILM_SCOPE, wholeFilmSearchParams } from './whole-films.api'

describe('wholeFilmSearchParams', () => {
  it('按作者、时间与标题发送合同筛选，游标保持不透明，不含画幅', () => {
    const query = wholeFilmSearchParams(
      { ...DEFAULT_WHOLE_FILM_SCOPE, userName: 'A&B', q: ' 整片 ', range: '7d' },
      'time|id',
      new Date('2026-10-14T12:00:00Z'),
    )
    expect(Object.fromEntries(query)).toEqual({
      limit: '24',
      userName: 'A&B',
      q: '整片',
      since: '2026-10-07T12:00:00.000Z',
      cursor: 'time|id',
    })
  })
})
