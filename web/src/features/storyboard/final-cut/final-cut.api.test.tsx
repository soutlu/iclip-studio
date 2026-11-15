import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { PREVIEW_TOKEN_REFRESH_MS, useFinalCutPreviewTokens } from './final-cut.api'

const CONVERSATION = '6b0f3a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'

afterEach(() => {
  vi.useRealTimers()
})

describe('预览令牌', () => {
  it('每 50 分钟取一张新的：预览页地址用的那张不变，取工程文件用最新的那张', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let issued = 0
    server.use(
      http.post('*/api/conversations/:conversationId/final-cut/preview', () => {
        issued += 1
        return HttpResponse.json({
          origin: 'http://preview.test',
          token: `token-${issued}`,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
      }),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useFinalCutPreviewTokens(CONVERSATION), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })
    await waitFor(() => expect(result.current.page?.token).toBe('token-1'))
    expect(result.current.latest?.token).toBe('token-1')
    expect(PREVIEW_TOKEN_REFRESH_MS).toBe(50 * 60_000)

    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_TOKEN_REFRESH_MS - 1_000))
    expect(issued).toBe(1)
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    await waitFor(() => expect(result.current.latest?.token).toBe('token-2'))
    expect(result.current.page?.token).toBe('token-1')

    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_TOKEN_REFRESH_MS))
    await waitFor(() => expect(result.current.latest?.token).toBe('token-3'))
    expect(result.current.page?.token).toBe('token-1')
  })
})
