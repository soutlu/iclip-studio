import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import {
  createReference,
  DEFAULT_REFERENCE_SCOPE,
  nearestTestAspectRatio,
  referenceSearchParams,
  useReference,
  type TestVideo,
} from './references.api'

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

describe('nearestTestAspectRatio', () => {
  it.each([
    [720 / 1280, '9:16'],
    [1080 / 1920, '9:16'],
    [0.6, '9:16'],
    [0.7, '3:4'],
    [1, '1:1'],
    [1.4, '4:3'],
    [1920 / 1080, '16:9'],
    [2.39, '16:9'],
  ] as const)('宽高比 %f 取 %s', (ratio, expected) => {
    expect(nearestTestAspectRatio(ratio)).toBe(expected)
  })
})

describe('useReference', () => {
  const ID = '5ef00000-0000-4000-8000-000000000043'

  it('试生成进行中时轮询，结束后停', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let testVideo: TestVideo = {
        createdAt: '2026-09-23T12:00:00Z',
        errorMessage: null,
        stale: false,
        status: 'running',
        url: null,
      }
      let reads = 0
      server.use(
        http.get('*/api/references/:id', () => {
          reads += 1
          return HttpResponse.json({
            breakdownStatus: 'completed',
            canEdit: true,
            categories: [],
            createdAt: '2026-09-23T11:00:00Z',
            document: '# 拆解',
            errorCode: null,
            id: ID,
            testVideo,
            updatedAt: '2026-09-23T11:00:00Z',
            userName: 'tester',
            version: 1,
            videoTypes: [],
            videoUrl: 'https://assets.example.com/a.mp4',
          })
        }),
      )
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const { result } = renderHook(() => useReference(ID), {
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(QueryClientProvider, { client: queryClient }, children),
      })
      await waitFor(() => expect(result.current.data?.testVideo?.status).toBe('running'))
      expect(reads).toBe(1)

      await vi.advanceTimersByTimeAsync(5000)
      await waitFor(() => expect(reads).toBe(2))

      testVideo = { ...testVideo, status: 'completed', url: 'https://assets.example.com/t.mp4' }
      await vi.advanceTimersByTimeAsync(5000)
      await waitFor(() => expect(result.current.data?.testVideo?.status).toBe('completed'))
      const settled = reads

      await vi.advanceTimersByTimeAsync(20_000)
      expect(reads).toBe(settled)
    } finally {
      vi.useRealTimers()
    }
  })
})
