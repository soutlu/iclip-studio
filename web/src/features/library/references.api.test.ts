import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import {
  createReference,
  nearestTestAspectRatio,
  useReference,
  type ReferenceDetail,
  type TagStatus,
  type TestVideo,
} from './references.api'

const ID = '5ef00000-0000-4000-8000-000000000043'

const detailOf = (overrides: Partial<ReferenceDetail> = {}): ReferenceDetail => ({
  breakdownStatus: 'completed',
  canEdit: true,
  createdAt: '2026-09-23T11:00:00Z',
  document: '# 拆解',
  errorCode: null,
  id: ID,
  tagError: null,
  tagIds: [],
  tagStatus: 'completed',
  testVideo: null,
  updatedAt: '2026-09-23T11:00:00Z',
  userName: 'tester',
  version: 1,
  videoUrl: 'https://assets.example.com/a.mp4',
  ...overrides,
})

describe('createReference', () => {
  const reference = detailOf({ breakdownStatus: 'pending', document: null, tagStatus: null })

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
  /** 挂上详情查询，答复由 `current()` 现给，交回读了几次与查询结果。 */
  const watch = (current: () => ReferenceDetail) => {
    const counter = { reads: 0 }
    server.use(
      http.get('*/api/references/:id', () => {
        counter.reads += 1
        return HttpResponse.json(current())
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useReference(ID), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    })
    return { counter, result }
  }

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
      const { counter, result } = watch(() => detailOf({ testVideo }))
      await waitFor(() => expect(result.current.data?.testVideo?.status).toBe('running'))
      expect(counter.reads).toBe(1)

      await vi.advanceTimersByTimeAsync(5000)
      await waitFor(() => expect(counter.reads).toBe(2))

      testVideo = { ...testVideo, status: 'completed', url: 'https://assets.example.com/t.mp4' }
      await vi.advanceTimersByTimeAsync(5000)
      await waitFor(() => expect(result.current.data?.testVideo?.status).toBe('completed'))
      const settled = counter.reads

      await vi.advanceTimersByTimeAsync(20_000)
      expect(counter.reads).toBe(settled)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['completed', 'failed'] as const)(
    '打标排队或打标中时轮询，到 %s 就停',
    async (terminal) => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        let tagStatus: TagStatus = 'pending'
        const { counter, result } = watch(() => detailOf({ tagStatus }))
        await waitFor(() => expect(result.current.data?.tagStatus).toBe('pending'))

        tagStatus = 'running'
        await vi.advanceTimersByTimeAsync(5000)
        await waitFor(() => expect(result.current.data?.tagStatus).toBe('running'))

        tagStatus = terminal
        await vi.advanceTimersByTimeAsync(5000)
        await waitFor(() => expect(result.current.data?.tagStatus).toBe(terminal))
        const settled = counter.reads

        await vi.advanceTimersByTimeAsync(20_000)
        expect(counter.reads).toBe(settled)
      } finally {
        vi.useRealTimers()
      }
    },
  )
})
