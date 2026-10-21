import { describe, expect, it } from 'vitest'
import { DEFAULT_HIT_CASE_SCOPE, hitCaseSearchParams } from './hit-cases.api'

describe('爆款素材筛选请求', () => {
  it('默认只带分页参数', () => {
    expect(hitCaseSearchParams(DEFAULT_HIT_CASE_SCOPE, null).toString()).toBe('limit=24')
  })

  it('作者、时间与重复标签参数组合，翻页保留相同条件', () => {
    const params = hitCaseSearchParams(
      {
        ...DEFAULT_HIT_CASE_SCOPE,
        range: '7d',
        tags: ['5a900000-0000-4000-8000-000000000001', '5a900000-0000-4000-8000-000000000002'],
        userName: 'Nora.Ho',
      },
      '2026-09-20T10:00:00+00:00|abc',
      new Date('2026-09-23T12:00:00Z'),
    )
    expect(params.get('userName')).toBe('Nora.Ho')
    expect(params.get('since')).toBe('2026-09-16T12:00:00.000Z')
    expect(params.has('until')).toBe(false)
    expect(params.getAll('tags')).toEqual([
      '5a900000-0000-4000-8000-000000000001',
      '5a900000-0000-4000-8000-000000000002',
    ])
    expect(params.get('cursor')).toBe('2026-09-20T10:00:00+00:00|abc')
  })
})
