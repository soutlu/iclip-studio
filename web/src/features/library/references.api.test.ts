import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/testing/mocks/server'
import { createReference, DEFAULT_REFERENCE_SCOPE, referenceSearchParams } from './references.api'

const NOW = new Date('2026-09-23T12:00:00Z')

describe('referenceSearchParams', () => {
  it('默认范围只带页大小', () => {
    expect(referenceSearchParams(DEFAULT_REFERENCE_SCOPE, null, NOW).toString()).toBe('limit=24')
  })

  it('两组标签是重复的同名参数，关键词去掉首尾空白，游标原样带上', () => {
    const params = referenceSearchParams(
      {
        categories: ['拖鞋', '卫衣'],
        q: '  滑板 ',
        range: '7d',
        since: null,
        until: null,
        userName: 'Maya.Cheng',
        videoTypes: ['try_on', 'lifestyle'],
      },
      '2026-09-20T10:00:00+00:00|abc',
      NOW,
    )

    expect(params.getAll('videoTypes')).toEqual(['try_on', 'lifestyle'])
    expect(params.getAll('categories')).toEqual(['拖鞋', '卫衣'])
    expect(params.get('q')).toBe('滑板')
    expect(params.get('userName')).toBe('Maya.Cheng')
    expect(params.get('since')).toBe('2026-09-16T12:00:00.000Z')
    expect(params.get('cursor')).toBe('2026-09-20T10:00:00+00:00|abc')
  })
})

describe('createReference', () => {
  const reference = {
    breakdownStatus: 'pending',
    canEdit: true,
    categories: [],
    createdAt: '2026-09-23T12:00:00Z',
    document: null,
    errorCode: null,
    id: '5ef00000-0000-4000-8000-000000000042',
    testVideo: null,
    updatedAt: '2026-09-23T12:00:00Z',
    userName: 'tester',
    version: 1,
    videoTypes: [],
    videoUrl: 'https://assets.example.com/a.mp4',
  }

  it.each([
    [201, true],
    [200, false],
  ])('按上传 id 建行；%i 表示 created=%s', async (status, created) => {
    let body: unknown
    server.use(
      http.post('*/api/references', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json(reference, { status })
      }),
    )

    await expect(createReference('f40a7a4b-90ec-438b-8bf0-9bde53a290fc')).resolves.toEqual({
      created,
      reference,
    })
    expect(body).toEqual({ uploadId: 'f40a7a4b-90ec-438b-8bf0-9bde53a290fc' })
  })
})
